import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * The helper's bundle identity is spread across four files that nothing
 * type-checks against each other, and each fails silently when wrong — in a
 * packaged build, on a real message, never in a test run or a lint.
 *
 * The assertions are about agreement, not spelling: change the destination or
 * the event name freely, but change it everywhere. What each one protects, and
 * why, is in `docs/shared/notifications.md#bundle-identity`.
 */
const APP = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(APP, rel), 'utf8');

const BUILDER = 'electron-builder.json';
const BUILD_SH = 'swift/build.sh';
const HELPER_MAIN = 'swift/Sources/MagimailHelper/main.swift';
const MAIN = 'src/main.ts';
const SWIFT_HELPER = 'src/swift-helper.ts';

describe('Swift helper bundle identity contract', () => {
  it('packages the helper into Contents/MacOS, not Contents/Resources', () => {
    const builder = JSON.parse(read(BUILDER)) as {
      appId: string;
      extraFiles?: Array<{ from: string; to: string }>;
      extraResources?: Array<{ from: string; to: string }>;
    };

    const helper = (builder.extraFiles ?? []).find((f) => f.from.includes('MagimailHelper'));
    expect(helper, 'the helper is no longer bundled via extraFiles').toBeDefined();
    expect(
      helper!.to,
      'the helper must land in Contents/MacOS or it has no bundle identity at all',
    ).toBe('MacOS/MagimailHelper');

    const stray = (builder.extraResources ?? []).find((f) => f.to.includes('MagimailHelper'));
    expect(
      stray,
      'the helper is back in Contents/Resources, where it cannot notify',
    ).toBeUndefined();
  });

  it('signs the helper as the app, and stops electron-builder re-signing it', () => {
    const builder = JSON.parse(read(BUILDER)) as {
      appId: string;
      mac?: { signIgnore?: string[] };
    };

    // The identifier is read from appId by build.sh rather than written out, so
    // the two cannot drift; assert the mechanism rather than the literal.
    const buildSh = read(BUILD_SH);
    expect(buildSh, 'build.sh no longer takes the identifier from electron-builder.json').toContain(
      'electron-builder.json',
    );
    expect(buildSh, 'the helper must be signed with an explicit --identifier').toContain(
      '--identifier "$APP_ID"',
    );

    const ignored = builder.mac?.signIgnore ?? [];
    expect(
      ignored.some((p) => p.includes('MagimailHelper')),
      'electron-builder will re-sign the helper under the default identifier',
    ).toBe(true);
    expect(builder.appId).toBeTruthy();
  });

  it('looks the helper up beside the Electron binary', () => {
    expect(read(SWIFT_HELPER)).toContain("'MacOS', 'MagimailHelper'");
  });

  it('forwards a quit delivered to the helper, and the main process listens', () => {
    expect(
      read(HELPER_MAIN),
      'the helper no longer forwards a quit, so scripted quits will gut the app',
    ).toContain('transport.sendEvent(method: "app.quit")');

    expect(read(MAIN), 'nothing acts on the helper’s app.quit event').toContain(
      "method === 'app.quit'",
    );
  });
});
