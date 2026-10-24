import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleTrayEvent, type TrayEventHandlerDeps } from '../src/menubar-manager.js';

vi.mock('../src/swift-helper.js', () => ({
  sendToHelper: vi.fn(),
  isHelperRunning: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/settings-store.js', () => ({
  loadSettings: vi.fn().mockReturnValue({ menuBarShowCount: true, menuBarShowDots: true }),
}));

/**
 * The popover is reachable with no window behind it, so every tray event that acts on mail asks
 * for what it needs. Triage routes instead of asking for a window — the direct write is tried
 * first, and only one that cannot land builds a background window — while anything that asks to
 * look at something raises one.
 */
describe('tray events ask for what they need', () => {
  let deps: TrayEventHandlerDeps;
  let ensureWindow: ReturnType<typeof vi.fn>;
  let routeThreadAction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ensureWindow = vi.fn();
    routeThreadAction = vi.fn().mockResolvedValue('ok');
    deps = {
      getMainWindow: () => null,
      getAccountsManager: () => null,
      ensureWindow,
      routeThreadAction,
      requestImmediatePoll: vi.fn(),
    };
  });

  it('routes a triage action rather than building a window for it', () => {
    expect(
      handleTrayEvent(
        'tray.threadAction',
        { accountId: 'acc', threadId: 'thread', action: 'archive' },
        deps,
      ),
    ).toBe(true);

    expect(routeThreadAction).toHaveBeenCalledWith('acc', 'thread', 'archive');
    expect(ensureWindow).not.toHaveBeenCalled();
  });

  it('raises the window for opening a thread', () => {
    handleTrayEvent('tray.showThread', { accountId: 'acc', threadId: 'thread' }, deps);

    expect(ensureWindow).toHaveBeenCalledWith('acc', { show: true });
  });

  it('raises the window for an account row, a compose and a search', () => {
    handleTrayEvent('tray.showAccount', { accountId: 'acc' }, deps);
    expect(ensureWindow).toHaveBeenLastCalledWith('acc', { show: true });

    handleTrayEvent('tray.compose', {}, deps);
    expect(ensureWindow).toHaveBeenLastCalledWith(undefined, { show: true });

    handleTrayEvent('tray.search', { query: 'dentist', accountId: 'acc' }, deps);
    expect(ensureWindow).toHaveBeenLastCalledWith('acc', { show: true });
  });

  it('does nothing when the deps predate the hook', () => {
    // Both hooks are optional, so a caller that has not been taught about them still gets the
    // old behaviour rather than a throw.
    const bare: TrayEventHandlerDeps = {
      getMainWindow: () => null,
      getAccountsManager: () => null,
    };

    expect(() =>
      handleTrayEvent(
        'tray.threadAction',
        { accountId: 'a', threadId: 't', action: 'trash' },
        bare,
      ),
    ).not.toThrow();
  });
});
