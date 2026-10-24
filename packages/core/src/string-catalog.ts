/**
 * The native surfaces' String Catalogue, as far as a test can check it.
 *
 * Every native target — the Swift helper, the widget, Share and App Intents
 * extension bundles — localises with a String Catalog (`.xcstrings`) rather than
 * the Node-side `ui-strings.ts`, because that is the mechanism macOS reads. The
 * catalog is a source file: Xcode compiles it into the `.strings` and
 * `.stringsdict` a running bundle loads, so a catalog that is malformed or never
 * wired into a target fails silently, falling back to its English keys.
 *
 * This module holds the shape and the validation those tests share. It is not
 * loaded by either app at runtime; the compiled catalogue is what ships. The
 * rules are the ones `docs/shared/ui-strings.md` states for the native side:
 * `en` is the base every catalog is written against, a key with no localisation
 * renders itself, and a count is worded with a plural variation rather than a
 * second key.
 */

import { z } from 'zod';

/** One rendered value: the string unit a bundle reads, with its translation state. */
export const stringUnitSchema = z.object({
  state: z.string().min(1),
  value: z.string().min(1),
});

/**
 * A plural variation, which is what a counted string needs. `one` and `other`
 * are required because a language that needs a third form still has these two;
 * String Catalog's other categories carry the rest. Each form is its own string
 * unit, exactly as Xcode writes it.
 */
export const pluralVariationSchema = z.object({
  plural: z
    .record(z.string().min(1), z.object({ stringUnit: stringUnitSchema }))
    .refine(
      (forms) => 'one' in forms && 'other' in forms,
      'a plural variation needs both "one" and "other"',
    ),
});

/** One language's rendering of a key: a plain unit, or a variation set. */
export const localizationSchema = z
  .object({
    stringUnit: stringUnitSchema.optional(),
    variations: pluralVariationSchema.optional(),
  })
  .refine(
    (entry) => entry.stringUnit !== undefined || entry.variations !== undefined,
    'a localization needs a stringUnit or a variations set',
  );

/** A key's entry: the source string itself, or the localisations that replace it. */
export const stringCatalogEntrySchema = z
  .object({
    extractionState: z.string().min(1).optional(),
    comment: z.string().optional(),
    localizations: z.record(z.string().min(1), localizationSchema).optional(),
  })
  .strict();

export const stringCatalogSchema = z
  .object({
    sourceLanguage: z.string().min(1),
    strings: z.record(z.string().min(1), stringCatalogEntrySchema),
    version: z.string().min(1),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    for (const [key, entry] of Object.entries(catalog.strings)) {
      // The source language is the base: a key localised only into another
      // language would never render on a system running that source language.
      // A key with no localizations at all is fine — it renders itself.
      // Regional variants of the source language (e.g. en-GB when source is en)
      // are also valid overrides since the key itself serves as the base source value.
      if (entry.localizations) {
        const hasSourceOrVariant = Object.keys(entry.localizations).some(
          (loc) => loc === catalog.sourceLanguage || loc.startsWith(`${catalog.sourceLanguage}-`),
        );
        if (!hasSourceOrVariant) {
          ctx.addIssue({
            code: 'custom',
            path: ['strings', key, 'localizations'],
            message: `must include the source language "${catalog.sourceLanguage}"`,
          });
        }
      }
    }
  });

export type StringCatalog = z.infer<typeof stringCatalogSchema>;
export type StringCatalogEntry = z.infer<typeof stringCatalogEntrySchema>;

/**
 * Every localisation key an App Intents `extract.actionsdata` declares.
 *
 * That metadata is hand-written for the App Intents extensions, which have no
 * Xcode target to generate it, and it names its own keys independently of the
 * Swift. A key that has drifted from the source resolves against the bundle's
 * catalog anyway, so a mismatch is not an error — it just renders English for
 * ever, or renders the wrong wording. A test compares these against the catalog.
 *
 * Walks the whole document rather than a fixed path, so a key in a node the
 * metadata gains later is still checked.
 */
export function appIntentsMetadataKeys(metadata: unknown): string[] {
  const keys: string[] = [];
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    for (const [field, child] of Object.entries(value)) {
      if (field === 'key' && typeof child === 'string') keys.push(child);
      else walk(child);
    }
  };
  walk(metadata);
  return keys;
}

/**
 * Validates a parsed `.xcstrings` and returns every problem as a `path message`
 * line, so an app's test reports one list rather than failing on the first.
 *
 * The expected use is `expect(validateStringCatalog(JSON.parse(read))).toEqual([])`,
 * which is also what pins the file's shape if it is ever rewritten by hand.
 */
export function validateStringCatalog(catalog: unknown): string[] {
  if (typeof catalog !== 'object' || catalog === null || Array.isArray(catalog)) {
    return ['string catalog must be an object'];
  }
  const result = stringCatalogSchema.safeParse(catalog);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = issue.path
      .map((segment) => (typeof segment === 'number' ? `[${segment}]` : segment))
      .join('.');
    return path ? `${path} ${issue.message}` : issue.message;
  });
}
