import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * The Focus Filter state crosses three languages before it reaches the app, and
 * every boundary is a bare string:
 *
 *   MagimailAppIntents.appex  →  focus-filter.json  →  MagimailHelper  →  main.ts
 *
 * Nothing type-checks across those hops. Rename the Swift property without
 * touching the reader and the filter keeps registering, keeps appearing in
 * System Settings and keeps writing its file — it simply stops meaning
 * anything, because the far side reads a key that is no longer there and
 * silently falls back to `false`.
 *
 * The hand-written `Metadata.appintents` is the same hazard one layer up: it
 * names the intent's parameters independently of the Swift that implements
 * them, and an entry that does not match a real property is not an error
 * anywhere — it just never resolves. That is not hypothetical. A single
 * wrong character in this file (`0a11` for `0A11` in the mangled type name)
 * left the extension registered and healthy-looking while the Focus UI showed
 * nothing at all.
 *
 * These assertions are deliberately about agreement, not about any particular
 * spelling: rename the field freely, but rename it everywhere.
 */
const APP = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(APP, rel), 'utf8');

const INTENT = 'app-intents-extension/Sources/main.swift';
const HELPER = 'swift/Sources/MagimailHelperLib/FocusFilter.swift';
const MAIN = 'src/main.ts';
const METADATA = 'app-intents-extension/Resources/Metadata.appintents/extract.actionsdata';

/** The keys written into focus-filter.json by the extension's `perform()`. */
function payloadKeys(src: string): string[] {
  const marker = 'let payload: [String: Any] = [';
  const start = src.indexOf(marker);
  expect(start, 'the intent no longer builds a payload dictionary').toBeGreaterThan(-1);
  // Start after the type annotation, whose own brackets would end the slice early.
  const open = start + marker.length;
  const block = src.slice(open, src.indexOf('\n        ]', open));
  return [...block.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)":/g)].map((m) => m[1]);
}

describe('Focus Filter cross-language contract', () => {
  it('every key the extension writes is read by the helper', () => {
    const written = payloadKeys(read(INTENT));
    const helper = read(HELPER);

    expect(written).toContain('activeAccountIds');
    expect(written).toContain('disableExcludedAccounts');

    for (const key of written) {
      // `timestamp` and `isFilterActive` are written for humans and for future
      // use; only the keys the helper consumes are part of the contract.
      if (key === 'timestamp' || key === 'isFilterActive') continue;
      expect(helper, `helper never reads "${key}" out of focus-filter.json`).toContain(
        `json["${key}"]`,
      );
    }
  });

  it('every key the helper forwards is read by the main process', () => {
    const main = read(MAIN);
    for (const key of ['activeAccountIds', 'disableExcludedAccounts']) {
      expect(main, `main.ts never reads "${key}" off focusFilter.changed`).toContain(
        `params.${key}`,
      );
    }
  });

  it('the hand-written metadata names parameters the intent actually declares', () => {
    const intent = read(INTENT);
    const metadata = JSON.parse(read(METADATA));
    const declared = [...intent.matchAll(/public var ([A-Za-z_][A-Za-z0-9_]*):/g)].map((m) => m[1]);

    const named: string[] = Object.values<{ parameters?: { name: string }[] }>(metadata.actions)
      .flatMap((action) => action.parameters ?? [])
      .map((parameter) => parameter.name);

    expect(named.length).toBeGreaterThan(0);
    for (const name of named) {
      expect(
        declared,
        `Metadata.appintents names "${name}", which the intent does not declare`,
      ).toContain(name);
    }
  });

  it('the metadata points at the intent and entity types the extension defines', () => {
    const intent = read(INTENT);
    const metadata = JSON.parse(read(METADATA));

    const types = [
      ...Object.values<{ fullyQualifiedTypeName?: string }>(metadata.actions),
      ...Object.values<{ fullyQualifiedTypeName?: string }>(metadata.entities ?? {}),
      ...Object.values<{ fullyQualifiedTypeName?: string }>(metadata.queries ?? {}),
    ]
      .map((entry) => entry.fullyQualifiedTypeName)
      .filter((name): name is string => Boolean(name));

    expect(types.length).toBeGreaterThan(0);
    for (const qualified of types) {
      const bare = qualified.split('.').pop()!;
      expect(
        intent,
        `metadata references ${qualified}, which the extension does not define`,
      ).toMatch(new RegExp(`(struct|enum|final class)\\s+${bare}\\b`));
    }
  });

  it('mangled type names use the module the extension is actually built as', () => {
    const buildScript = read('app-intents-extension/build.sh');
    const metadata = JSON.parse(read(METADATA));
    const moduleName = /PRODUCT_NAME="([^"]+)"/.exec(buildScript)?.[1];

    expect(moduleName, 'cannot determine the module name from build.sh').toBeTruthy();

    const mangled = Object.values<{ mangledTypeName?: string }>(metadata.actions)
      .map((action) => action.mangledTypeName)
      .filter((name): name is string => Boolean(name));

    expect(mangled.length).toBeGreaterThan(0);
    for (const name of mangled) {
      // Swift mangles a module as <length><name>, so the module the metadata
      // claims must be the one `swiftc` is told to produce.
      expect(name).toContain(`${moduleName!.length}${moduleName}`);
    }
  });
  it('vends a Focus Filter with no notification predicate', () => {
    const intent = read(INTENT);
    const start = intent.indexOf('var appContext: FocusFilterAppContext');
    expect(start, 'the intent no longer declares appContext').toBeGreaterThan(-1);
    const body = intent.slice(start, intent.indexOf('public init()', start));

    expect(body, 'appContext must return an empty context').toContain('FocusFilterAppContext()');
    expect(body).not.toContain('notificationFilterPredicate');
    expect(body).not.toContain('NSPredicate');
  });

  // With no notification predicate, the helper's own check is the only thing that keeps a
  // Focus-muted account quiet, so it has to run before any banner is built or posted. The
  // main process deliberately hands the banner over either way; see
  // `docs/magimail/focus-filters.md`.
  it('silences a Focus-muted account in the helper, before posting', () => {
    const helper = read('swift/Sources/MagimailHelperLib/NotificationController.swift');
    const start = helper.indexOf('func dispatch(');
    expect(start, 'the helper no longer declares dispatch').toBeGreaterThan(-1);
    const dispatch = helper.slice(start);

    const guard = dispatch.indexOf('FocusFilterController.shared.isAccountMuted(accountId)');
    const post = dispatch.indexOf('post(identifier:');
    expect(guard, 'the helper no longer checks the Focus filter before posting').toBeGreaterThan(
      -1,
    );
    expect(post).toBeGreaterThan(guard);
  });
});
