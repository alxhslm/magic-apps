import { app, BaseWindow, clipboard, dialog, shell } from 'electron';
import {
  collectDiagnosticBundle,
  buildDiagnosticsDialogOptions,
  buildSupportEmailUrl,
  buildGitHubIssueUrl,
  type DiagnosticBundleResult,
} from '@magimail/core';
import { logDirectory, createLogger } from '@magimail/core/logger';
import { syncExtensionLogs } from './extension-logs.js';
import { isHelperRunning, getHelperPid } from './swift-helper.js';
import { isTrayCreated } from './menubar-manager.js';
import type { AccountsManager } from './accounts-manager.js';
import type { AtomFeedPoller } from './atom-poller.js';
import { uiString } from './strings.js';

const log = createLogger('Diagnostics');

/**
 * Collects Magimail diagnostics including application logs, extension logs,
 * system environment info, and non-sensitive state metrics.
 */
export async function collectMagimailDiagnostics(
  accountsManager?: AccountsManager | null,
  pollers?: Map<string, AtomFeedPoller>,
): Promise<DiagnosticBundleResult> {
  const dir = logDirectory();
  syncExtensionLogs(dir);

  const accounts = accountsManager?.getAccounts() ?? [];
  const activeAccount = accountsManager?.getActiveAccount();
  const activeIndex = activeAccount ? accounts.findIndex((a) => a.id === activeAccount.id) : null;

  return collectDiagnosticBundle({
    appName: 'Magimail',
    appVersion: app.getVersion(),
    logsDir: dir,
    state: {
      accountCount: accounts.length,
      activeAccountIndex: activeIndex !== -1 ? activeIndex : null,
      helper: {
        running: isHelperRunning(),
        pid: getHelperPid(),
      },
      trayCreated: isTrayCreated(),
      pollersCount: pollers?.size ?? 0,
    },
  });
}

/**
 * Presents an interactive dialog sheet letting the user inspect the diagnostic summary
 * and choose to Reveal in Finder, Email to Support, or Report on GitHub.
 */
export async function presentDiagnosticsDialog(
  parentWindow: BaseWindow | null | undefined,
  result: DiagnosticBundleResult,
): Promise<void> {
  const options = buildDiagnosticsDialogOptions(result, uiString);
  const targetWindow = parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined;

  const { response } = targetWindow
    ? await dialog.showMessageBox(targetWindow, options)
    : await dialog.showMessageBox(options);

  switch (response) {
    case 0: // Reveal in Finder
      clipboard.writeText(result.summaryText);
      shell.showItemInFolder(result.archivePath);
      break;
    case 1: // Copy System Info
      clipboard.writeText(result.summaryText);
      break;
    case 2: // Report on GitHub...
      clipboard.writeText(result.summaryText);
      shell.showItemInFolder(result.archivePath);
      await shell.openExternal(buildGitHubIssueUrl(result));
      break;
    case 3: // Email to Support...
      clipboard.writeText(result.summaryText);
      shell.showItemInFolder(result.archivePath);
      await shell.openExternal(buildSupportEmailUrl(result));
      break;
    case 4: // Done
    default:
      break;
  }
}

/**
 * Orchestrates collecting diagnostics and presenting the results dialog to the user.
 */
export async function handleCollectDiagnostics(
  parentWindow?: BaseWindow | null,
  accountsManager?: AccountsManager | null,
  pollers?: Map<string, AtomFeedPoller>,
): Promise<void> {
  try {
    const result = await collectMagimailDiagnostics(accountsManager, pollers);
    await presentDiagnosticsDialog(parentWindow, result);
  } catch (error) {
    log.error('Failed to collect diagnostics:', error);
    const window = parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined;
    const msgOptions = {
      type: 'error' as const,
      title: uiString('dialog.diagnosticsError.title'),
      message: uiString('dialog.diagnosticsError.message'),
      detail: error instanceof Error ? error.message : String(error),
    };
    if (window) {
      await dialog.showMessageBox(window, msgOptions);
    } else {
      await dialog.showMessageBox(msgOptions);
    }
  }
}
