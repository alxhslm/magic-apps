import { describe, it, expect, vi } from 'vitest';
import {
  NativeToolbarManager,
  SHARED_TOOLBAR_LABEL_KEYS,
  SHARED_TOOLBAR_TEMPLATE_KEYS,
  sharedToolbarLabels,
} from '../src/native-toolbar.js';

describe('SHARED_TOOLBAR_LABEL_KEYS', () => {
  it('names the plain strings both toolbars carry, because SuiteNative reads them', () => {
    expect([...SHARED_TOOLBAR_LABEL_KEYS]).toEqual([
      'toolbar.search',
      'toolbar.signInRequired',
      'toolbar.account.unknown',
    ]);
  });

  it('names the placeholder templates the account switcher fills natively', () => {
    expect([...SHARED_TOOLBAR_TEMPLATE_KEYS]).toEqual([
      'toolbar.account.noUnread',
      'toolbar.account.oneUnread',
      'toolbar.account.unread',
      'toolbar.account.signInRequired',
    ]);
  });
});

describe('sharedToolbarLabels', () => {
  it('resolves plain strings through the translator and templates raw', () => {
    const uiString = (key: string): string =>
      ({
        'toolbar.search': 'Search',
        'toolbar.signInRequired': 'Sign in required',
        'toolbar.account.unknown': 'Unknown',
      })[key] ?? `missing ${key}`;
    const uiStringTemplate = (key: string): string =>
      ({
        'toolbar.account.noUnread': '{name} — no unread{shortcut}',
        'toolbar.account.oneUnread': '{name} — 1 unread{shortcut}',
        'toolbar.account.unread': '{name} — {count} unread{shortcut}',
        'toolbar.account.signInRequired': '{name} — Sign in required{shortcut}',
      })[key] ?? `missing ${key}`;

    expect(sharedToolbarLabels(uiString, uiStringTemplate)).toEqual({
      'toolbar.search': 'Search',
      'toolbar.signInRequired': 'Sign in required',
      'toolbar.account.unknown': 'Unknown',
      'toolbar.account.noUnread': '{name} — no unread{shortcut}',
      'toolbar.account.oneUnread': '{name} — 1 unread{shortcut}',
      'toolbar.account.unread': '{name} — {count} unread{shortcut}',
      'toolbar.account.signInRequired': '{name} — Sign in required{shortcut}',
    });
  });
});

describe('NativeToolbarManager.updateLabels', () => {
  it('sends the labels under the envelope the addon parses', () => {
    const manager = new NativeToolbarManager({ addonPaths: [], dylibPaths: [] });
    const updateLabels = vi.fn();
    // The addon is normally set by `loadAddon`; the test wants the envelope only.
    (manager as unknown as { addon: { updateLabels: typeof updateLabels } }).addon = {
      updateLabels,
    };

    manager.updateLabels({ 'toolbar.search': 'Search' });

    expect(updateLabels).toHaveBeenCalledWith('{"labels":{"toolbar.search":"Search"}}');
  });

  it('does nothing when the addon has not loaded', () => {
    const manager = new NativeToolbarManager({ addonPaths: [], dylibPaths: [] });
    expect(() => manager.updateLabels({ 'toolbar.search': 'Search' })).not.toThrow();
  });
});
