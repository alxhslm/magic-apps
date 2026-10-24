import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * The quick compose chord is written out twice, in two languages, by hand:
 *
 *   SettingsWindow.swift  →  settings.changed  →  settings-store.ts
 *
 * The SwiftUI Picker's `.tag(…)` strings are Electron accelerators, and nothing
 * type-checks them against `QUICK_COMPOSE_CHORDS` on the other side. Drift is
 * silent in the worst way: the Picker keeps rendering, the user keeps choosing,
 * the event keeps arriving — and `resolveQuickComposeChord()` throws the value
 * away as unrecognised and holds the default instead. The chosen chord simply
 * never works, with nothing anywhere saying so.
 *
 * These assertions are about agreement, not spelling. Change the chords freely,
 * but change them on both sides.
 */
const APP = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(APP, rel), 'utf8');

const STORE = 'src/settings-store.ts';
const WINDOW = 'swift/Sources/MagimailHelperLib/SettingsWindow.swift';
const MODEL = 'swift/Sources/MagimailHelperLib/SettingsModel.swift';

/** The accelerators `QUICK_COMPOSE_CHORDS` offers. */
function chordsFromStore(src: string): string[] {
  const marker = 'export const QUICK_COMPOSE_CHORDS = [';
  const start = src.indexOf(marker);
  expect(start, 'settings-store no longer declares QUICK_COMPOSE_CHORDS').toBeGreaterThan(-1);
  const body = src.slice(start + marker.length, src.indexOf(']', start));
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** The accelerators the SwiftUI Picker tags its rows with. */
function chordsFromPicker(src: string): string[] {
  const marker = 'Picker("Quick compose hotkey:"';
  const start = src.indexOf(marker);
  expect(start, 'the settings window no longer has a quick compose picker').toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n            }', start));
  return [...body.matchAll(/\.tag\("([^"]+)"\)/g)].map((m) => m[1]);
}

describe('quick compose chord contract', () => {
  it('offers the same chords on both sides of the transport', () => {
    const store = chordsFromStore(read(STORE));
    const picker = chordsFromPicker(read(WINDOW));

    expect(store.length, 'no chords parsed out of settings-store').toBeGreaterThan(1);
    expect([...picker].sort()).toEqual([...store].sort());
  });

  it('keeps `off` in the chord list rather than a separate enable toggle', () => {
    // Two settings for one decision can disagree; one cannot.
    expect(chordsFromStore(read(STORE))).toContain('off');
    expect(chordsFromPicker(read(WINDOW))).toContain('off');
  });

  it('defaults to a chord the picker actually offers', () => {
    const src = read(STORE);
    const match = src.match(/DEFAULT_QUICK_COMPOSE_CHORD: QuickComposeChord = '([^']+)'/);
    expect(match, 'settings-store no longer names a default chord').not.toBeNull();
    expect(chordsFromPicker(read(WINDOW))).toContain(match![1]);
    expect(match![1]).not.toBe('off');
  });

  it('names the setting identically in both languages', () => {
    // The key travels as a bare string in `settings.changed`.
    const model = read(MODEL);
    expect(model).toContain('emit("quickComposeHotkey"');
    expect(model).toContain('dict["quickComposeHotkey"]');
    expect(read(STORE)).toContain('quickComposeHotkey:');
  });

  it('carries the chord as a string, not the boolean it started as', () => {
    // A `Bool` here would fail `as? String` in update(from:) and leave the
    // picker showing a chord the main process is not holding.
    const model = read(MODEL);
    expect(model).toMatch(/var quickComposeHotkey: String/);
    expect(model).toContain('dict["quickComposeHotkey"] as? String');
  });
});
