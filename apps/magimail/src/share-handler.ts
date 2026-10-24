import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, BaseWindow, BrowserWindow } from 'electron';
import { type AccountsManager } from './accounts-manager.js';
import { pickAccount } from './mailto-handler.js';
import { nativeDropFiles } from './native-toolbar.js';
import { waitForComposeElements } from './compose-fields.js';
import { uiString } from './strings.js';
import {
  copyIntoShareTempDir,
  createShareTempDir,
  removeShareTempDir,
  removeStagedShareFiles,
} from './share-staging.js';
import { DOM_DRIVE_PREAMBLE } from '@magimail/core';
import { domAction } from './dom-labels.js';
import { createLogger, redactText, redactUrl } from '@magimail/core/logger';

const log = createLogger('Share');

/**
 * Handles a magimail://share URL by triggering Gmail's native compose pop-out
 * and injecting shared files/text/URLs.
 *
 * URL format: magimail://share?files=/path/one&files=/path/two&text=...&url=...
 */
export async function handleShareUrl({
  url,
  accountsManager,
  mainWindow,
}: {
  url: string;
  accountsManager: AccountsManager;
  mainWindow?: BaseWindow | null;
}): Promise<void> {
  log.info('Handling share URL:', redactUrl(url));

  const filePaths = new URL(url).searchParams.getAll('files');
  try {
    await composeShare(url, filePaths, accountsManager, mainWindow);
  } finally {
    // Whatever happened, the extension's own copy has served its purpose: either it has
    // been copied into temp for the drop, or the share is over. Leaving it behind would
    // keep a readable attachment in the App Group container for good.
    removeStagedShareFiles(filePaths);
  }
}

async function composeShare(
  url: string,
  filePaths: string[],
  accountsManager: AccountsManager,
  mainWindow?: BaseWindow | null,
): Promise<void> {
  const picked = await pickAccount(
    accountsManager,
    mainWindow,
    uiString('dialog.composeAccount.shareDetail'),
  );
  if (!picked) return;

  const parsed = new URL(url);
  const sharedText = parsed.searchParams.get('text') || '';
  const sharedUrl = parsed.searchParams.get('url') || '';
  const subject = parsed.searchParams.get('subject') || parsed.searchParams.get('su') || '';
  const to = parsed.searchParams.get('to') || '';

  // Validate file paths
  const validPaths = filePaths.filter((p) => {
    if (!fs.existsSync(p)) {
      log.warn('Shared file not found:', redactText(p));
      return false;
    }
    log.info(`Shared file: ${path.extname(p) || 'no extension'}, ${fs.statSync(p).size} bytes`);
    return true;
  });

  // Build body content
  const body = [sharedText, sharedUrl].filter(Boolean).join('\n\n');

  log.info('Triggering compose pop-out');
  const composeWin = await accountsManager.triggerComposePopout({
    to: to || undefined,
    subject: subject || undefined,
    body: body || undefined,
  });
  if (!composeWin) {
    log.error('Failed to open compose pop-out');
    return;
  }

  // Wait for compose to fully load before dropping files
  if (validPaths.length > 0) {
    await waitForComposeElements(composeWin);

    // Ensure the compose window and web contents are focused and active before drop
    if (!composeWin.isDestroyed()) {
      app.focus({ steal: true });
      composeWin.show();
      composeWin.focus();
      composeWin.webContents.focus();

      // Focus the message body editor so Gmail's compose canvas is active before drop
      await composeWin.webContents
        .executeJavaScript(
          `
        ${DOM_DRIVE_PREAMBLE}
        (() => {
          // The compose window holds exactly one div[role="textbox"], the
          // message body; there is no English label left to match.
          const editor = findAction(document, ${JSON.stringify(domAction('composeBody'))}).el;
          if (editor) {
            editor.focus();
          }
        })()
      `,
        )
        .catch(() => {});
    }

    await injectAttachments(composeWin, validPaths);
  }
}

async function injectAttachments(win: BrowserWindow, filePaths: string[]): Promise<void> {
  if (win.isDestroyed()) return;
  log.info(`Dropping ${filePaths.length} file(s) via native drag`);

  // Copy files to temp dir (originals may be in sandboxed locations)
  const tmpDir = createShareTempDir();
  const tempPaths = filePaths.map((p) => copyIntoShareTempDir(p, tmpDir));

  // Drop files via native macOS NSDraggingSession onto RenderWidgetHostView
  nativeDropFiles(win, tempPaths);
  log.info('Native drop initiated');

  // After the native drop completes (~150ms in magimail_addon.mm),
  // ensure the compose editor is focused so Gmail renders the attachment card,
  // then return focus to the "To" input if no recipient is set.
  setTimeout(() => {
    if (win.isDestroyed()) return;
    try {
      app.focus({ steal: true });
      win.show();
      win.focus();
      win.webContents.focus();
      win.webContents
        .executeJavaScript(
          `
        ${DOM_DRIVE_PREAMBLE}
        (() => {
          const editor = findAction(document, ${JSON.stringify(domAction('composeBody'))}).el;
          if (editor) {
            editor.focus();
          }
        })()
      `,
        )
        .catch(() => {});
    } catch {
      /* ignore */
    }
  }, 350);

  // Clean up temp files after Gmail has read them
  setTimeout(() => removeShareTempDir(tmpDir), 30000);
}
