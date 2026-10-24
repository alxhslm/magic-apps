import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@magimail/core/logger';

const log = createLogger('CssOverride');

/**
 * Development-only hot swap for the CSS Magimail injects into Gmail.
 *
 * The composed stylesheet is applied with `cssOrigin: 'user'`, which is what
 * lets it beat Gmail's author-origin `!important` rules. The cost is that it is
 * unreachable from a debugger: Chromium does not expose user-origin stylesheets
 * over CDP, so an attached client cannot read, edit or override an injected
 * rule, and writing to the page's own `<style>` element has no effect against
 * it. Iterating on a selector otherwise costs a rebuild and a relaunch each
 * time.
 *
 * `--css-override=<path>` replaces the composed stylesheet with the contents of
 * a file and re-injects whenever that file changes, so the loop is a save.
 * `scripts/dump-gmail-css.mjs` writes the real stylesheet out as a starting
 * point. Nothing here runs unless the flag is passed; it is gated on a
 * command-line argument for the same reason `--debug-port` is, and grants no
 * access that a local shell did not already have.
 */

let overridePath: string | null = null;
/** Last good read, so a save caught mid-write does not blank the page. */
let lastCss: string | null = null;
let watcher: fs.FSWatcher | null = null;

/**
 * Reads `--css-override=<path>` from argv. Returns the resolved path, or null
 * when the flag is absent.
 */
export function initCssOverride(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith('--css-override='));
  if (!arg) return null;
  const raw = arg.slice('--css-override='.length);
  if (!raw) {
    log.warn('--css-override given without a path; ignoring');
    return null;
  }
  overridePath = path.resolve(raw);
  if (!fs.existsSync(overridePath)) {
    log.warn(`--css-override path does not exist yet: ${overridePath}`);
  }
  log.info(`CSS override active: ${overridePath}`);
  return overridePath;
}

/**
 * The override stylesheet, or null when the flag is absent. A read failure
 * falls back to the last good contents rather than injecting nothing, so a
 * half-written file never leaves Gmail unstyled.
 */
export function getCssOverride(): string | null {
  if (!overridePath) return null;
  try {
    lastCss = fs.readFileSync(overridePath, 'utf8');
  } catch (err) {
    log.warn(`Could not read override, keeping previous CSS: ${String(err)}`);
  }
  return lastCss;
}

/**
 * Calls `onChange` when the override file is written.
 *
 * The containing directory is watched rather than the file: editors save by
 * writing a temporary file and renaming it over the target, which replaces the
 * inode and leaves a watch on the path itself firing once and then going deaf.
 * Writes are debounced because a single save usually surfaces as several
 * events.
 */
export function watchCssOverride(onChange: () => void): void {
  if (!overridePath || watcher) return;
  const dir = path.dirname(overridePath);
  const base = path.basename(overridePath);
  let timer: NodeJS.Timeout | null = null;
  try {
    watcher = fs.watch(dir, (_event, filename) => {
      if (filename !== base) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        log.info('Override changed, re-injecting');
        onChange();
      }, 120);
    });
  } catch (err) {
    log.warn(`Could not watch override directory: ${String(err)}`);
  }
}

/** Releases the watcher. Exported for tests and shutdown. */
export function stopCssOverride(): void {
  watcher?.close();
  watcher = null;
  overridePath = null;
  lastCss = null;
}
