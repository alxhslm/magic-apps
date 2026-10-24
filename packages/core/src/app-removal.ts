import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './logger.js';

/**
 * Everything an install wrote, and the shell that removes it once the app has quit.
 *
 * macOS runs no code when an app is deleted and never clears an app's `~/Library`
 * files, so a user who drags the bundle to the Bin leaves Google sessions, caches,
 * login items and notification registrations behind. The only moment this cleanup can
 * run is from inside the app, before it is gone -- so the app records what to remove
 * and hands the deletion to a detached shell that outlives it.
 *
 * The shell waits on this process rather than deleting immediately: Chromium flushes
 * `Local State` and its singleton files *during* shutdown, so an in-process delete
 * races the browser that is still writing to the userData directory. See
 * `docs/shared/sessions-and-security.md`.
 *
 * Nothing here touches the filesystem except `scheduleRemoval`, which sends the job
 * away; the target list and the script are pure, so both are unit-testable.
 */

const log = createLogger('Removal');

export interface AppRemovalInput {
  /** 'Magimail' | 'Magical' */
  appName: string;
  /** 'com.alexhaslam.magimail' | 'com.alexhaslam.magical' */
  bundleId: string;
  /** `os.homedir()`. */
  home: string;
  /** `app.getPath('userData')`. */
  userDataPath: string;
  /** `app.getPath('logs')`. */
  logsPath: string;
  /** The resolved App Group container, or null when the app has none. */
  groupContainerPath: string | null;
}

export interface AppRemovalTargets {
  /** Absolute, de-duplicated, in the order the shell should remove them. */
  paths: string[];
  /**
   * `${home}/Library/Containers/${bundleId}.*`. The shell empties each container;
   * `containermanagerd` keeps the directory and its metadata file, so only the
   * contents go and no user data is left behind.
   */
  containerGlob: string;
  /** The `defaults` domain holding the app's preferences. */
  preferencesDomain: string;
  /**
   * Keychain services a removal leaves in place. A service named here survives the
   * removal.
   */
  keychainServicesToPreserve: string[];
}

/** Pure. Never touches the filesystem. */
export function removalTargets(input: AppRemovalInput): AppRemovalTargets {
  const { home, bundleId } = input;
  const library = path.join(home, 'Library');

  return {
    paths: dedupe([
      input.userDataPath,
      input.logsPath,
      input.groupContainerPath,
      path.join(library, 'Preferences', `${bundleId}.plist`),
      path.join(library, 'Caches', bundleId),
      path.join(library, 'WebKit', bundleId),
      path.join(library, 'HTTPStorages', bundleId),
      path.join(library, 'Saved Application State', `${bundleId}.savedState`),
    ]),
    containerGlob: path.join(library, 'Containers', `${bundleId}.*`),
    preferencesDomain: bundleId,
    keychainServicesToPreserve: [],
  };
}

/** Drops the absent entries and the repeats, keeping the first position of each. */
function dedupe(candidates: (string | null)[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (candidate === null || seen.has(candidate)) continue;
    seen.add(candidate);
    paths.push(candidate);
  }
  return paths;
}

/**
 * Pure. The `/bin/sh -c` body that waits for `pid`, removes `paths`, and clears the
 * preferences domain.
 *
 * The three values travel *beside* the script and never inside it -- the pid as `$1`,
 * the paths as `$2…` after a `shift`, the domain as `REMOVAL_PREFS_DOMAIN` -- so the
 * script text is a constant and a path containing a space, a quote or `$(…)` cannot
 * change what the shell runs. The parameters are named here because a call site
 * reading `deferredRemovalShell(process.pid, paths, domain)` should see the same
 * three values that go into the argv.
 *
 * `defaults delete` follows the `rm` because `cfprefsd` caches the domain: removing
 * the plist alone lets the daemon write it back. Its failure is ignored, as the file
 * is already gone by then.
 */
export function deferredRemovalShell(
  pid: number,
  paths: string[],
  preferencesDomain: string,
): string {
  // Deliberately unread: `scheduleRemoval` sends these same three values as argv and
  // in the environment, and the script below is a constant.
  void pid;
  void paths;
  void preferencesDomain;

  return [
    '# $1 is the app pid and $2.. are the paths to remove.',
    '# Waiting is bounded: a quit that is prevented must not leave the removal asleep',
    '# forever behind a UI that already told the user the data was going.',
    'i=0',
    'while kill -0 "$1" 2>/dev/null && [ "$i" -lt 300 ]; do',
    '  sleep 0.2',
    '  i=$((i + 1))',
    'done',
    'shift',
    'for p in "$@"; do',
    '  rm -rf -- "$p"',
    'done',
    'if [ -n "${REMOVAL_PREFS_DOMAIN:-}" ]; then',
    '  /usr/bin/defaults delete "$REMOVAL_PREFS_DOMAIN" >/dev/null 2>&1 || true',
    'fi',
  ].join('\n');
}

/**
 * Expands `containerGlob`, then spawns the detached shell and unrefs it.
 *
 * `detached` plus `unref` is the point: the app quits straight after this returns, and
 * the removal has to survive it. A missing `Containers` directory is not an error --
 * an app whose extensions were never launched has none.
 */
export function scheduleRemoval(input: AppRemovalInput): void {
  const targets = removalTargets(input);
  const paths = [...targets.paths, ...expandContainerGlob(targets.containerGlob)];

  const child = spawn(
    '/bin/sh',
    [
      '-c',
      deferredRemovalShell(process.pid, paths, targets.preferencesDomain),
      'sh',
      String(process.pid),
      ...paths,
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, REMOVAL_PREFS_DOMAIN: targets.preferencesDomain },
    },
  );
  child.unref();

  log.info(
    `Scheduled removal of ${paths.length} path(s) and the ${targets.preferencesDomain} ` +
      `preferences domain once pid ${process.pid} exits`,
  );
}

/** The container directories matching `containerGlob` that exist right now. */
function expandContainerGlob(containerGlob: string): string[] {
  const directory = path.dirname(containerGlob);
  const prefix = path.basename(containerGlob).replace(/\*$/, '');

  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => path.join(directory, entry))
    .sort();
}
