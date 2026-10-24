import { BaseWindow } from 'electron';
import { type ToolbarAccount, TOOLBAR_HEIGHT } from '@magimail/core';
import {
  type ActionHandler,
  loadAddon,
  loadedAddon,
  setActionHandler,
  toolbarManager,
} from './native-addon.js';
import { toolbarLabels } from './toolbar-labels.js';
import { createLogger } from '@magimail/core/logger';

const log = createLogger('NativeToolbar');

export type { ToolbarAccount };

export function attachNativeToolbar(mainWindow: BaseWindow): void {
  const a = loadAddon();
  // Before attach, so the items AppKit builds carry their final labels. The
  // addon is a dylib, not a bundle, so it cannot read a String Catalog itself.
  toolbarManager.updateLabels(toolbarLabels());
  const handle = mainWindow.getNativeWindowHandle();
  a.attach(handle);
  mainWindow.setSheetOffset(TOOLBAR_HEIGHT);
}

export function detachNativeToolbar(): void {
  loadedAddon()?.detach();
}

export function updateNativeToolbarAccounts(
  accounts: ToolbarAccount[],
  activeAccountId: string,
): void {
  loadedAddon()?.updateAccounts(
    JSON.stringify({
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        color: a.color,
        unreadCount: a.unreadCount,
        excludedByFocus: Boolean(a.excludedByFocus),
        disabledByFocus: Boolean(a.disabledByFocus),
        needsAuth: Boolean(a.needsAuth),
      })),
      activeAccountId,
    }),
  );
}

/** One row of the invitations dropdown. */
export interface ToolbarInvite {
  key: string;
  summary: string;
  /** The line under the title: when it starts, and which account it landed on. */
  detail: string;
  /** Arrived while the user was away and not yet read, which is what the badge counts. */
  isNew: boolean;
}

/**
 * Replaces the invitations dropdown wholesale.
 *
 * The full list goes over every time rather than a diff. It is a couple of dozen entries
 * at most, and a menu rebuilt from the same array that produced the badge cannot end up
 * disagreeing with it.
 */
export function updateNativeToolbarInvites(invites: ToolbarInvite[], count?: number): void {
  loadedAddon()?.updateInvites?.(JSON.stringify({ invites, count }));
}

export function onNativeToolbarAction(handler: ActionHandler): void {
  setActionHandler(handler);
}

export function runToolbarCustomization(): void {
  loadedAddon()?.runCustomization();
}

export function setNativeToolbarItemEnabled(itemId: string, enabled: boolean): void {
  try {
    const a = loadAddon();
    a.setItemEnabled?.(itemId, enabled);
  } catch (err) {
    log.warn('setItemEnabled unavailable:', err);
  }
}

/**
 * The items that drive the calendar grid and have nothing to do in Tasks.
 *
 * `< Today >` moves a period the Tasks canvas does not draw, and Google's search is an
 * event search, so neither has an answer to give there. Both dim in Tasks mode rather
 * than disappear, which keeps the toolbar's shape steady across a mode switch.
 */
const GRID_ITEM_IDS = ['navGroup', 'search'] as const;

/**
 * Reconfigures the toolbar for the mode the account on screen is in.
 *
 * Called from `onModeChanged` and on an account switch, because each account keeps its
 * own mode: moving from a Calendar account to a Tasks one has to dim the grid items
 * without a navigation having happened first.
 */
export function setNativeToolbarMode(mode: 'calendar' | 'tasks'): void {
  const enabled = mode === 'calendar';
  for (const id of GRID_ITEM_IDS) setNativeToolbarItemEnabled(id, enabled);
}
