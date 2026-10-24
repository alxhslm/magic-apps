import { app } from 'electron';
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
}
