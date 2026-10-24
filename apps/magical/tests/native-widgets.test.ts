import { describe, it, expect, vi, beforeEach } from 'vitest';
import { appGroupContainerPath } from '../src/native-widgets.js';
import * as nativeAddon from '../src/native-addon.js';

vi.mock('../src/native-addon.js', () => ({
  loadAddon: vi.fn(),
}));

vi.mock('@magimail/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

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
    vi.mocked(nativeAddon.loadAddon).mockReturnValue({
      appGroupIdentifier,
      groupContainerPath,
    } as unknown as nativeAddon.NativeAddon);
  });

  it('asks for the container of the group the signature names', () => {
    appGroupIdentifier.mockReturnValue('TEAM123456.group.com.alexhaslam.magical');
    groupContainerPath.mockReturnValue('/Users/someone/Library/Group Containers/g');

    expect(appGroupContainerPath()).toBe('/Users/someone/Library/Group Containers/g');
    expect(groupContainerPath).toHaveBeenCalledWith('TEAM123456.group.com.alexhaslam.magical');
  });

  it('has no container when the build is entitled for no group', () => {
    // An unsigned or ad-hoc build carries no entitlements, which is the
    // development case; the widget renders its placeholder.
    appGroupIdentifier.mockReturnValue(null);

    expect(appGroupContainerPath()).toBeNull();
    expect(groupContainerPath).not.toHaveBeenCalled();
  });

  it('has no container when the addon predates the call', () => {
    // Every member of the addon interface is optional on this app, so a dylib
    // without the symbol must resolve nothing rather than throw.
    vi.mocked(nativeAddon.loadAddon).mockReturnValue({} as nativeAddon.NativeAddon);

    expect(appGroupContainerPath()).toBeNull();
  });

  it('has no container rather than throwing when the addon is missing', () => {
    vi.mocked(nativeAddon.loadAddon).mockImplementation(() => {
      throw new Error('addon missing');
    });

    expect(appGroupContainerPath()).toBeNull();
  });
});
