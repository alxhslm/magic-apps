/**
 * The app's own user-visible strings, as a validated catalogue.
 *
 * Everything the shell around Google's page says — menu labels, dialog text,
 * notification wording — is authored in a `ui-strings.json` per app rather than
 * written at the call site, so adding a language is a translation job rather
 * than an audit. This module holds the shape, the validation and the lookup
 * helpers; the data lives in each app's `ui-strings.json`.
 *
 * The shapes parallel `dom-labels.ts` on purpose. Strings are keyed by name and
 * each keys its locales the same way, so `en` is the base a catalogue is written
 * against and a regional key replaces it. The difference is what is being
 * resolved: `dom-labels.ts` resolves a control on Google's page from a label the
 * page renders, while this resolves a string this app renders itself.
 *
 * Only the Node side is covered here, plus the native toolbar, whose addon is a
 * dylib loaded into Electron with no bundle of its own: it receives the strings
 * this catalogue resolves over its JSON bridge. The Swift helper and the
 * OS-hosted extension bundles use a String Catalog, the mechanism macOS
 * localises with; see `docs/shared/ui-strings.md`.
 */

import { z } from 'zod';
import { baseLanguage, canonicalLocale, effectiveLocales } from './locale.js';

/** One string, keyed by locale: `{ "en": "File", "de": "Ablage" }`. */
export const uiStringSchema = z.record(z.string().min(1), z.string().min(1));
export type UiString = z.infer<typeof uiStringSchema>;

/**
 * A whole catalogue, as the compiler reads it. `UiStringsMap` is inferred from
 * this, so a rule stated here cannot drift from the type the compiler checks.
 */
export const uiStringsMapSchema = z
  .object({
    version: z.literal(1, { error: 'must be 1' }),
    strings: z.record(z.string().min(1), uiStringSchema),
  })
  .strict()
  .superRefine((map, ctx) => {
    for (const [key, entry] of Object.entries(map.strings)) {
      // English is the base every catalogue is written against, so a string with
      // only regional keys would never resolve. One en-based key is required.
      const hasEnglish = Object.entries(entry).some(
        ([locale, value]) => baseLanguage(locale) === 'en' && value.trim().length > 0,
      );
      if (!hasEnglish) {
        ctx.addIssue({
          code: 'custom',
          path: ['strings', key],
          message: 'must include an en-based key with a non-empty string',
        });
      }
    }
  });

export type UiStringsMap = z.infer<typeof uiStringsMapSchema>;

/** A translated lookup: the string for `key`, with placeholders filled in. */
export interface UiTranslator {
  (key: string, params?: Record<string, string | number>): string;
}

/** A lookup that returns a string's template with its `{name}` placeholders intact. */
export type UiTemplateReader = (key: string) => string;

/**
 * The string to render for a locale: the exact key (`en-GB`) when present,
 * otherwise the base language (`en`), otherwise nothing. The two are never
 * merged, so a regional key stands alone.
 */
export function resolveUiString(entry: UiString, locale: string): string | undefined {
  for (const want of effectiveLocales(locale)) {
    for (const [key, value] of Object.entries(entry)) {
      if (canonicalLocale(key) === want) return value;
    }
  }
  // English is the base every catalogue is written against, so a system language
  // with no translation of its own — or no entry for this string — reads English
  // rather than throwing. Unlike the DOM action map, this never picks the wrong
  // control: we are rendering our own string, not matching Google's.
  for (const [key, value] of Object.entries(entry)) {
    if (canonicalLocale(key) === 'en') return value;
  }
  for (const [key, value] of Object.entries(entry)) {
    if (baseLanguage(key) === 'en') return value;
  }
  return undefined;
}

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

/**
 * Fills `{name}` placeholders from `params`. A placeholder with no matching
 * parameter throws, so a string a translator can render is never shipped with a
 * literal `{name}` in it.
 */
export function formatUiString(
  template: string,
  params: Record<string, string | number> = {},
): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!(name in params)) {
      throw new Error(`Missing placeholder "${name}" for UI string "${template}"`);
    }
    return String(params[name]);
  });
}

/**
 * Builds the `t` a call site uses. The locale is read per call from
 * `getLocale`, so the translator does not have to be rebuilt when the app learns
 * the system language after `ready`.
 */
export function createTranslator(
  map: UiStringsMap,
  getLocale: () => string = () => 'en',
): UiTranslator {
  return (key, params) => formatUiString(resolveEntry(map, key, getLocale()), params);
}

/**
 * Builds a reader that returns a string's template with its `{name}`
 * placeholders left intact.
 *
 * A native surface formats a placeholder only it knows — an invitation count,
 * say — so it needs the template rather than a string already filled in. Named
 * placeholders stay named across the bridge, so a translator can still reorder
 * them.
 */
export function createUiStringTemplate(
  map: UiStringsMap,
  getLocale: () => string = () => 'en',
): UiTemplateReader {
  return (key) => resolveEntry(map, key, getLocale());
}

/** The effective text for a key, or a thrown error naming what went wrong. */
function resolveEntry(map: UiStringsMap, key: string, locale: string): string {
  const entry = map.strings[key];
  if (!entry) throw new Error(`Unknown UI string: ${key}`);
  const value = resolveUiString(entry, locale);
  if (value === undefined) {
    throw new Error(`UI string "${key}" has no string for locale "${locale}"`);
  }
  return value;
}

/** Picks the named strings out of a catalogue. Throws on a key the map does not define. */
export function pickUiStrings(
  map: UiStringsMap,
  keys: readonly string[],
): Record<string, UiString> {
  const picked: Record<string, UiString> = {};
  for (const key of keys) {
    const entry = map.strings[key];
    if (!entry) {
      throw new Error(`Unknown UI string key: ${key}`);
    }
    picked[key] = entry;
  }
  return picked;
}

/**
 * Validates a catalogue against `uiStringsMapSchema`.
 *
 * Returns every problem found, and an empty list when the map is valid, so an app
 * can validate its map at startup and fail loudly rather than at the first
 * dialog. The schema is the authority; this only renders its issues as the
 * `path message` lines callers have always read.
 */
export function validateUiStringsMap(map: unknown): string[] {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    return ['string map must be an object'];
  }
  const result = uiStringsMapSchema.safeParse(map);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = issue.path
      .map((segment) => (typeof segment === 'number' ? `[${segment}]` : segment))
      .join('.');
    return path ? `${path} ${issue.message}` : issue.message;
  });
}
