import { describe, it, expect } from 'vitest';
import {
  createTranslator,
  createUiStringTemplate,
  formatUiString,
  pickUiStrings,
  resolveUiString,
  validateUiStringsMap,
  type UiStringsMap,
} from '../src/ui-strings.js';
import { baseLanguage, canonicalLocale, effectiveLocales, resolveLocale } from '../src/locale.js';

describe('locale keys', () => {
  it('reads the base language of every regional key', () => {
    expect(baseLanguage('en')).toBe('en');
    expect(baseLanguage('en-GB')).toBe('en');
    expect(baseLanguage('DE_de')).toBe('de');
  });

  it('canonicalises case and separator to xx or xx-YY', () => {
    expect(canonicalLocale('EN_gb')).toBe('en-GB');
    expect(canonicalLocale('de')).toBe('de');
    expect(canonicalLocale('pt-BR')).toBe('pt-BR');
    expect(canonicalLocale('not a locale')).toBeNull();
    expect(canonicalLocale('')).toBeNull();
  });

  it('defaults to en when the locale names no language', () => {
    expect(resolveLocale('')).toBe('en');
    expect(resolveLocale('')).toBe('en');
    expect(resolveLocale('fr-CA')).toBe('fr-CA');
  });

  it('tries the exact key before the base, and never merges them', () => {
    expect(effectiveLocales('en')).toEqual(['en']);
    expect(effectiveLocales('en-GB')).toEqual(['en-GB', 'en']);
  });
});

describe('validateUiStringsMap', () => {
  it('accepts a catalogue whose entries each carry an en-based key', () => {
    expect(
      validateUiStringsMap({
        version: 1,
        strings: {
          'menu.file': { en: 'File', de: 'Ablage' },
          'menu.print': { en: 'Print…' },
        },
      }),
    ).toEqual([]);
  });

  it('accepts an en-GB key as the English base', () => {
    expect(
      validateUiStringsMap({ version: 1, strings: { 'menu.bin': { 'en-GB': 'Bin' } } }),
    ).toEqual([]);
  });

  it('reports a string with no English at all', () => {
    const problems = validateUiStringsMap({
      version: 1,
      strings: { greeting: { de: 'Hallo' } },
    });
    expect(problems).toEqual([
      'strings.greeting must include an en-based key with a non-empty string',
    ]);
  });

  it('reports an empty English string', () => {
    const problems = validateUiStringsMap({ version: 1, strings: { blank: { en: '   ' } } });
    expect(problems).toHaveLength(1);
  });

  it('rejects a version that is not 1', () => {
    expect(validateUiStringsMap({ version: 2, strings: {} })).toEqual(['version must be 1']);
  });

  it('reports an unknown field rather than ignoring it', () => {
    const problems = validateUiStringsMap({ version: 1, strings: {}, note: 'typo' });
    expect(problems.some((problem) => problem.includes('note'))).toBe(true);
  });

  it('reports a map that is not an object', () => {
    expect(validateUiStringsMap(null)).toEqual(['string map must be an object']);
    expect(validateUiStringsMap([])).toEqual(['string map must be an object']);
  });
});

describe('resolveUiString', () => {
  const entry = { en: 'File', 'en-GB': 'File', de: 'Ablage' };

  it('prefers the exact key', () => {
    expect(resolveUiString(entry, 'de-DE')).toBe('Ablage');
  });

  it('falls back to the base language', () => {
    expect(resolveUiString(entry, 'en-US')).toBe('File');
  });

  it('falls back to the English base for a language the entry does not carry', () => {
    expect(resolveUiString(entry, 'fr')).toBe('File');
    expect(resolveUiString(entry, 'fr-CA')).toBe('File');
  });

  it('prefers a translated base over English', () => {
    expect(resolveUiString(entry, 'de-AT')).toBe('Ablage');
  });

  it('accepts an en-GB key as the English fallback', () => {
    expect(resolveUiString({ 'en-GB': 'Bin' }, 'fr')).toBe('Bin');
  });
});

describe('formatUiString', () => {
  it('fills named placeholders', () => {
    expect(formatUiString('In {count} minutes', { count: 5 })).toBe('In 5 minutes');
  });

  it('fills every occurrence', () => {
    expect(formatUiString('{word} and {word}', { word: 'again' })).toBe('again and again');
  });

  it('leaves a template with no placeholders alone', () => {
    expect(formatUiString('File')).toBe('File');
  });

  it('throws rather than shipping a literal placeholder', () => {
    expect(() => formatUiString('In {count} minutes')).toThrow('Missing placeholder "count"');
  });
});

describe('createTranslator', () => {
  const map: UiStringsMap = {
    version: 1,
    strings: {
      'menu.file': { en: 'File', de: 'Ablage' },
      'notification.lead': { en: 'In {count} minutes' },
    },
  };

  it('defaults to the base language', () => {
    expect(createTranslator(map)('menu.file')).toBe('File');
  });

  it('reads the locale from the provider on each call', () => {
    let locale = 'en';
    const t = createTranslator(map, () => locale);
    expect(t('menu.file')).toBe('File');
    locale = 'de';
    expect(t('menu.file')).toBe('Ablage');
  });

  it('fills placeholders', () => {
    expect(createTranslator(map)('notification.lead', { count: 3 })).toBe('In 3 minutes');
  });

  it('throws on a key the catalogue does not define', () => {
    expect(() => createTranslator(map)('menu.missing')).toThrow('Unknown UI string: menu.missing');
  });

  it('renders English for a system language it has not been translated into', () => {
    const t = createTranslator(map, () => 'fr');
    expect(t('menu.file')).toBe('File');
  });
});

describe('createUiStringTemplate', () => {
  const map: UiStringsMap = {
    version: 1,
    strings: {
      'menu.file': { en: 'File', de: 'Ablage' },
      'toolbar.count': { en: '{count} waiting' },
    },
  };

  it('leaves placeholders for the caller to fill', () => {
    expect(createUiStringTemplate(map)('toolbar.count')).toBe('{count} waiting');
  });

  it('reads the locale from the provider on each call', () => {
    let locale = 'en';
    const template = createUiStringTemplate(map, () => locale);
    expect(template('menu.file')).toBe('File');
    locale = 'de';
    expect(template('menu.file')).toBe('Ablage');
  });

  it('throws on a key the catalogue does not define', () => {
    expect(() => createUiStringTemplate(map)('menu.missing')).toThrow(
      'Unknown UI string: menu.missing',
    );
  });
});

describe('pickUiStrings', () => {
  const map: UiStringsMap = {
    version: 1,
    strings: { a: { en: 'A' }, b: { en: 'B' } },
  };

  it('picks the named strings', () => {
    expect(pickUiStrings(map, ['b'])).toEqual({ b: { en: 'B' } });
  });

  it('throws on a key the catalogue does not define', () => {
    expect(() => pickUiStrings(map, ['c'])).toThrow('Unknown UI string key: c');
  });
});
