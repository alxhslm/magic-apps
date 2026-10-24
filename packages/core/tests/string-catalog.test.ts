import { describe, it, expect } from 'vitest';
import { validateStringCatalog, appIntentsMetadataKeys } from '../src/string-catalog.js';

/** A minimal catalog both apps' extension bundles could ship. */
function catalog(overrides: Record<string, unknown> = {}) {
  return {
    sourceLanguage: 'en',
    version: '1.0',
    strings: {
      Unread: { extractionState: 'manual' },
      ...overrides,
    },
  };
}

describe('validateStringCatalog', () => {
  it('accepts a key with no localisation, which renders itself', () => {
    expect(validateStringCatalog(catalog())).toEqual([]);
  });

  it('accepts a regional variant of the source language without explicit source language entry', () => {
    const regionalOnly = catalog({
      'Color by account': {
        localizations: {
          'en-GB': { stringUnit: { state: 'translated', value: 'Colour by account' } },
        },
      },
    });
    expect(validateStringCatalog(regionalOnly)).toEqual([]);
  });

  it('accepts a plural variation that covers one and other', () => {
    const withPlural = catalog({
      '%lld unread': {
        extractionState: 'manual',
        localizations: {
          en: {
            variations: {
              plural: {
                one: { stringUnit: { state: 'translated', value: '1 unread' } },
                other: { stringUnit: { state: 'translated', value: '%lld unread' } },
              },
            },
          },
        },
      },
    });
    expect(validateStringCatalog(withPlural)).toEqual([]);
  });

  it('rejects a plural variation without both forms', () => {
    const onlyOne = catalog({
      '%lld unread': {
        localizations: {
          en: {
            variations: {
              plural: { one: { stringUnit: { state: 'translated', value: '1 unread' } } },
            },
          },
        },
      },
    });
    expect(validateStringCatalog(onlyOne)).toContainEqual(
      expect.stringContaining('needs both "one" and "other"'),
    );
  });

  it("requires the source language to be among a key's localisations", () => {
    const germanOnly = catalog({
      Unread: {
        localizations: { de: { stringUnit: { state: 'translated', value: 'Ungelesen' } } },
      },
    });
    expect(validateStringCatalog(germanOnly)).toContainEqual(
      expect.stringContaining('must include the source language "en"'),
    );
  });

  it('reports an unknown field rather than ignoring the typo', () => {
    const typo = catalog({ Unread: { extractionStates: 'manual' } });
    expect(validateStringCatalog(typo).length).toBeGreaterThan(0);
  });

  it('rejects anything that is not a catalog', () => {
    expect(validateStringCatalog(null)).toEqual(['string catalog must be an object']);
    expect(validateStringCatalog([])).toEqual(['string catalog must be an object']);
  });
});

describe('appIntentsMetadataKeys', () => {
  it('collects every key a nested App Intents document declares', () => {
    const metadata = {
      actions: { Filter: { title: { key: 'Filter Accounts' }, parameters: [{ name: 'a' }] } },
      entities: { Account: { displayTypeName: { key: 'Magimail Account' } } },
    };
    expect(appIntentsMetadataKeys(metadata).sort()).toEqual([
      'Filter Accounts',
      'Magimail Account',
    ]);
  });

  it('ignores a non-string key and a document with none', () => {
    expect(appIntentsMetadataKeys({ title: { key: 7 } })).toEqual([]);
    expect(appIntentsMetadataKeys(null)).toEqual([]);
  });
});
