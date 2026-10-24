import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateStringCatalog, appIntentsMetadataKeys, type StringCatalog } from '@magimail/core';

const APP_DIR = path.resolve(__dirname, '..');

/** A parsed `.xcstrings`, read from the path that ships it. */
function catalog(relativePath: string): StringCatalog {
  return JSON.parse(fs.readFileSync(path.join(APP_DIR, relativePath), 'utf8'));
}

/** The keys a catalog defines, which are the English source strings. */
function keys(catalog: StringCatalog): string[] {
  return Object.keys(catalog.strings).sort();
}

describe('apps/magimail extension String Catalogs', () => {
  // Each `.appex` is its own bundle with its own resource namespace, so each
  // carries its own catalog. `docs/shared/ui-strings.md` records why.
  const widget = catalog('widgets/Resources/Localizable.xcstrings');
  const focusFilter = catalog('app-intents-extension/Resources/Localizable.xcstrings');

  it('validates both catalogs against the shared rules', () => {
    expect(validateStringCatalog(widget)).toEqual([]);
    expect(validateStringCatalog(focusFilter)).toEqual([]);
  });

  it('writes English as the base both catalogs are authored against', () => {
    expect(widget.sourceLanguage).toBe('en');
    expect(focusFilter.sourceLanguage).toBe('en');
  });

  it('names and describes every widget the extension offers', () => {
    expect(keys(widget)).toEqual(
      expect.arrayContaining([
        'Unread',
        'Unread totals across your accounts.',
        'Quick Actions',
        'Per-account unread counts with one-tap compose.',
        'Recents',
        'Your most recent threads.',
        'Inbox Dashboard',
        'Unread counts plus your latest threads.',
      ]),
    );
  });

  it('carries the labels the widget body draws', () => {
    expect(keys(widget)).toEqual(
      expect.arrayContaining([
        '%lld unread',
        'unread',
        'All caught up',
        'Open Magimail to sync',
        'RECENT',
        // Shared with the popover and notifications, which compile the same source.
        'Primary',
        'Social',
        'Promotions',
        'Updates',
        'Forums',
      ]),
    );
  });

  it('words a count as a plural variation rather than a second key', () => {
    const entry = widget.strings['%lld unread'];
    const forms = entry.localizations?.en?.variations?.plural;
    expect(forms?.one.stringUnit.value).toBe('1 unread');
    expect(forms?.other.stringUnit.value).toBe('%lld unread');
  });

  it('names the Focus Filter, its parameters and its subtitles', () => {
    expect(keys(focusFilter)).toEqual(
      expect.arrayContaining([
        'Filter Accounts',
        'Accounts',
        'Prevent Access to Silenced Accounts',
        'Magimail Account',
        'All Accounts',
        'Others silenced',
        'Others silenced and blocked',
      ]),
    );
  });

  it('keeps every App Intents metadata key in the catalog', () => {
    // The metadata is hand-written, so a key can drift from the Swift and the
    // catalog without anything failing; it then renders English for ever.
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(
          APP_DIR,
          'app-intents-extension/Resources/Metadata.appintents/extract.actionsdata',
        ),
        'utf8',
      ),
    );
    const declared = appIntentsMetadataKeys(metadata);
    expect(declared.length).toBeGreaterThan(0);
    for (const key of declared) {
      expect(keys(focusFilter), `metadata key not in the catalog: ${key}`).toContain(key);
    }
  });

  it('compiles each catalog into the bundle that ships it', () => {
    // The widget target compiles its catalog from the Xcode Resources phase; the
    // App Intents extension has no Xcode target, so it calls the shared helper.
    const widgetProject = fs.readFileSync(
      path.join(APP_DIR, 'widgets/MagimailWidgets.xcodeproj/project.pbxproj'),
      'utf8',
    );
    expect(widgetProject).toContain('Localizable.xcstrings in Resources');
    // The reference the phase names has to resolve to the file this test read.
    expect(widgetProject).toContain('path = Localizable.xcstrings');
    expect(widgetProject).toContain('path = Resources;');

    const intentsBuild = fs.readFileSync(
      path.join(APP_DIR, 'app-intents-extension/build.sh'),
      'utf8',
    );
    expect(intentsBuild).toContain('tools/localization.sh');
    expect(intentsBuild).toContain('compile_string_catalog');
  });

  it('localises the Share extension name through InfoPlist.strings', () => {
    const strings = fs.readFileSync(
      path.join(APP_DIR, 'share-extension/Resources/en.lproj/InfoPlist.strings'),
      'utf8',
    );
    expect(strings).toContain('"CFBundleDisplayName" = "Magimail"');

    const shareProject = fs.readFileSync(
      path.join(APP_DIR, 'share-extension/MagimailShare.xcodeproj/project.pbxproj'),
      'utf8',
    );
    expect(shareProject).toContain('InfoPlist.strings in Resources');
  });

  it('overrides only intended British English spellings in en-GB', () => {
    const gbStrings: Record<string, string> = {};
    for (const [key, entry] of Object.entries(focusFilter.strings)) {
      const gb = entry.localizations?.['en-GB']?.stringUnit?.value;
      if (gb !== undefined) gbStrings[key] = gb;
    }
    expect(gbStrings).toEqual({
      'Gray out silenced accounts so they cannot be opened.':
        'Grey out silenced accounts so they cannot be opened.',
    });
  });
});
