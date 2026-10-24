import { labelSelectors } from '@magimail/core';
import { z } from 'zod';
import raw from '../dark-mode.json';
import { DOM_ACTION_MAP, domAction } from './dom-labels.js';

/**
 * The dark-mode stylesheet as data.
 *
 * Gmail's dark mode is a set of selectors against a page Google changes without
 * notice, so the rules live in `apps/magimail/dark-mode.json` rather than in code:
 * a selector that stops matching is a data edit, not a rebuild of the stylesheet
 * module. This file defines the shape as a zod schema, infers the types from it,
 * and renders the stylesheets.
 *
 * Each rule pairs its `dark` declarations with the `light` block that undoes them,
 * because theme switching re-injects in place and a dark rule with no reset would
 * survive the switch. A rule that genuinely needs no reset says so with `darkOnly`
 * and a `note`. The schema rejects anything else, so the pairing cannot rot.
 *
 * Two placeholders are substituted at render time: `{{restoreFilter}}` for the
 * counter-invert, and `{{label:<action>}}` for the `:lang()`-scoped attribute
 * fragments of an action in `dom-labels.json`. The label clauses are the reason
 * the locale map is not copied into the stylesheet: there is one definition of
 * what Gmail calls a control, and the page-side resolver reads the same one.
 */

const PLACEHOLDER = /\{\{([^}]+)\}\}/g;

/** The slice of the action map the placeholder check needs: an action's labels. */
type LabelActions = Readonly<Record<string, { labels?: unknown }>>;

const darkModeRuleSchema = z
  .object({
    id: z.string().min(1),
    selectors: z.array(z.string().min(1)).min(1),
    /** The selectors the light reset targets, when they differ from `selectors`. */
    lightSelectors: z.array(z.string().min(1)).min(1).optional(),
    /** The declaration block applied in dark mode. */
    dark: z.string().min(1),
    /** The declaration block that undoes it in light mode. */
    light: z.string().min(1).optional(),
    /** Asserts the rule needs no light reset; the schema requires a `note`. */
    darkOnly: z.literal(true).optional(),
    /** Why the rule exists, emitted as a comment above it. */
    note: z.string().optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.darkOnly === true) {
      if (rule.light !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'sets both darkOnly and light' });
      } else if (rule.note === undefined) {
        ctx.addIssue({ code: 'custom', message: 'is darkOnly and must carry a note saying why' });
      }
    } else if (rule.light === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['light'],
        message: 'must be a non-empty declaration block, or set darkOnly: true',
      });
    }
  });

export type DarkModeRule = z.infer<typeof darkModeRuleSchema>;

const darkModeRulesSchema = z
  .array(darkModeRuleSchema)
  .min(1)
  .superRefine((rules, ctx) => {
    const seen = new Set<string>();
    rules.forEach((rule, index) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({ code: 'custom', path: [index], message: `repeats "${rule.id}"` });
      } else {
        seen.add(rule.id);
      }
    });
  });

const darkModeManifestSchema = z
  .object({
    version: z.literal(1, { error: 'must be 1' }),
    restoreFilter: z.string().min(1),
    sections: z.record(z.string().min(1), darkModeRulesSchema),
  })
  .strict();

export type DarkModeManifest = z.infer<typeof darkModeManifestSchema>;

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path
      .map((segment) => (typeof segment === 'number' ? `[${segment}]` : segment))
      .join('.');
    return path ? `${path} ${issue.message}` : issue.message;
  });
}

/**
 * Every `{{...}}` is either the filter or an action that exists in the app's map,
 * so a renamed or misspelled action fails at load rather than as a selector that
 * silently matches nothing.
 */
function placeholderProblems(manifest: DarkModeManifest, actions: LabelActions): string[] {
  const problems: string[] = [];
  const check = (text: string, path: string): void => {
    for (const match of text.matchAll(PLACEHOLDER)) {
      const token = match[1].trim();
      if (token === 'restoreFilter') continue;
      if (token.startsWith('label:')) {
        const key = token.slice('label:'.length).trim();
        if (!actions[key]?.labels) {
          problems.push(
            `${path} references {{label:${key}}}, which is not a label action in dom-labels.json`,
          );
        }
        continue;
      }
      problems.push(`${path} has an unknown placeholder {{${token}}}`);
    }
  };

  for (const [section, rules] of Object.entries(manifest.sections)) {
    rules.forEach((rule, index) => {
      const base = `sections.${section}[${index}]`;
      rule.selectors.forEach((selector, i) => check(selector, `${base}.selectors[${i}]`));
      rule.lightSelectors?.forEach((selector, i) =>
        check(selector, `${base}.lightSelectors[${i}]`),
      );
      check(rule.dark, `${base}.dark`);
      if (rule.light) check(rule.light, `${base}.light`);
    });
  }
  return problems;
}

/**
 * Validates a dark-mode manifest and returns every problem found, or an empty
 * list when it is valid. `actions` is the app's action map, so a `{{label:...}}`
 * reference is checked against the map the page-side resolver uses.
 */
export function validateDarkModeManifest(manifest: unknown, actions: LabelActions = {}): string[] {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return ['manifest must be an object'];
  }
  const result = darkModeManifestSchema.safeParse(manifest);
  if (!result.success) return formatIssues(result.error);
  return placeholderProblems(result.data, actions);
}

const problems = validateDarkModeManifest(raw, DOM_ACTION_MAP.actions);
if (problems.length > 0) {
  throw new Error(`apps/magimail/dark-mode.json is invalid:\n${problems.join('\n')}`);
}

export const DARK_MODE_MANIFEST: DarkModeManifest = darkModeManifestSchema.parse(raw);

/**
 * CSS filter chain to invert the page to dark mode. Counter-inversion restores
 * original colors on media elements. Adapted from
 * github.com/renefs/gmail-auto-dark-mode (MIT).
 */
export const RESTORE_FILTER = DARK_MODE_MANIFEST.restoreFilter;

function interpolate(text: string): string {
  return text
    .replace(/\{\{restoreFilter\}\}/g, RESTORE_FILTER)
    .replace(/\{\{label:([^}]+)\}\}/g, (_match, key: string) =>
      labelSelectors(domAction(key.trim())).join(', '),
    );
}

function renderRule(rule: DarkModeRule, theme: 'dark' | 'light'): string {
  const selectors = (theme === 'light' ? (rule.lightSelectors ?? rule.selectors) : rule.selectors)
    .map(interpolate)
    .join(',\n');
  const declarations = interpolate(theme === 'light' ? (rule.light ?? '') : rule.dark);
  const comment = rule.note ? `/* ${rule.note} */\n` : '';
  return `${comment}${selectors} {\n  ${declarations}\n}`;
}

function section(name: string): readonly DarkModeRule[] {
  const rules = DARK_MODE_MANIFEST.sections[name];
  if (!rules) throw new Error(`Unknown dark-mode section: ${name}`);
  return rules;
}

/** The dark stylesheet for a section, `main` (Gmail) or `subframe` (add-ons). */
export function getDarkModeCss(name: string): string {
  return section(name)
    .map((rule) => renderRule(rule, 'dark'))
    .join('\n');
}

/** The light reset for a section, undoing every dark rule in it. */
export function getLightModeCss(name: string): string {
  return section(name)
    .filter((rule) => !rule.darkOnly)
    .map((rule) => renderRule(rule, 'light'))
    .join('\n');
}
