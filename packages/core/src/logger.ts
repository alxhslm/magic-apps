import * as fs from 'node:fs';
import * as path from 'node:path';
import { nativeTheme, screen } from 'electron';
import log from 'electron-log/main';
import { redactValue } from './redact.js';
import { archiveNameFor, sweepArchives } from './log-rotation.js';
import { systemVersion } from './diagnostics.js';

// Re-exported so a call site needs one import to log, to redact what it logs,
// and to catch what would otherwise never be logged at all.
export { redactUrl, redactText, redactValue } from './redact.js';
export { installCrashHandlers } from './crash-handlers.js';

/**
 * Structured file logging for the Main process.
 *
 * Writes to `~/Library/Logs/<AppName>/main.log`, which is electron-log's own
 * macOS default -- so the path needs no configuration here. Deliberately not
 * under Application Support: **Reset Session…** in Settings → Accounts is the
 * first thing a confused tester is told to try, and a diagnostic log that the
 * standard troubleshooting step deletes is worse than none. `~/Library/Logs` is
 * also where Console.app looks, and it keeps 10MB of rolling logs out of Time
 * Machine.
 *
 * See `docs/shared/logging.md`.
 */

/** Rotate at 10MB. Retention is a week, and lives in `log-rotation.ts`. */
const MAX_SIZE_BYTES = 10 * 1024 * 1024;

let initialised = false;

export interface LoggerOptions {
  /** Minimum level written to file. Defaults to `info`, or `silly` when packaged is false. */
  level?: 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly';
  /** False in development, where the console transport is the useful one. */
  isPackaged?: boolean;
}

/**
 * Configures transports and starts catching unhandled errors.
 *
 * Call once, as early in Main as possible -- anything logged before this still
 * reaches the file, but an unhandled error thrown before it does not.
 */
export function initLogging(options: LoggerOptions = {}): void {
  if (initialised) return;
  initialised = true;

  const { isPackaged = true, level = isPackaged ? 'info' : 'silly' } = options;

  log.transports.file.level = level;
  log.transports.file.maxSize = MAX_SIZE_BYTES;
  log.transports.file.archiveLogFn = archiveAndSweep;

  // Prepended, so it sees the raw arguments rather than a formatted line.
  log.transports.file.transforms.unshift(({ data }) => data.map((d) => redactValue(d)));

  // The console transport is a dev convenience: in a packaged app launched from
  // Finder there is no terminal for it to reach.
  log.transports.console.level = isPackaged ? 'warn' : 'silly';

  log.errorHandler.startCatching({
    // The log entry is the point. A modal on top of it tells the user nothing
    // they can act on and loses the window they were working in.
    showDialog: false,
  });

  sweepArchives(logDirectory());
}

/**
 * Opens the log with what every bug report needs and no reporter thinks to say.
 *
 * Versions first, because "works on my machine" is usually a macOS or Electron
 * difference, and the reporter cannot be expected to know which.
 */
export function logStartupBanner(appName: string, appVersion: string): void {
  const scoped = log.scope('Startup');
  scoped.info(
    `${appName} ${appVersion} — electron ${process.versions.electron}, ` +
      `chrome ${process.versions.chrome}, node ${process.versions.node}, ` +
      `${process.platform} ${systemVersion()} (${process.arch})`,
  );
}

/**
 * Records the appearance and the displays, which the banner cannot.
 *
 * Call on `whenReady`: `screen` throws before the app is ready, and the banner
 * has to come first so that a startup failure has the versions above it.
 *
 * Appearance and scale decide what the vibrancy and toolbar defects look like,
 * and a reporter describing one of those never thinks to say which mode they
 * were in or whether the screen was Retina.
 */
export function logDisplayEnvironment(): void {
  const scoped = log.scope('Startup');
  const displays = screen.getAllDisplays();
  const { size, scaleFactor } = screen.getPrimaryDisplay();
  // The source and the resolved appearance are different facts: a user who set
  // dark explicitly and one whose Mac turned dark at sunset both read as dark.
  const appearance = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  scoped.info(
    `${appearance} appearance (theme ${nativeTheme.themeSource})` +
      (nativeTheme.shouldUseHighContrastColors ? ', high contrast' : '') +
      `, ${displays.length} display(s), primary ${size.width}x${size.height} @${scaleFactor}x`,
  );
}

/** A logger tagged with a subsystem, rendered as `(Share)` in the line. */
export function createLogger(scope: string) {
  return log.scope(scope);
}

/** Directory holding `main.log` and its archives. */
export function logDirectory(): string {
  return path.dirname(log.transports.file.getFile().path);
}

/** Absolute path of the live log file. */
export function logFilePath(): string {
  return log.transports.file.getFile().path;
}

/**
 * Renames a full log to `main.<date>.log` and drops archives past retention.
 *
 * Runs synchronously inside a write, so it must not throw: a rotation failure
 * that propagates would take logging down with it, which is the one thing worse
 * than an oversized log.
 */
function archiveAndSweep(file: { path: string }): void {
  try {
    const info = path.parse(file.path);
    fs.renameSync(file.path, archiveNameFor(info.dir, info.ext, new Date()));
    sweepArchives(info.dir);
  } catch {
    // Leave the file for the transport to reset. Losing the archive is
    // survivable; throwing from here is not.
  }
}
