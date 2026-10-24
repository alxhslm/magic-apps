import { describe, it, expect, vi } from 'vitest';
import type { BaseWindow } from 'electron';
import {
  openWindowForAction,
  routeAcrossWindow,
  type WindowActionTarget,
  type WindowRoute,
} from '../src/window-route.js';

/** Magimail's union. The shared function names only `failed`, so each app keeps its own. */
type ThreadActionOutcome = 'ok' | 'failed';

/** Magical's union, which adds the page's verdict on an action an open editor is holding. */
type CalendarActionOutcome = 'ok' | 'busy' | 'failed';

/**
 * An action arrives most often with the window closed, because a banner outlives the window that
 * scheduled it and Magical runs as a menu-bar app. These pin which path runs in each state.
 */
function makeRoute<Outcome extends string>(
  overrides: Partial<WindowRoute<Outcome>> = {},
): WindowRoute<Outcome> {
  return {
    window: vi.fn().mockReturnValue(null),
    direct: vi.fn().mockResolvedValue('failed' as Outcome),
    openWindow: vi.fn().mockResolvedValue('ok' as Outcome),
    ...overrides,
  };
}

describe('routeAcrossWindow', () => {
  it('uses the window stack while the window is open, and nothing else', async () => {
    const route = makeRoute<ThreadActionOutcome>({
      window: vi.fn().mockReturnValue(Promise.resolve('ok')),
    });

    expect(await routeAcrossWindow(route)).toBe('ok');
    expect(route.window).toHaveBeenCalledTimes(1);
    expect(route.direct).not.toHaveBeenCalled();
    expect(route.openWindow).not.toHaveBeenCalled();
  });

  it('writes directly when the window is closed, without building one', async () => {
    const route = makeRoute<ThreadActionOutcome>({ direct: vi.fn().mockResolvedValue('ok') });

    expect(await routeAcrossWindow(route)).toBe('ok');
    expect(route.direct).toHaveBeenCalledTimes(1);
    expect(route.openWindow).not.toHaveBeenCalled();
  });

  it('leaves a held action held rather than building a window for it', async () => {
    // `busy` is the page's verdict on an open editor, so a window already answered it.
    const route = makeRoute<CalendarActionOutcome>({ direct: vi.fn().mockResolvedValue('busy') });

    expect(await routeAcrossWindow(route)).toBe('busy');
    expect(route.openWindow).not.toHaveBeenCalled();
  });

  it('builds the window for the page when the direct write cannot land', async () => {
    const openWindow = vi.fn().mockResolvedValue('ok');
    const route = makeRoute<ThreadActionOutcome>({
      direct: vi.fn().mockResolvedValue('failed'),
      openWindow,
    });

    expect(await routeAcrossWindow(route)).toBe('ok');
    expect(openWindow).toHaveBeenCalledTimes(1);
  });

  it('reports failure when neither the write nor a window can do it', async () => {
    const route = makeRoute<CalendarActionOutcome>({
      direct: vi.fn().mockResolvedValue('failed'),
      openWindow: vi.fn().mockResolvedValue('failed'),
    });

    expect(await routeAcrossWindow(route)).toBe('failed');
  });
});

/** The manager the target hands back, standing in for one app's own. */
const manager = { kind: 'stand-in' };

type MockWindow = BaseWindow & { show: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };

function makeWindow(): MockWindow {
  return { show: vi.fn(), focus: vi.fn() } as unknown as MockWindow;
}

function makeTarget(
  overrides: Partial<WindowActionTarget<typeof manager>> = {},
): WindowActionTarget<typeof manager> {
  return {
    getWindow: vi.fn().mockReturnValue(null),
    createWindow: vi.fn(),
    focusApp: vi.fn(),
    getManager: vi.fn().mockReturnValue(manager),
    ...overrides,
  };
}

describe('openWindowForAction', () => {
  it('builds a hidden window for an action that drives a page, and raises nothing', () => {
    const target = makeTarget();

    expect(openWindowForAction(target, 'account_personal', { show: false })).toBe(manager);
    expect(target.createWindow).toHaveBeenCalledWith('account_personal', { show: false });
    expect(target.focusApp).not.toHaveBeenCalled();
  });

  it('shows the window it builds by default, on the account the action is about', () => {
    const target = makeTarget();

    expect(openWindowForAction(target, 'account_personal')).toBe(manager);
    expect(target.createWindow).toHaveBeenCalledWith('account_personal', { show: true });
  });

  it('builds one for an entry point that names no account', () => {
    const target = makeTarget();

    expect(openWindowForAction(target)).toBe(manager);
    expect(target.createWindow).toHaveBeenCalledWith(undefined, { show: true });
  });

  it('focuses the app and raises the window for an action that asks to look at something', () => {
    const win = makeWindow();
    const target = makeTarget({ getWindow: vi.fn().mockReturnValue(win) });

    expect(openWindowForAction(target, 'account_personal')).toBe(manager);
    expect(target.focusApp).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(target.createWindow).not.toHaveBeenCalled();
  });

  it('neither focuses nor raises an open window for an action that must not', () => {
    const win = makeWindow();
    const target = makeTarget({ getWindow: vi.fn().mockReturnValue(win) });

    expect(openWindowForAction(target, 'account_personal', { show: false })).toBe(manager);
    expect(target.focusApp).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    expect(target.createWindow).not.toHaveBeenCalled();
  });

  it('returns null while the window has built no manager', () => {
    const target = makeTarget({ getManager: vi.fn().mockReturnValue(null) });

    expect(openWindowForAction(target, 'account_personal', { show: false })).toBeNull();
  });
});
