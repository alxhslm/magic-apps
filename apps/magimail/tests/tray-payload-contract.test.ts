import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AccountConfig } from '@magimail/core';

const mockSendToHelper = vi.fn();
const mockIsHelperRunning = vi.fn().mockReturnValue(true);
const mockLoadSettings = vi.fn().mockReturnValue({
  menuBarShowCount: true,
  menuBarShowDots: true,
});

vi.mock('../src/swift-helper.js', () => ({
  sendToHelper: (...args: unknown[]) => mockSendToHelper(...args),
  isHelperRunning: () => mockIsHelperRunning(),
}));

vi.mock('../src/settings-store.js', () => ({
  loadSettings: () => mockLoadSettings(),
}));

const { createTray, updateTrayData, destroyTray } = await import('../src/menubar-manager.js');

describe('Magimail Tray Payload Contracts', () => {
  const fixturesDir = path.join(__dirname, 'fixtures');

  beforeEach(() => {
    vi.clearAllMocks();
    destroyTray();
    vi.clearAllMocks();
  });

  it('validates tray-update.json structure matches the schema emitted by menubar-manager.ts', () => {
    const raw = fs.readFileSync(path.join(fixturesDir, 'tray-update.json'), 'utf8');
    const fixture = JSON.parse(raw);

    expect(Array.isArray(fixture.accounts)).toBe(true);
    expect(fixture.accounts.length).toBeGreaterThan(0);
    for (const acc of fixture.accounts) {
      expect(typeof acc.id).toBe('string');
      expect(typeof acc.name).toBe('string');
      expect(typeof acc.color).toBe('string');
      expect(typeof acc.unreadCount).toBe('number');
      expect(typeof acc.email).toBe('string');
      expect(typeof acc.needsAuth).toBe('boolean');
    }

    expect(typeof fixture.totalUnread).toBe('number');
    expect(typeof fixture.showCount).toBe('boolean');
    expect(typeof fixture.showDots).toBe('boolean');
    expect(typeof fixture.isOffline).toBe('boolean');
    expect(typeof fixture.isRestricted).toBe('boolean');
  });

  it('emits tray.update payload matching tray-update.json schema', () => {
    createTray();
    const raw = fs.readFileSync(path.join(fixturesDir, 'tray-update.json'), 'utf8');
    const fixture = JSON.parse(raw);

    const accounts: AccountConfig[] = fixture.accounts.map(
      (a: {
        id: string;
        name: string;
        color: string;
        unreadCount: number;
        email: string;
        needsAuth: boolean;
      }) => ({
        id: a.id,
        name: a.name,
        color: a.color,
        unreadCount: a.unreadCount,
        email: a.email,
        needsAuth: a.needsAuth,
        partition: `persist:${a.id}`,
      }),
    );

    updateTrayData(accounts, fixture.totalUnread, {
      isOffline: fixture.isOffline,
      isRestricted: fixture.isRestricted,
    });

    expect(mockSendToHelper).toHaveBeenCalledWith('tray.update', {
      accounts: fixture.accounts,
      totalUnread: fixture.totalUnread,
      showCount: fixture.showCount,
      showDots: fixture.showDots,
      isOffline: fixture.isOffline,
      isRestricted: fixture.isRestricted,
    });
  });

  it('validates tray-messages.json structure matches the schema emitted by main process', () => {
    const raw = fs.readFileSync(path.join(fixturesDir, 'tray-messages.json'), 'utf8');
    const fixture = JSON.parse(raw);

    expect(typeof fixture.accountId).toBe('string');
    expect(Array.isArray(fixture.messages)).toBe(true);
    expect(fixture.messages.length).toBeGreaterThan(0);

    for (const msg of fixture.messages) {
      expect(typeof msg.id).toBe('string');
      expect(typeof msg.threadId).toBe('string');
      expect(typeof msg.from).toBe('string');
      expect(typeof msg.subject).toBe('string');
      expect(typeof msg.snippet).toBe('string');
      expect(typeof msg.internalDate).toBe('string');
      expect(typeof msg.category).toBe('string');
      // A message still in the feed is `UNREAD`; one that has left it is read,
      // which is the tray's only read/unread signal.
      expect(Array.isArray(msg.labelIds)).toBe(true);
      expect(msg.labelIds.every((id: unknown) => id === 'UNREAD')).toBe(true);
    }
  });

  it('emits tray.messages payload matching tray-messages.json schema', async () => {
    const { pushTrayMessages } = await import('../src/menubar-manager.js');
    const raw = fs.readFileSync(path.join(fixturesDir, 'tray-messages.json'), 'utf8');
    const fixture = JSON.parse(raw);

    mockSendToHelper.mockClear();
    pushTrayMessages(
      fixture.accountId,
      fixture.messages.map(
        (m: {
          id: string;
          threadId: string;
          from: string;
          subject: string;
          snippet: string;
          internalDate: string;
          category: string;
          labelIds: string[];
        }) => ({
          id: m.id,
          threadId: m.threadId,
          from: m.from,
          subject: m.subject,
          snippet: m.snippet,
          modified: new Date(Number(m.internalDate)),
          category: m.category,
          unread: m.labelIds.includes('UNREAD'),
        }),
      ),
    );

    expect(mockSendToHelper).toHaveBeenCalledWith('tray.messages', {
      accountId: fixture.accountId,
      messages: fixture.messages,
    });
  });

  it('handles tray.threadAction fixture and all triage actions via handleTrayEvent', async () => {
    const { handleTrayEvent } = await import('../src/menubar-manager.js');
    const raw = fs.readFileSync(path.join(fixturesDir, 'tray-thread-action.json'), 'utf8');
    const fixture = JSON.parse(raw);

    const mockRouteThreadAction = vi.fn().mockResolvedValue('ok');
    const mockRequestImmediatePoll = vi.fn();
    const deps = {
      getMainWindow: () => null,
      getAccountsManager: () => ({
        switchAccount: vi.fn(),
        triggerMailAction: vi.fn(),
        performThreadAction: vi.fn().mockResolvedValue(undefined),
      }),
      routeThreadAction: mockRouteThreadAction,
      requestImmediatePoll: mockRequestImmediatePoll,
    };

    const handled = handleTrayEvent('tray.threadAction', fixture, deps);
    expect(handled).toBe(true);
    // Triage routes across the window boundary rather than reaching for the manager: the
    // direct write is tried first, and only one that cannot land builds a background window.
    expect(mockRouteThreadAction).toHaveBeenCalledWith(
      fixture.accountId,
      fixture.threadId,
      'archive',
    );

    // Test remaining triage actions
    for (const action of ['trash', 'markRead', 'markUnread'] as const) {
      mockRouteThreadAction.mockClear();
      handleTrayEvent('tray.threadAction', { ...fixture, action }, deps);
      expect(mockRouteThreadAction).toHaveBeenCalledWith(
        fixture.accountId,
        fixture.threadId,
        action,
      );
    }
  });

  it('handles tray.showThread fixture via handleTrayEvent', async () => {
    const { handleTrayEvent } = await import('../src/menubar-manager.js');
    const raw = fs.readFileSync(path.join(fixturesDir, 'tray-show-thread.json'), 'utf8');
    const fixture = JSON.parse(raw);

    const mockPerformThreadAction = vi.fn().mockResolvedValue(undefined);
    const deps = {
      getMainWindow: () => null,
      getAccountsManager: () => ({
        switchAccount: vi.fn(),
        triggerMailAction: vi.fn(),
        performThreadAction: mockPerformThreadAction,
      }),
    };

    const handled = handleTrayEvent('tray.showThread', fixture, deps);
    expect(handled).toBe(true);
    expect(mockPerformThreadAction).toHaveBeenCalledWith(
      fixture.accountId,
      fixture.threadId,
      'open',
    );
  });

  it('handles tray.compose, search, showAccount, refresh, openSettings, and quit via handleTrayEvent', async () => {
    const { handleTrayEvent } = await import('../src/menubar-manager.js');
    const mockWindow = { show: vi.fn(), focus: vi.fn() };
    const mockAccountsManager = {
      switchAccount: vi.fn(),
      triggerMailAction: vi.fn(),
      performThreadAction: vi.fn().mockResolvedValue(undefined),
      openInAccount: vi.fn(),
    };
    const mockPollAllNow = vi.fn().mockResolvedValue(undefined);
    const mockOpenSettings = vi.fn();
    const mockQuit = vi.fn();

    const deps = {
      getMainWindow: () => mockWindow,
      getAccountsManager: () => mockAccountsManager,
      pollAllNow: mockPollAllNow,
      openSettings: mockOpenSettings,
      quitApp: mockQuit,
    };

    // tray.compose with account
    handleTrayEvent('tray.compose', { accountId: 'account_work' }, deps);
    expect(mockWindow.show).toHaveBeenCalled();
    expect(mockAccountsManager.switchAccount).toHaveBeenCalledWith('account_work');
    expect(mockAccountsManager.triggerMailAction).toHaveBeenCalledWith('compose', 'account_work');

    // tray.showAccount
    handleTrayEvent('tray.showAccount', { accountId: 'account_personal' }, deps);
    expect(mockAccountsManager.switchAccount).toHaveBeenCalledWith('account_personal');

    // tray.search
    handleTrayEvent('tray.search', { query: 'invoice', accountId: 'account_work' }, deps);
    expect(mockAccountsManager.openInAccount).toHaveBeenCalledWith(
      'account_work',
      expect.stringContaining(encodeURIComponent('invoice')),
    );

    // tray.refresh
    handleTrayEvent('tray.refresh', {}, deps);
    expect(mockPollAllNow).toHaveBeenCalled();

    // tray.openSettings: the helper asks, it does not open the window itself
    handleTrayEvent('tray.openSettings', {}, deps);
    expect(mockOpenSettings).toHaveBeenCalled();

    // tray.quit
    handleTrayEvent('tray.quit', {}, deps);
    expect(mockQuit).toHaveBeenCalled();
  });
});
