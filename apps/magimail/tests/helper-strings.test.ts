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

describe('apps/magimail helper String Catalog', () => {
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

  it('carries Magimail’s own settings panes', () => {
    expect(keys(helper)).toEqual(
      expect.arrayContaining([
        'Magimail Preferences',
        'General',
        'Appearance',
        'Category Notification Levels',
        'Fetch Frequency',
        'Diagnostics',
        'Transparent background',
      ]),
    );
  });

  it('carries the menu bar tray, popover and context menu', () => {
    expect(keys(helper)).toEqual(
      expect.arrayContaining([
        'No accounts configured',
        'All caught up',
        'Nothing recent to show',
        'RECENT',
        'Open Inbox',
        'Search in',
        'Open in Magimail',
        'Mark as Read',
        'Mark as Unread',
      ]),
    );
  });

  it('carries the notification action titles', () => {
    expect(keys(helper)).toEqual(expect.arrayContaining(['Archive', 'Mark Read', 'Delete']));
  });

  it('carries the Focus Filter status line', () => {
    expect(keys(helper)).toEqual(
      expect.arrayContaining([
        'Inactive (All accounts active)',
        'Active: %lld accounts visible (others hidden)',
        'Active: %lld accounts active (others silenced)',
      ]),
    );
  });

  it('keeps a counted string as a plural variation', () => {
    const forms = helper.strings['%lld unread'].localizations?.en?.variations?.plural;
    expect(forms?.one.stringUnit.value).toBe('1 unread');
    expect(forms?.other.stringUnit.value).toBe('%lld unread');
  });

  it('leaves the widget gallery’s own sentences to the widget catalog', () => {
    // The helper compiles the widget views, but not the widget gallery or its
    // configuration intents, so only keys drawn from the former belong here.
    const widget: StringCatalog = JSON.parse(
      fs.readFileSync(path.join(APP_DIR, 'widgets/Resources/Localizable.xcstrings'), 'utf8'),
    );
    const widgetOnly = [
      'Inbox Dashboard',
      'Per-account unread counts with one-tap compose.',
      'Quick Actions',
      'Recents',
      'Unread',
      'Unread counts plus your latest threads.',
      'Unread totals across your accounts.',
      'Your most recent threads.',
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
      'Show color dots': 'Show colour dots',
    });
  });
});
