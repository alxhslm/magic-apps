import * as path from 'node:path';

export interface UserDataResolutionOptions {
  appName: string;
  appDataPath: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

/** The profile a `--demo` run uses, matching `--profile=demo`. */
export const DEMO_PROFILE = 'demo';

/**
 * Whether this run is a demo, so the app keeps clear of the real install's state.
 *
 * A demo is for screenshots and for demonstrating the app: the accounts are invented and
 * a Focus filter of its own applies. On its own that needs no flag, because a demo is just
 * another userData profile. It is a flag because some of an app's state lives outside
 * userData — the App Group container both apps are entitled for — and a demo must not
 * read the real accounts from there or write its invented diary back. Callers consult
 * this before they reach for the group.
 *
 * `--profile=demo` is the spelling the screenshot skill has always used and still counts;
 * `--demo` is the explicit one.
 */
export function isDemoMode(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.MAGIC_SUITE_DEMO === '1') return true;
  if (argv.includes('--demo')) return true;
  return argv.includes(`--profile=${DEMO_PROFILE}`);
}

/**
 * Resolves the userData directory for an app, supporting custom profiles
 * and explicit data directories across dev, test, and production runs.
 *
 * Precedence:
 * 1. `<APPNAME>_USER_DATA_DIR` or `MAGIC_SUITE_USER_DATA_DIR` environment variable
 * 2. `--user-data-dir=<path>` CLI flag
 * 3. `--profile=<name>` CLI flag (resolves to `<appDataPath>/<appName>-<profile>`)
 * 4. `--demo` CLI flag (resolves to the `demo` profile)
 * 5. Default stable path (`<appDataPath>/<appName>`)
 */
export function resolveUserDataPath(options: UserDataResolutionOptions): string {
  const { appName, appDataPath, argv = process.argv, env = process.env } = options;

  const envKey = `${appName.toUpperCase()}_USER_DATA_DIR`;
  const envVal = env[envKey]?.trim() || env.MAGIC_SUITE_USER_DATA_DIR?.trim();
  if (envVal) {
    return path.resolve(envVal);
  }

  const userDirArg = argv.find((a) => a.startsWith('--user-data-dir='));
  if (userDirArg) {
    const custom = userDirArg.slice('--user-data-dir='.length).trim();
    if (custom) {
      return path.resolve(custom);
    }
  }

  const profileArg = argv.find((a) => a.startsWith('--profile='));
  if (profileArg) {
    const profile = profileArg.slice('--profile='.length).trim();
    if (profile) {
      return path.join(appDataPath, `${appName}-${profile}`);
    }
  }

  if (argv.includes('--demo')) {
    return path.join(appDataPath, `${appName}-${DEMO_PROFILE}`);
  }

  return path.join(appDataPath, appName);
}
