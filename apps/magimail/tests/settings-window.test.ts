import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const { sendToHelper } = vi.hoisted(() => ({ sendToHelper: vi.fn() }));

vi.mock('electron', () => ({ app: { getVersion: () => '1.2.3' } }));
vi.mock('../src/swift-helper.js', () => ({ sendToHelper }));
vi.mock('../src/settings-store.js', () => ({ loadSettings: () => ({ theme: 'system' }) }));

const { openSettingsWindow } = await import('../src/settings.js');

/**
 * The pane crosses into Swift as a bare string in the RPC payload. Dropping it
 * is silent: the window still opens, on the wrong pane, and every caller that
 * asked for a particular one gets the default.
 */

beforeEach(() => sendToHelper.mockClear());

describe('openSettingsWindow', () => {
  it('carries the requested pane to the helper', () => {
    openSettingsWindow('notifications');

    const [method, payload] = sendToHelper.mock.calls[0];
    expect(method).toBe('settings.show');
    expect(payload.pane).toBe('notifications');
  });

  it('asks for no particular pane when none was given', () => {
    openSettingsWindow();

    expect(sendToHelper.mock.calls[0][1].pane).toBeUndefined();
  });

  it('is read under the same key on the Swift side', () => {
    const helper = readFileSync(
      path.resolve(__dirname, '../swift/Sources/MagimailHelper/main.swift'),
      'utf8',
    );

    // Nothing type-checks across the RPC boundary; rename it freely, but
    // rename it on both sides.
    expect(helper).toContain('params["pane"]');
  });
});
