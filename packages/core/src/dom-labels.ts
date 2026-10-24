/**
 * Locale-aware DOM action resolution.
 *
 * Gmail and Calendar identify controls by English `aria-label`, `data-tooltip` and
 * text, which breaks on a non-English account. This module is the shared vocabulary
 * for the alternative: an action is matched either by a strong hook (a selector the
 * page implies, never a generated name) or by a set of localised labels, and the
 * resolver reports which layer matched so callers can log degradation.
 *
 * The data lives in `dom-labels.json`, authored per app; this module only holds the
 * types, the validation and the pure helpers. `DOM_DRIVE_PREAMBLE` in `dom.ts` carries
 * the page-side `findAction`, which consumes the same shapes.
 */

import { z } from 'zod';
import { baseLanguage, canonicalLocale, effectiveLocales } from './locale.js';

export type DomLabelMatch = 'exact' | 'startsWith' | 'contains';

const MATCH_MODES = ['exact', 'startsWith', 'contains'] as const;
const ORDERS = ['first', 'last', 'only'] as const;
const LABEL_ATTRS = ['aria-label', 'data-tooltip', 'title', 'text'] as const; // `text` means textContent

/**
 * The fields an action may carry. Written once so the type schema and the
 * validation schema below cannot describe different shapes.
 */
const domActionFields = {
  /** Selector for the search root. When absent the whole document is searched. */
  scope: z.string().min(1).optional(),
  /** Selectors whose subtree is skipped, so a match in a dialog is ignored. */
  exclude: z.array(z.string().min(1)).optional(),
  /** Strong-hook selectors. An action sets this or `labels`, never both. */
  selectors: z.array(z.string().min(1)).optional(),
  /**
   * Localised labels keyed by locale code. Keys are base (`en`) or regional
   * (`en-GB`). At least one `en`-based key is required.
   */
  labels: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
  /** How a label is compared. Defaults to `exact`, and only valid with `labels`. */
  match: z.enum(MATCH_MODES, { error: 'must be one of exact, startsWith, contains' }).optional(),
  /**
   * Which signals a label may match: `aria-label`, `data-tooltip`, `title` and
   * `text` (the element's text). Defaults to all four in that order. Restrict it
   * where Google mirrors one label into a tooltip and an inner node, so the match
   * stays on the control itself.
   */
  attrs: z.array(z.string()).optional(),
  /**
   * The caller's expectation for how many controls match, and which to resolve.
   * Required: `first` and `last` pick one end of the match set, `only` asserts a
   * single match and reports `ambiguous` when a second appears.
   */
  order: z.enum(ORDERS, { error: 'must be one of first, last, only' }),
};

/**
 * One entry in an action map, as the compiler reads it. `DomAction` is inferred
 * from this, so a rule stated here cannot drift from the type the compiler checks.
 */
/**
 * One entry in an action map, as the compiler reads it. `DomAction` is inferred
 * from this, so a rule stated here cannot drift from the type the compiler checks.
 *
 * `order` is required, so a map missing it reports that field and not the action's
 * cross-field problems: zod runs an attached check only once the object's own fields
 * parse. Clearing it and running again reports the rest.
 */
export const domActionSchema = z
  .object(domActionFields)
  .strict()
  .superRefine((action, ctx) => {
    const selectorCount = action.selectors?.length ?? 0;
    const labelCount = action.labels
      ? Object.values(action.labels).reduce((total, strings) => total + strings.length, 0)
      : 0;
    if (selectorCount > 0 === labelCount > 0) {
      ctx.addIssue({ code: 'custom', message: 'must set exactly one of selectors or labels' });
    }
    if (action.match !== undefined && action.labels === undefined) {
      ctx.addIssue({ code: 'custom', path: ['match'], message: 'is only valid with labels' });
    }
    if (action.labels) {
      const hasEnglish = Object.entries(action.labels).some(
        ([key, strings]) => baseLanguage(key) === 'en' && strings.length > 0,
      );
      if (!hasEnglish) {
        ctx.addIssue({
          code: 'custom',
          path: ['labels'],
          message: 'must include an en-based key with a non-empty array',
        });
      }
    }
    if (action.attrs) {
      if (action.attrs.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['attrs'], message: 'must be a non-empty array' });
      }
      const seen = new Set<string>();
      for (const attr of action.attrs) {
        if (!(LABEL_ATTRS as readonly string[]).includes(attr)) {
          ctx.addIssue({
            code: 'custom',
            path: ['attrs'],
            message: `must be one of ${LABEL_ATTRS.join(', ')}`,
          });
        } else if (seen.has(attr)) {
          ctx.addIssue({ code: 'custom', path: ['attrs'], message: `repeats ${attr}` });
        }
        seen.add(attr);
      }
    }
  });

export type DomAction = z.infer<typeof domActionSchema>;

/** An app's whole action map, as validated. */
export const domActionMapSchema = z
  .object({
    version: z.literal(1, { error: 'must be 1' }),
    actions: z.record(z.string().min(1), domActionSchema),
  })
  .strict();

export interface DomActionMap {
  version: 1;
  actions: Record<string, DomAction>;
}

const ZERO_WIDTH_AND_BIDI = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const DEFAULT_LABEL_ATTRS: readonly string[] = ['aria-label', 'data-tooltip', 'title'];

/**
 * Lowercases, trims, collapses internal whitespace and drops zero-width and bidi
 * control characters. The stored label stays a true prefix of the live attribute:
 * a trailing chord hint such as `(⌘⇧C)` is handled by `match`, not stripped here,
 * so the JS comparison and the CSS `[attr^=...]` fragment agree.
 */
export function normalizeLabel(value: string): string {
  return value.replace(ZERO_WIDTH_AND_BIDI, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Whether any of `labels` matches `value` under the given mode. */
export function labelMatches(
  value: string,
  labels: readonly string[],
  match: DomLabelMatch,
): boolean {
  const haystack = normalizeLabel(value);
  if (!haystack) return false;
  return labels.some((label) => {
    const needle = normalizeLabel(label);
    if (!needle) return false;
    if (match === 'startsWith') return haystack.startsWith(needle);
    if (match === 'contains') return haystack.includes(needle);
    return haystack === needle;
  });
}

function dedupeLabels(strings: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const string of strings) {
    const normalised = normalizeLabel(string);
    if (normalised && !seen.has(normalised)) {
      seen.add(normalised);
      out.push(normalised);
    }
  }
  return out;
}

/**
 * The normalised strings to match for an action. Without a locale, the union of
 * every key's strings, for validation and tooling. With one, the effective set:
 * the exact key (`en-GB`) when present, otherwise the base language (`en`),
 * otherwise nothing. The two are never merged, so a page never borrows another
 * language's strings and a regional key fully replaces the base for its action.
 */
export function labelsFor(action: DomAction, locale?: string): string[] {
  if (!action.labels) return [];
  if (locale === undefined) {
    const all: string[] = [];
    for (const strings of Object.values(action.labels)) all.push(...strings);
    return dedupeLabels(all);
  }
  for (const want of effectiveLocales(locale)) {
    for (const [key, value] of Object.entries(action.labels)) {
      if (canonicalLocale(key) === want) return dedupeLabels(value);
    }
  }
  return [];
}

/** Picks the named actions out of a map. Throws on a key the map does not define. */
export function pickActions(map: DomActionMap, keys: readonly string[]): Record<string, DomAction> {
  const picked: Record<string, DomAction> = {};
  for (const key of keys) {
    const action = map.actions[key];
    if (!action) {
      throw new Error(`Unknown DOM action key: ${key}`);
    }
    picked[key] = action;
  }
  return picked;
}

/**
 * Validates an action map against `domActionMapSchema`.
 *
 * Returns every problem found, and an empty list when the map is valid, so an app
 * can validate its map at startup and fail loudly rather than on the first miss.
 * The schema is the authority; this only renders its issues as the `path message`
 * lines callers have always read.
 */
export function validateDomActionMap(map: unknown): string[] {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    return ['action map must be an object'];
  }
  const result = domActionMapSchema.safeParse(map);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = issue.path
      .map((segment) => (typeof segment === 'number' ? `[${segment}]` : segment))
      .join('.');
    return path ? `${path} ${issue.message}` : issue.message;
  });
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Turns an action's labels into the CSS attribute-selector fragments an injected
 * stylesheet needs, so the stylesheet and the page-side resolver agree on a match.
 * Each fragment is scoped with `:lang()`, so the stylesheet only matches a page in
 * that language. Within a language a regional key overrides the base, so only the
 * effective key is emitted; one fragment per attribute per label.
 */
export function labelSelectors(
  action: DomAction,
  attrs: readonly string[] = DEFAULT_LABEL_ATTRS,
): string[] {
  if (!action.labels) return [];
  const match = action.match ?? 'exact';
  const operator = match === 'startsWith' ? '^=' : match === 'contains' ? '*=' : '=';

  const entries = Object.entries(action.labels)
    .map(([key, strings]) => ({ locale: canonicalLocale(key), strings }))
    .filter((entry): entry is { locale: string; strings: string[] } => entry.locale !== null);
  const overriddenBases = new Set(
    entries
      .filter((entry) => entry.locale !== baseLanguage(entry.locale))
      .map((entry) => baseLanguage(entry.locale)),
  );

  const fragments: string[] = [];
  for (const entry of entries) {
    const base = baseLanguage(entry.locale);
    if (entry.locale === base && overriddenBases.has(base)) continue;
    const scope = `:lang(${entry.locale})`;
    for (const attr of attrs) {
      for (const label of dedupeLabels(entry.strings)) {
        fragments.push(`[${attr}${operator}"${escapeAttributeValue(label)}" i]${scope}`);
      }
    }
  }
  return fragments;
}
