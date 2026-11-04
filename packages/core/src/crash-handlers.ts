import { app, screen } from 'electron';
import { createLogger } from './logger.js';

/**
 * Captures the failures a user cannot describe.
 *
 * `electron-log`'s own handler already covers `uncaughtException` and unhandled
 * rejections in Main. What it does not cover is a *child* process dying, and in
 * a suite this shape that is most of them: a renderer holding a mailbox, the
 * GPU process, a utility process. Those exits leave a blank pane and no other
 * trace, which is exactly the report that reads "it stopped working".
 *
 * Deliberately not `console-message`: the hosted web app's own renderer
 * logging is continuous and would bury everything here within a minute.
 */

const log = createLogger('Crash');

/**
 * How long the display has to stay quiet before a metrics burst is over.
 *
 * A display settling fires this hundreds of times, so a burst logs its first event and
 * then its last, with a count.
 */
const DISPLAY_SETTLE_QUIET_MS = 1000;

export interface CrashHandlerOptions {
  /**
   * Names the account a renderer belonged to, given its `webContents` id.
   *
   * Called at crash time rather than read once, because the accounts manager
   * does not exist yet when the handlers are installed.
   */
  describeRenderer?: (webContentsId: number) => string | undefined;
}

export function installCrashHandlers(options: CrashHandlerOptions = {}): void {
  // A renderer going down takes one account's view with it. `reason` separates
  // a crash from an out-of-memory kill, which point at different bugs.
  app.on('render-process-gone', (_event, webContents, details) => {
    const { reason, exitCode } = details;
    // The report is "one of my accounts went blank", so which one is the first
    // thing the log has to answer.
    const account = options.describeRenderer?.(webContents.id);
    const whose = account ? ` account=${account}` : '';
    const message = `Renderer gone:${whose} reason=${reason} exitCode=${exitCode}`;
    // A clean exit during teardown is not a crash.
    if (reason === 'clean-exit') log.info(message);
    else log.error(message);
  });

  // GPU and utility processes. A GPU crash shows up as vibrancy or rendering
  // artefacts the user reports as "it looks wrong", with no obvious cause.
  app.on('child-process-gone', (_event, details) => {
    const { type, reason, exitCode, name, serviceName } = details;
    const label = name || serviceName || type;
    const message = `Child process gone: ${label} reason=${reason} exitCode=${exitCode}`;
    if (reason === 'clean-exit') log.info(message);
    else log.error(message);
  });

  // A window that stops presenting leaves no trace of its own, and a display that
  // came, went or changed resolution is one of the few things that can cause it. The
  // record is what dates the next occurrence against the rest of the log.
  //
  // Deferred, because this runs at module load in both apps and `screen` throws
  // before the app is ready.
  void app.whenReady().then(() => {
    screen.on('display-added', () => log.info('Display added'));
    screen.on('display-removed', () => log.info('Display removed'));

    let burst:
      | { count: number; startedAt: number; lastAt: number; timer?: ReturnType<typeof setTimeout> }
      | undefined;

    const endBurst = () => {
      if (!burst) return;
      const { count, startedAt, lastAt } = burst;
      burst = undefined;
      if (count > 1) {
        log.info(`Display metrics changed ×${count} over ${lastAt - startedAt}ms`);
      }
    };

    screen.on('display-metrics-changed', () => {
      const now = Date.now();
      if (burst) {
        if (burst.timer) clearTimeout(burst.timer);
        burst.count += 1;
        burst.lastAt = now;
      } else {
        log.info('Display metrics changed');
        burst = { count: 1, startedAt: now, lastAt: now };
      }
      burst.timer = setTimeout(endBurst, DISPLAY_SETTLE_QUIET_MS);
      // A pending summary must not hold the app open on quit.
      burst.timer.unref?.();
    });
  });
}
