import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateStringCatalog, type StringCatalog } from '@magimail/core';

const APP_DIR = path.resolve(__dirname, '..');
const CATALOG_PATH = 'swift/Resources/Localizable.xcstrings';

/** The helper's String Catalog, read from the path that ships it. */
function catalog(): StringCatalog {
  return JSON.parse(fs.readFileSync(path.join(APP_DIR, CATALOG_PATH), 'utf8'));
}

/** The keys a catalog defines, which are the English source strings. */
function keys(catalog: StringCatalog): string[] {
  return Object.keys(catalog.strings).sort();
}

describe('apps/magical helper String Catalog', () => {
  const helper = catalog();

  it('validates against the shared rules', () => {
    expect(validateStringCatalog(helper)).toEqual([]);
  });

  it('writes English as the base it is authored against', () => {
    expect(helper.sourceLanguage).toBe('en');
  });

  it('carries the settings chrome the two apps share', () => {
    // HelperUI holds no catalog of its own, so its sentences resolve against the
    // app bundle the helper runs inside. docs/shared/ui-strings.md records why.
    expect(keys(helper)).toEqual(
      expect.arrayContaining([
        'Add an account',
        'Remove the selected account',
        'Reset Session…',
        'Sign the selected account out of Google',
        'Reset the session for “%@”?',
        'Signs this account out of Google and clears its cookies. Other accounts are untouched.',
        'Reset',
        'Drag to reorder',
        'Account name',
        'Sign in required',
        'Remove Account',
        'Use %@',
        'Only the installed app can be the default reader',
        '%@ is the default reader',
        'No default reader',
      ]),
    );
  });

  it('carries Magical’s own settings panes', () => {
    expect(keys(helper)).toEqual(
      expect.arrayContaining([
        'Magical Settings',
        'General',
        'Appearance',
        'Meeting alerts',
        'Alerts by calendar',
        'Joining calls',
        'Color by account',
      ]),
    );
  });

  it('carries the menu bar tray, popover and agenda', () => {
    expect(keys(helper)).toEqual(
      expect.arrayContaining([
        'No accounts configured',
        'No events scheduled',
        'Filter Calendars',
        'Show All Calendars',
        'Last synced %@',
        'Open Calendar',
        'Reply needed',
        'Awaiting your reply',
      ]),
    );
  });

  it('carries the thread and event context menus', () => {
    expect(keys(helper)).toEqual(
      expect.arrayContaining([
        'Open in Magical',
        'Mark Complete',
        'Copy Event Link',
        'Delete Task',
        'Delete “%@”?',
      ]),
    );
  });

  it('carries the notification action titles', () => {
    expect(keys(helper)).toEqual(
      expect.arrayContaining(['Join Call', 'Snooze 5m', 'Yes', 'Maybe', 'No']),
    );
  });

  it('carries the countdown phrasing on both sides of the hour', () => {
    expect(keys(helper)).toEqual(
      expect.arrayContaining([
        'Now',
        'NOW',
        'IN %lld MIN',
        'IN 1 HR',
        'IN %lld HRS',
        'IN 1 HR 1 MIN',
        'IN %lld HRS %lld MINS',
      ]),
    );
  });

  it('keeps a counted string as a plural variation', () => {
    const forms = helper.strings['IN %lld MINS'].localizations?.en?.variations?.plural;
    expect(forms?.one.stringUnit.value).toBe('IN 1 MIN');
    expect(forms?.other.stringUnit.value).toBe('IN %lld MINS');
  });

  it('leaves the widget gallery’s own sentences to the widget catalog', () => {
    // The helper compiles the widget views, but not the widget gallery or its
    // configuration intents, so only keys drawn from the former belong here.
    const widget: StringCatalog = JSON.parse(
      fs.readFileSync(path.join(APP_DIR, 'widgets/Resources/Localizable.xcstrings'), 'utf8'),
    );
    const widgetOnly = [
      "A month grid with today's events.",
      'Agenda',
      'Calendars',
      'Choose Calendars',
      'Choose which calendars this widget shows. It starts with the ones the menu bar shows.',
      'Month',
      'Up Next',
      'Your next event and a button to join it.',
      'Your next few days of events.',
    ];
    for (const key of widgetOnly) {
      expect(keys(widget)).toContain(key);
      expect(keys(helper)).not.toContain(key);
    }
  });

  it('compiles the catalog into the app bundle the helper runs inside', () => {
    // The helper is a bare executable at Contents/MacOS, so Bundle.main is the
    // app; its catalog has to be compiled and copied into Contents/Resources.
    const build = fs.readFileSync(path.join(APP_DIR, 'swift/build.sh'), 'utf8');
    expect(build).toContain('tools/localization.sh');
    expect(build).toContain('compile_string_catalog');
    expect(build).toContain('HelperResources');

    const builder = JSON.parse(
      fs.readFileSync(path.join(APP_DIR, 'electron-builder.json'), 'utf8'),
    );
    const sources = (builder.extraResources ?? []).map((entry: { from: string }) => entry.from);
    expect(sources).toContain('swift/.build/release/HelperResources');

    const app = fs.readFileSync(path.join(APP_DIR, 'scripts/build-app.sh'), 'utf8');
    expect(app).toContain('Contents/Resources/en.lproj/Localizable.strings');
    expect(app).toContain('Contents/Resources/en-GB.lproj/Localizable.strings');
  });

  it('overrides only intended British English spellings in en-GB', () => {
    const gbStrings: Record<string, string> = {};
    for (const [key, entry] of Object.entries(helper.strings)) {
      const gb = entry.localizations?.['en-GB']?.stringUnit?.value;
      if (gb !== undefined) gbStrings[key] = gb;
    }
    expect(gbStrings).toEqual({
      'Color by account': 'Colour by account',
      'macOS does not recognize that file type': 'macOS does not recognise that file type',
    });
  });
});
