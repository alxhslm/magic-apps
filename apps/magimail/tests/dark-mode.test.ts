import { describe, it, expect } from 'vitest';
import {
  DARK_MODE_MANIFEST,
  RESTORE_FILTER,
  getDarkModeCss,
  getLightModeCss,
  validateDarkModeManifest,
} from '../src/dark-mode.js';
import { DOM_ACTION_MAP } from '../src/dom-labels.js';

const valid = (overrides: Record<string, unknown>) => ({
  version: 1,
  restoreFilter: 'invert(1)',
  sections: {
    main: [
      {
        id: 'pageInvert',
        selectors: ['html'],
        dark: 'filter: {{restoreFilter}} !important;',
        light: 'filter: none !important;',
        ...overrides,
      },
    ],
  },
});

describe('validateDarkModeManifest', () => {
  it('accepts the shipped manifest against the action map it references', () => {
    expect(validateDarkModeManifest(DARK_MODE_MANIFEST, DOM_ACTION_MAP.actions)).toEqual([]);
  });

  it('rejects a rule with no light reset', () => {
    const problems = validateDarkModeManifest({
      version: 1,
      restoreFilter: 'invert(1)',
      sections: { main: [{ id: 'x', selectors: ['html'], dark: 'filter: none;' }] },
    });
    expect(problems.join('\n')).toContain('light must be a non-empty declaration block');
  });

  it('lets darkOnly stand in for a reset only with a note', () => {
    expect(
      validateDarkModeManifest(valid({ darkOnly: true, light: undefined })).join('\n'),
    ).toContain('must carry a note saying why');
    expect(
      validateDarkModeManifest(
        valid({ darkOnly: true, light: undefined, note: 'the anchor is inert in light' }),
      ),
    ).toEqual([]);
  });

  it('rejects a label placeholder that is not a label action', () => {
    const problems = validateDarkModeManifest(
      valid({ selectors: ['div:is({{label:nope}})'] }),
      DOM_ACTION_MAP.actions,
    );
    expect(problems.join('\n')).toContain('not a label action in dom-labels.json');
  });

  it('rejects an unknown placeholder', () => {
    const problems = validateDarkModeManifest(valid({ dark: 'filter: {{nope}};' }));
    expect(problems.join('\n')).toContain('unknown placeholder');
  });

  it('rejects a repeat id within a section', () => {
    const one = { id: 'x', selectors: ['html'], dark: 'filter: none;', light: 'filter: none;' };
    const problems = validateDarkModeManifest({
      version: 1,
      restoreFilter: 'invert(1)',
      sections: { main: [one, one] },
    });
    expect(problems.join('\n')).toContain('repeats "x"');
  });
});

describe('the manifest', () => {
  it('pairs every rule with its reset, or says why it needs none', () => {
    for (const [name, rules] of Object.entries(DARK_MODE_MANIFEST.sections)) {
      for (const rule of rules) {
        if (rule.darkOnly) {
          expect(
            rule.light,
            `${name}/${rule.id} is darkOnly and must not set light`,
          ).toBeUndefined();
          expect(rule.note, `${name}/${rule.id} is darkOnly and must say why`).toBeTruthy();
        } else {
          expect(rule.light, `${name}/${rule.id} has no light reset`).toBeTruthy();
        }
      }
    }
  });

  it('builds both frames from the data, resolving every placeholder', () => {
    for (const name of Object.keys(DARK_MODE_MANIFEST.sections)) {
      expect(getDarkModeCss(name), `${name} dark`).not.toContain('{{');
      expect(getLightModeCss(name), `${name} light`).not.toContain('{{');
    }
    expect(getDarkModeCss('main')).toContain(RESTORE_FILTER);
    expect(getDarkModeCss('main')).toContain('[aria-label="ask gemini" i]:lang(en)');
    expect(getDarkModeCss('subframe')).toContain('img, video, canvas, svg');
    expect(getLightModeCss('subframe')).toContain('filter: none !important;');
  });

  it('throws on a section it does not define', () => {
    expect(() => getDarkModeCss('nope')).toThrow('Unknown dark-mode section');
  });
});
