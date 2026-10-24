import * as fs from 'node:fs';
import type { BaseWindow } from 'electron';
import { TOOLBAR_HEIGHT } from './constants.js';
import type { LogSink } from './types.js';
import type { UiTemplateReader, UiTranslator } from './ui-strings.js';

export interface ToolbarAccount {
  id: string;
  name: string;
  color: string;
  partition?: string;
  unreadCount?: number;
  email?: string;
  excludedByFocus?: boolean;
  disabledByFocus?: boolean;
  needsAuth?: boolean;
}

export type ActionHandler = (action: string, value: string) => void;

/**
 * The toolbar's user-visible strings, keyed by the app's UI-catalogue key.
 *
 * The in-process addon is a dylib loaded into Electron, not a bundle, so it has
 * no resource bundle for Foundation to localise from and `swift build` does not
 * compile a String Catalog. The app already authors and validates these strings
 * in `ui-strings.json`, so it pushes them over the same JSON bridge that carries
 * the accounts and invitations. See `docs/shared/native-ui.md#localised-labels`.
 */
export type ToolbarLabels = Record<string, string>;

/**
 * The toolbar strings both apps define, because shared `SuiteNative` code reads
 * them (`ToolbarLabelKey` in Swift names the same keys). An app asserts they exist
 * with this list, which is what `DIAGNOSTICS_DIALOG_KEYS` does for the dialog.
 */
export const SHARED_TOOLBAR_LABEL_KEYS = [
  'toolbar.search',
  'toolbar.signInRequired',
  'toolbar.account.unknown',
] as const;

/**
 * The shared toolbar strings that carry placeholders and are therefore sent as
 * templates: the account switcher fills in an account's name, its unread count
 * and its shortcut on the native side.
 */
export const SHARED_TOOLBAR_TEMPLATE_KEYS = [
  'toolbar.account.noUnread',
  'toolbar.account.oneUnread',
  'toolbar.account.unread',
  'toolbar.account.signInRequired',
] as const;

/** Resolves the label set both toolbars carry, so neither app writes it twice. */
export function sharedToolbarLabels(
  uiString: UiTranslator,
  uiStringTemplate: UiTemplateReader,
): ToolbarLabels {
  const labels: ToolbarLabels = {};
  for (const key of SHARED_TOOLBAR_LABEL_KEYS) {
    labels[key] = uiString(key);
  }
  for (const key of SHARED_TOOLBAR_TEMPLATE_KEYS) {
    labels[key] = uiStringTemplate(key);
  }
  return labels;
}

export interface NativeToolbarAddon {
  init(dylibPath: string, callback: (action: string, value: string) => void): void;
  attach(nativeWindowHandle: Buffer): void;
  detach(): void;
  updateAccounts(json: string): void;
  /** Optional: an addon built before the labels bridge existed does not expose it. */
  updateLabels?(json: string): void;
  runCustomization(): void;
  setItemEnabled(itemId: string, enabled: boolean): void;
}

export function findFirstCandidate(candidates: string[]): string {
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Not found: tried ${candidates.join(', ')}`);
}

export interface NativeToolbarOptions {
  addonPaths: string[];
  dylibPaths: string[];
  logPrefix?: string;
  /** Where diagnostics go. Defaults to `console`. */
  logger?: LogSink;
}

/**
 * Shared Native Toolbar lifecycle manager.
 *
 * Encapsulates:
 * - Locating the in-process .node addon and Swift .dylib
 * - Thread-safe action callback correlation
 * - Electron BaseWindow handle unwrapping and sheet offsetting
 * - Serializing accounts with Focus filter state
 * - Item enabled/disabled state forwarding
 */
export class NativeToolbarManager<TAddon extends NativeToolbarAddon = NativeToolbarAddon> {
  private addon: TAddon | null = null;
  private actionHandler: ActionHandler | null = null;

  constructor(private readonly options: NativeToolbarOptions) {}

  public loadAddon(): TAddon {
    if (this.addon) return this.addon;

    const addonPath = findFirstCandidate(this.options.addonPaths);
    const dylibPath = findFirstCandidate(this.options.dylibPaths);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.addon = require(addonPath) as TAddon;
    this.addon.init(dylibPath, (action: string, value: string) => {
      this.actionHandler?.(action, value);
    });

    return this.addon;
  }

  public loadedAddon(): TAddon | null {
    return this.addon;
  }

  public setActionHandler(handler: ActionHandler): void {
    this.actionHandler = handler;
  }

  public attach(mainWindow: BaseWindow, sheetOffset: number = TOOLBAR_HEIGHT): void {
    const a = this.loadAddon();
    const handle = mainWindow.getNativeWindowHandle();
    a.attach(handle);
    mainWindow.setSheetOffset(sheetOffset);
  }

  public detach(): void {
    this.addon?.detach();
  }

  public updateLabels(labels: ToolbarLabels): void {
    this.addon?.updateLabels?.(JSON.stringify({ labels }));
  }

  public updateAccounts(accounts: ToolbarAccount[], activeAccountId: string): void {
    this.addon?.updateAccounts(
      JSON.stringify({
        accounts: accounts.map((a) => ({
          id: a.id,
          name: a.name,
          color: a.color,
          unreadCount: a.unreadCount ?? 0,
          excludedByFocus: Boolean(a.excludedByFocus),
          disabledByFocus: Boolean(a.disabledByFocus),
          needsAuth: Boolean(a.needsAuth),
        })),
        activeAccountId,
      }),
    );
  }

  public runCustomization(): void {
    this.addon?.runCustomization();
  }

  public setItemEnabled(itemId: string, enabled: boolean): void {
    try {
      this.loadAddon().setItemEnabled?.(itemId, enabled);
    } catch (err) {
      (this.options.logger ?? console).warn(
        `${this.options.logPrefix ?? '[NativeToolbar]'} setItemEnabled unavailable:`,
        err,
      );
    }
  }
}
