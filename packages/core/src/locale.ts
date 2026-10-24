/**
 * Locale keys, shared by the DOM action map and the UI string catalog.
 *
 * A key is a base language (`en`, `de`) or a language with a region (`en-GB`,
 * `en-US`, `de-DE`). Keys compare case-insensitively, with the language
 * lowercased and the region uppercased, and a regional key replaces the base
 * for the entries it covers rather than merging with it.
 *
 * Only the Node side lives here. The page-side resolver carries its own copy of
 * the same rules inside `DOM_DRIVE_PREAMBLE`, because a function shipped to a
 * page may not reference an import.
 */

/**
 * The base language of a locale key, so `en`, `en-GB` and `en-US` all read as
 * English.
 */
export function baseLanguage(locale: string): string {
  return locale.split(/[-_]/)[0].toLowerCase();
}

/**
 * Canonicalises a locale to `xx` or `xx-YY`, or `null` when it names no
 * language. The language subtag is lowercased and the region uppercased, so
 * `EN_gb` and `en-GB` compare equal.
 */
export function canonicalLocale(value: string): string | null {
  const parts = String(value ?? '')
    .trim()
    .toLowerCase()
    .split(/[-_]+/)
    .filter(Boolean);
  const language = parts[0];
  if (!language || !/^[a-z]{2,3}$/.test(language)) return null;
  const region = parts.slice(1).find((part) => /^[a-z]{2}$/.test(part) || /^[0-9]{3}$/.test(part));
  return region ? `${language}-${region.toUpperCase()}` : language;
}

/**
 * Normalises a page's `document.documentElement.lang`, or the system locale, to
 * `xx` or `xx-YY`, and defaults to `en` when it names no language.
 */
export function resolveLocale(locale: string): string {
  return canonicalLocale(locale) ?? 'en';
}

/**
 * The locale keys to try for a requested locale, most specific first: the
 * exact key (`en-GB`) and then the base (`en`). The two are never merged.
 */
export function effectiveLocales(locale: string): string[] {
  const resolved = resolveLocale(locale);
  const base = baseLanguage(resolved);
  return resolved === base ? [resolved] : [resolved, base];
}
