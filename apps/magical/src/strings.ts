import {
  createTranslator,
  createUiStringTemplate,
  validateUiStringsMap,
  type UiStringsMap,
  type UiTranslator,
} from '@magimail/core/ui-strings';
import rawMap from '../ui-strings.json';

/**
 * Magical's own user-visible strings: menus, dialogs and notification text.
 *
 * The data is `apps/magical/ui-strings.json`; this module only validates it and
 * hands out the translator. `docs/shared/ui-strings.md` defines the shape and
 * `validateUiStringsMap` is the runtime authority, so a problem in the file is a
 * defect thrown at load rather than a dialog that renders a key.
 */
const problems = validateUiStringsMap(rawMap);
if (problems.length > 0) {
  throw new Error(`apps/magical/ui-strings.json is invalid:\n${problems.join('\n')}`);
}

export const UI_STRINGS: UiStringsMap = rawMap as UiStringsMap;

let locale = 'en';

/**
 * Records the system language. `app.getLocale()` is only meaningful once the app
 * is ready, so the caller sets it there; until then the base language is used.
 */
export function setUiLocale(value: string): void {
  locale = value || 'en';
}

/** The string for a key, with `{name}` placeholders filled from `params`. */
export const uiString: UiTranslator = createTranslator(UI_STRINGS, () => locale);

/**
 * The raw template for a key, with `{name}` placeholders left intact, for a
 * surface that formats a placeholder only it knows — the native toolbar's
 * invitation count. The app's `ui-strings` test counts this as a reference, the
 * same as `uiString`.
 */
export const uiStringTemplate = createUiStringTemplate(UI_STRINGS, () => locale);
