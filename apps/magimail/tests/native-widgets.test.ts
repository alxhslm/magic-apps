import { describe, it, expect, vi, beforeEach } from 'vitest';
import { appGroupContainerPath, reloadNativeWidgets } from '../src/native-widgets.js';
import * as nativeAddon from '../src/native-addon.js';

vi.mock('../src/native-addon.js', () => ({
  loadAddon: vi.fn(),
}));

// Hoisted: `vi.mock` is lifted above the file's other statements, so a plain
// `const` would not exist yet when the factory runs.
const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@magimail/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: logError }),
}));

// A demo run is the case where userData and the App Group disagree: `--profile` moves
// the first and not the second, which is keyed to the bundle id and its signature.
const demoState = vi.hoisted(() => ({ demo: false }));
vi.mock('@magimail/core', async () => {
  const actual = await vi.importActual<typeof import('@magimail/core')>('@magimail/core');
  return { ...actual, isDemoMode: () => demoState.demo };
});

describe('native widgets', () => {
  const reloadWidgetsMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nativeAddon.loadAddon).mockReturnValue({
      reloadWidgets: reloadWidgetsMock,
    } as unknown as nativeAddon.NativeAddon);
  });

  it('calls loadAddon().reloadWidgets() to trigger timeline reload', () => {
    reloadNativeWidgets();
    expect(nativeAddon.loadAddon).toHaveBeenCalledTimes(1);
    expect(reloadWidgetsMock).toHaveBeenCalledTimes(1);
  });

  it('catches and logs errors without throwing when reloadWidgets fails', () => {
    reloadWidgetsMock.mockImplementation(() => {
      throw new Error('Dylib failure');
    });

    expect(() => reloadNativeWidgets()).not.toThrow();
    // The subsystem name is the logger's scope now, not part of the message.
    expect(logError).toHaveBeenCalledWith('Failed to reload timelines:', expect.any(Error));
  });
});

/**
 * The group's team prefix is fixed when the app is signed, and only the
 * certificate knows it. Naming it in the source gave anyone building on their
 * own Apple ID a container they are not entitled for, so the identifier is read
 * back out of the signature instead.
 */
describe('the App Group container', () => {
  const appGroupIdentifier = vi.fn();
  const groupContainerPath = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    demoState.demo = false;
    vi.mocked(nativeAddon.loadAddon).mockReturnValue({
      appGroupIdentifier,
      groupContainerPath,
    } as unknown as nativeAddon.NativeAddon);
  });

  it('has no container in a demo, even when the signature names a group', () => {
    // The group holds the real install's accounts, and a demo's are invented. Reaching
    // it would show the real mailbox and write the invented one back.
    demoState.demo = true;
    appGroupIdentifier.mockReturnValue('TEAM123456.group.com.alexhaslam.magimail');
    groupContainerPath.mockReturnValue('/Users/someone/Library/Group Containers/g');

    expect(appGroupContainerPath()).toBeNull();
    expect(nativeAddon.loadAddon).not.toHaveBeenCalled();
  });

  it('asks for the container of the group the signature names', () => {
    appGroupIdentifier.mockReturnValue('TEAM123456.group.com.alexhaslam.magimail');
    groupContainerPath.mockReturnValue('/Users/someone/Library/Group Containers/g');

    expect(appGroupContainerPath()).toBe('/Users/someone/Library/Group Containers/g');
    expect(groupContainerPath).toHaveBeenCalledWith('TEAM123456.group.com.alexhaslam.magimail');
  });

  it('has no container when the build is entitled for no group', () => {
    // An unsigned or ad-hoc build carries no entitlements, which is the
    // development case; the widget renders its placeholder.
    appGroupIdentifier.mockReturnValue(null);

    expect(appGroupContainerPath()).toBeNull();
    expect(groupContainerPath).not.toHaveBeenCalled();
  });

  it('has no container rather than throwing when the addon is missing', () => {
    vi.mocked(nativeAddon.loadAddon).mockImplementation(() => {
      throw new Error('addon missing');
    });

    expect(appGroupContainerPath()).toBeNull();
  });
});
