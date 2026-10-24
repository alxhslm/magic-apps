import { app, globalShortcut, type BrowserWindow } from 'electron';
import { chooseComposeAccount } from './account-picker.js';
import { openDetachedComposeWindow } from './compose.js';
import { focusToField } from './compose-fields.js';
import type { AccountsManager } from './accounts-manager.js';
import type { ThemeManager } from './theme-manager.js';
import {
  DEFAULT_QUICK_COMPOSE_CHORD,
  QUICK_COMPOSE_CHORDS,
  type QuickComposeChord,
} from './settings-store.js';
import { createLogger } from '@magimail/core/logger';
import { uiString } from './strings.js';

const log = createLogger('QuickCompose');

export interface QuickComposeContext {
  accountsManager: AccountsManager | null;
  preloadPath: string;
  themeManager?: ThemeManager | null;
}

/**
 * Opens a compose window for a request from another application.
 *
 * A detached window rather than `triggerComposePopout()`, which needs the
 * account's web view already loaded — from a hotkey it usually is not. Does not
 * switch to the chosen account: the main window stays where the user left it.
 */
export async function openQuickCompose({
  accountsManager,
  preloadPath,
  themeManager,
}: QuickComposeContext): Promise<BrowserWindow | null> {
  if (!accountsManager) return null;

  // Before the alert: one raised by a background app opens behind whatever is frontmost.
  app.focus({ steal: true });

  const account = await chooseComposeAccount(accountsManager);
  if (!account) return null;

  const win = openDetachedComposeWindow(
    preloadPath,
    account.partition,
    undefined,
    themeManager ?? undefined,
  );
  win.setTitle(uiString('window.compose.accountTitle', { account: account.name }));
  win.once('ready-to-show', () => {
    win.focus();
  });
  void focusToField(win);

  return win;
}

/** Narrows a stored chord to one this build offers — settings.json is hand-editable. */
export function resolveQuickComposeChord(value: unknown): QuickComposeChord {
  return (QUICK_COMPOSE_CHORDS as readonly unknown[]).includes(value)
    ? (value as QuickComposeChord)
    : DEFAULT_QUICK_COMPOSE_CHORD;
}

let held: string | null = null;

/**
 * Holds the chord the setting names, releasing whatever was held before. Returns
 * the chord now held, or null for `off` and for one another application owns.
 */
export function setQuickComposeShortcut(
  chord: unknown,
  handler: () => void,
): QuickComposeChord | null {
  releaseQuickComposeShortcut();

  const accelerator = resolveQuickComposeChord(chord);
  if (accelerator === 'off') return null;

  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, handler);
  } catch {
    ok = false;
  }

  if (!ok) {
    // A chord goes to whoever asked first. Leave the setting as the user set it.
    log.warn(`${accelerator} is already taken by another application`);
    return null;
  }

  held = accelerator;
  return accelerator;
}

export function releaseQuickComposeShortcut(): void {
  if (!held) return;
  try {
    globalShortcut.unregister(held);
  } catch {
    // Already gone, or the app is tearing down
  }
  held = null;
}
