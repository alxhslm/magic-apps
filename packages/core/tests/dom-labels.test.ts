import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { DOM_DRIVE_PREAMBLE } from '../src/dom.js';
import {
  labelMatches,
  labelSelectors,
  labelsFor,
  normalizeLabel,
  pickActions,
  validateDomActionMap,
  type DomActionMap,
} from '../src/dom-labels.js';
import { resolveLocale } from '../src/locale.js';

describe('DOM_DRIVE_PREAMBLE findAction contracts', () => {
  it('defines resolveOrdered, waitUntil, clickAndConfirm and findAction', () => {
    for (const name of ['resolveOrdered', 'waitUntil', 'clickAndConfirm', 'findAction']) {
      expect(DOM_DRIVE_PREAMBLE).toContain(name);
    }
  });

  it('tracks mutations using MutationObserver rather than fixed attempt counters', () => {
    expect(DOM_DRIVE_PREAMBLE).toContain('new MutationObserver');
    expect(DOM_DRIVE_PREAMBLE).not.toMatch(/attempts\s*<=\s*0/);
  });

  it('carries no generated identifier selector syntax', () => {
    expect(DOM_DRIVE_PREAMBLE).not.toContain('jsname');
    expect(DOM_DRIVE_PREAMBLE).not.toContain('jslog');
    expect(DOM_DRIVE_PREAMBLE).not.toContain('jsaction');
  });

  it('runs again in a context it has already been evaluated in', () => {
    const ctx = vm.createContext({ window: undefined as unknown } as object);
    (ctx as { window: unknown }).window = ctx;
    const script = `${DOM_DRIVE_PREAMBLE} typeof findAction;`;
    expect(vm.runInContext(script, ctx)).toBe('function');
    expect(vm.runInContext(script, ctx)).toBe('function');
  });
});

interface ElementSpec {
  name?: string;
  attrs?: Record<string, string>;
  text?: string;
  laidOut?: boolean;
  excluded?: boolean;
  children?: Record<string, unknown>;
  all?: unknown[];
}

function makeElement(spec: ElementSpec = {}) {
  const {
    name = 'el',
    attrs = {},
    text = '',
    laidOut = true,
    excluded = false,
    children = {},
    all = [],
  } = spec;
  return {
    name,
    nodeType: 1,
    offsetParent: laidOut ? {} : null,
    getClientRects: () => (laidOut ? [{}] : []),
    getAttribute: (attr: string) => (attr in attrs ? attrs[attr] : null),
    textContent: text,
    closest: (sel: string) => (excluded ? { sel } : null),
    querySelector: (sel: string) => (sel in children ? (children[sel] as unknown) : null),
    querySelectorAll: (sel: string) => (sel === '*' ? all : []),
  };
}

function makeRoot(
  children: Record<string, unknown> = {},
  all: unknown[] = [],
  lang = 'en',
  bySelector: Record<string, unknown[]> = {},
) {
  return {
    documentElement: { lang },
    querySelector: (sel: string) => (sel in children ? children[sel] : null),
    querySelectorAll: (sel: string) => (sel === '*' ? all : (bySelector[sel] ?? [])),
  };
}

function findActionIn(document: unknown, action: unknown) {
  const win: Record<string, unknown> = {
    document,
    Date,
    setTimeout,
    clearTimeout,
    Promise,
    Array,
    Object,
    String,
    TypeError,
  };
  win.window = win;
  win.__action = action;
  const ctx = vm.createContext(win);
  return vm.runInContext(`${DOM_DRIVE_PREAMBLE}\nfindAction(document, __action);`, ctx) as {
    el: { name: string } | null;
    via: string;
    matchedBy: string | null;
  };
}

describe('findAction resolution', () => {
  it('skips a hidden selector match for a later laid-out one', () => {
    const hidden = makeElement({ name: 'hidden', laidOut: false });
    const shown = makeElement({ name: 'shown' });
    const document = makeRoot({ '#hidden': hidden, '#shown': shown });

    const result = findActionIn(document, { selectors: ['#hidden', '#shown'] });

    expect(result.el).toBe(shown);
    expect(result.via).toBe('hook');
    expect(result.matchedBy).toBe('#shown');
  });

  it('restricts the search to the scope element', () => {
    const target = makeElement({ name: 'target' });
    const scope = makeElement({ name: 'scope', children: { '#target': target } });
    const elsewhere = makeElement({ name: 'elsewhere' });
    const document = makeRoot({ '#scope': scope, '#target': elsewhere });

    const result = findActionIn(document, { scope: '#scope', selectors: ['#target'] });

    expect(result.el).toBe(target);
  });

  it('ignores a selector match inside an excluded element', () => {
    const target = makeElement({ name: 'target', excluded: true });
    const document = makeRoot({ '#target': target });

    const result = findActionIn(document, {
      selectors: ['#target'],
      exclude: ['[role="dialog"]'],
    });

    expect(result.el).toBeNull();
    expect(result.via).toBe('none');
  });

  it('ignores a label match inside an excluded element', () => {
    const target = makeElement({
      name: 'target',
      attrs: { 'aria-label': 'Archive' },
      excluded: true,
    });
    const document = makeRoot({}, [target]);

    const result = findActionIn(document, {
      labels: { en: ['archive'] },
      exclude: ['[role="dialog"]'],
    });

    expect(result.via).toBe('none');
  });

  it('uses the exact regional key when the page language matches', () => {
    const bin = makeElement({ name: 'bin', attrs: { 'aria-label': 'Bin' } });
    const archive = makeElement({ name: 'archive', attrs: { 'aria-label': 'Archive' } });
    const document = makeRoot({}, [archive, bin], 'en-GB');

    const result = findActionIn(document, { labels: { en: ['Archive'], 'en-GB': ['Bin'] } });

    expect(result.el).toBe(bin);
    expect(result.via).toBe('label');
    expect(result.matchedBy).toBe('Bin');
  });

  it('does not match the base string when a regional key overrides it', () => {
    const archive = makeElement({ name: 'archive', attrs: { 'aria-label': 'Archive' } });
    const document = makeRoot({}, [archive], 'en-GB');

    const result = findActionIn(document, { labels: { en: ['Archive'], 'en-GB': ['Bin'] } });

    expect(result.via).toBe('none');
  });

  it('falls back to the base key when the page has no exact key', () => {
    const archive = makeElement({ name: 'archive', attrs: { 'aria-label': 'Archive' } });
    const document = makeRoot({}, [archive], 'en-GB');

    const result = findActionIn(document, { labels: { en: ['Archive'] } });

    expect(result.el).toBe(archive);
    expect(result.matchedBy).toBe('Archive');
  });

  it('never matches another language', () => {
    const german = makeElement({ name: 'de', attrs: { 'aria-label': 'Archivieren' } });
    const document = makeRoot({}, [german], 'en-GB');

    const result = findActionIn(document, {
      labels: { en: ['Archive'], de: ['Archivieren'] },
    });

    expect(result.via).toBe('none');
  });

  it('misses when the page language has no entry at all', () => {
    const archive = makeElement({ name: 'archive', attrs: { 'aria-label': 'Archive' } });
    const document = makeRoot({}, [archive], 'fr');

    const result = findActionIn(document, { labels: { en: ['Archive'] } });

    expect(result.via).toBe('none');
  });

  it('defaults to en when the page carries no lang', () => {
    const target = makeElement({ name: 'target', attrs: { 'aria-label': 'Archive' } });
    const document = makeRoot({}, [target]);
    (document.documentElement as { lang?: string }).lang = undefined;

    const result = findActionIn(document, { labels: { en: ['Archive'] } });

    expect(result.el).toBe(target);
  });

  it('matches a clean prefix against an attribute that carries a chord hint', () => {
    const target = makeElement({
      name: 'cc',
      attrs: { 'aria-label': 'Add Cc recipients ‪(⌘⇧C)‬' },
    });
    const document = makeRoot({}, [target]);

    const result = findActionIn(document, {
      labels: { en: ['add cc recipients'] },
      match: 'startsWith',
    });

    expect(result.el).toBe(target);
    expect(result.via).toBe('label');
  });

  it('matches textContent when no attribute carries the label', () => {
    const target = makeElement({ name: 'send', text: 'Send now' });
    const document = makeRoot({}, [target]);

    const result = findActionIn(document, { labels: { en: ['send'] }, match: 'contains' });

    expect(result.el).toBe(target);
  });

  it('consults every signal by default', () => {
    const byTitle = makeElement({ name: 'title', attrs: { title: 'Reply' } });
    const byTooltip = makeElement({ name: 'tooltip', attrs: { 'data-tooltip': 'Reply' } });

    expect(
      findActionIn(makeRoot({}, [byTitle]), { labels: { en: ['reply'] }, order: 'first' }).el,
    ).toBe(byTitle);
    expect(
      findActionIn(makeRoot({}, [byTooltip]), { labels: { en: ['reply'] }, order: 'first' }).el,
    ).toBe(byTooltip);
  });

  it('consults only the named attrs', () => {
    const textOnly = makeElement({ name: 'text', text: 'Reply' });
    const labelled = makeElement({
      name: 'labelled',
      attrs: { 'aria-label': 'Reply' },
      text: 'Reply',
    });

    // With attrs restricted to aria-label, a match on text alone is ignored.
    const textResult = findActionIn(makeRoot({}, [textOnly]), {
      labels: { en: ['reply'] },
      attrs: ['aria-label'],
      order: 'first',
    });
    expect(textResult.via).toBe('none');

    const labelledResult = findActionIn(makeRoot({}, [labelled]), {
      labels: { en: ['reply'] },
      attrs: ['aria-label'],
      order: 'first',
    });
    expect(labelledResult.el).toBe(labelled);
  });

  it('reports none when nothing matches', () => {
    const document = makeRoot();

    const result = findActionIn(document, { selectors: ['#missing'] });

    expect(result).toEqual({ el: null, via: 'none', matchedBy: null });
  });

  it('returns the last selector match in document order when order is last', () => {
    const older = makeElement({ name: 'older' });
    const newer = makeElement({ name: 'newer' });
    const document = makeRoot({}, [], 'en', { '[role="button"]': [older, newer] });

    const result = findActionIn(document, { selectors: ['[role="button"]'], order: 'last' });

    expect(result.el).toBe(newer);
    expect(result.via).toBe('hook');
    expect(result.matchedBy).toBe('[role="button"]');
  });

  it('skips a hidden last selector match when order is last', () => {
    const shown = makeElement({ name: 'shown' });
    const hidden = makeElement({ name: 'hidden', laidOut: false });
    const document = makeRoot({}, [], 'en', { '#reply': [shown, hidden] });

    const result = findActionIn(document, { selectors: ['#reply'], order: 'last' });

    expect(result.el).toBe(shown);
  });

  it('returns the last label match in document order when order is last', () => {
    const older = makeElement({ name: 'older', attrs: { 'aria-label': 'Reply' } });
    const newer = makeElement({ name: 'newer', attrs: { 'aria-label': 'Reply' } });
    const document = makeRoot({}, [older, newer]);

    const result = findActionIn(document, { labels: { en: ['reply'] }, order: 'last' });

    expect(result.el).toBe(newer);
    expect(result.via).toBe('label');
    expect(result.matchedBy).toBe('reply');
  });

  it('defaults to the first match', () => {
    const first = makeElement({ name: 'first' });
    const second = makeElement({ name: 'second' });
    const document = makeRoot({ '#reply': first }, [], 'en', { '#reply': [first, second] });

    const result = findActionIn(document, { selectors: ['#reply'] });

    expect(result.el).toBe(first);
  });

  it('resolves a single selector match under order only', () => {
    const only = makeElement({ name: 'only' });
    const document = makeRoot({}, [], 'en', { '#reply': [only] });

    const result = findActionIn(document, { selectors: ['#reply'], order: 'only' });

    expect(result.el).toBe(only);
    expect(result.via).toBe('hook');
  });

  it('reports ambiguous when order only finds two selector matches', () => {
    const first = makeElement({ name: 'first' });
    const second = makeElement({ name: 'second' });
    const document = makeRoot({}, [], 'en', { '#reply': [first, second] });

    const result = findActionIn(document, { selectors: ['#reply'], order: 'only' });

    expect(result).toEqual({ el: null, via: 'ambiguous', matchedBy: null });
  });

  it('treats a second match in the first selector as ambiguous rather than trying the next', () => {
    const a = makeElement({ name: 'a' });
    const b = makeElement({ name: 'b' });
    const c = makeElement({ name: 'c' });
    const document = makeRoot({}, [], 'en', { '#first': [a, b], '#second': [c] });

    const result = findActionIn(document, { selectors: ['#first', '#second'], order: 'only' });

    expect(result.via).toBe('ambiguous');
  });

  it('reports none when order only finds nothing', () => {
    const document = makeRoot({}, [], 'en', { '#reply': [] });

    const result = findActionIn(document, { selectors: ['#reply'], order: 'only' });

    expect(result).toEqual({ el: null, via: 'none', matchedBy: null });
  });

  it('resolves a single label match under order only', () => {
    const only = makeElement({ name: 'only', attrs: { 'aria-label': 'Reply' } });
    const document = makeRoot({}, [only]);

    const result = findActionIn(document, { labels: { en: ['reply'] }, order: 'only' });

    expect(result.el).toBe(only);
    expect(result.via).toBe('label');
  });

  it('reports ambiguous when order only finds two label matches', () => {
    const first = makeElement({ name: 'first', attrs: { 'aria-label': 'Reply' } });
    const second = makeElement({ name: 'second', attrs: { 'aria-label': 'Reply' } });
    const document = makeRoot({}, [first, second]);

    const result = findActionIn(document, { labels: { en: ['reply'] }, order: 'only' });

    expect(result).toEqual({ el: null, via: 'ambiguous', matchedBy: null });
  });
});

describe('normalizeLabel', () => {
  it('strips zero-width and bidi characters, collapses whitespace and lowercases', () => {
    const raw = '  Add   Cc\u200B\u202A recipients\u2069 \uFEFF';
    expect(normalizeLabel(raw)).toBe('add cc recipients');
  });
});

describe('labelMatches', () => {
  const labels = ['mark as read'];

  it('compares with exact, startsWith and contains', () => {
    expect(labelMatches('Mark as read', labels, 'exact')).toBe(true);
    expect(labelMatches('Mark as read (⌘⇧)', labels, 'exact')).toBe(false);
    expect(labelMatches('Mark as read (⌘⇧)', labels, 'startsWith')).toBe(true);
    expect(labelMatches('Please mark as read now', labels, 'contains')).toBe(true);
    expect(labelMatches('archive', labels, 'contains')).toBe(false);
  });
});

describe('resolveLocale', () => {
  it('normalises to xx or xx-YY and defaults to en', () => {
    expect(resolveLocale('en-GB')).toBe('en-GB');
    expect(resolveLocale('EN_gb')).toBe('en-GB');
    expect(resolveLocale('de')).toBe('de');
    expect(resolveLocale('de-DE')).toBe('de-DE');
    expect(resolveLocale('')).toBe('en');
    expect(resolveLocale('  ')).toBe('en');
  });
});

describe('labelsFor', () => {
  it('without a locale unions and normalises every key, without duplicates', () => {
    expect(
      labelsFor({
        labels: { en: ['Compose', 'compose'], fr: ['  Nouveau  Message '] },
        order: 'first',
      }),
    ).toEqual(['compose', 'nouveau message']);
  });

  it('without a locale dedupes case-insensitively across regional keys', () => {
    expect(
      labelsFor({ labels: { 'en-GB': ['Bin'], 'en-gb': ['bin'], en: ['Trash'] }, order: 'first' }),
    ).toEqual(['bin', 'trash']);
  });

  it('returns the exact key only when the locale matches it', () => {
    expect(
      labelsFor({ labels: { en: ['Archive'], 'en-GB': ['Bin'] }, order: 'first' }, 'en-GB'),
    ).toEqual(['bin']);
  });

  it('falls back to the base key when the exact key is absent', () => {
    expect(
      labelsFor({ labels: { en: ['Archive'], 'en-GB': ['Bin'] }, order: 'first' }, 'en-US'),
    ).toEqual(['archive']);
  });

  it('returns nothing for a language the action does not carry', () => {
    expect(labelsFor({ labels: { en: ['Archive'] }, order: 'first' }, 'fr')).toEqual([]);
  });

  it('normalises the locale it is given', () => {
    expect(labelsFor({ labels: { 'en-GB': ['Bin'] }, order: 'first' }, 'EN_gb')).toEqual(['bin']);
  });

  it('returns nothing when the action carries no labels', () => {
    expect(labelsFor({ selectors: ['[gh="cm"]'], order: 'first' })).toEqual([]);
  });
});

describe('pickActions', () => {
  const map: DomActionMap = {
    version: 1,
    actions: {
      compose: { selectors: ['[gh="cm"]'], order: 'only' },
      archive: { labels: { en: ['archive'] }, order: 'first' },
    },
  };

  it('returns only the named actions', () => {
    expect(Object.keys(pickActions(map, ['compose']))).toEqual(['compose']);
  });

  it('throws on an unknown key', () => {
    expect(() => pickActions(map, ['compose', 'nope'])).toThrow(/nope/);
  });
});

describe('validateDomActionMap', () => {
  it('accepts a valid map', () => {
    expect(
      validateDomActionMap({
        version: 1,
        actions: {
          compose: { selectors: ['[gh="cm"]'], order: 'only' },
          archive: {
            labels: { en: ['archive'], fr: ['archiver'] },
            match: 'startsWith',
            order: 'first',
          },
        },
      }),
    ).toEqual([]);
  });

  it('rejects an action with no order', () => {
    const problems = validateDomActionMap({
      version: 1,
      actions: { x: { selectors: ['#a'] } },
    });
    expect(problems.some((p) => p.includes('.order must be one of first, last, only'))).toBe(true);
  });

  it('rejects an action that sets both selectors and labels', () => {
    const problems = validateDomActionMap({
      version: 1,
      actions: { x: { selectors: ['#a'], labels: { en: ['a'] }, order: 'first' } },
    });
    expect(problems.some((p) => p.includes('exactly one of selectors or labels'))).toBe(true);
  });

  it('rejects an action that sets neither', () => {
    const problems = validateDomActionMap({ version: 1, actions: { x: { order: 'first' } } });
    expect(problems.some((p) => p.includes('exactly one of selectors or labels'))).toBe(true);
  });

  it('rejects labels with no en-based key', () => {
    const problems = validateDomActionMap({
      version: 1,
      actions: { x: { labels: { fr: ['archiver'], de: ['archivieren'] }, order: 'first' } },
    });
    expect(problems.some((p) => p.includes('must include an en-based key'))).toBe(true);
  });

  it('accepts an action keyed only under a regional English variant', () => {
    expect(
      validateDomActionMap({
        version: 1,
        actions: { bin: { labels: { 'en-GB': ['Bin'] }, order: 'first' } },
      }),
    ).toEqual([]);
  });

  it('accepts an en-based key alongside a non-English one', () => {
    expect(
      validateDomActionMap({
        version: 1,
        actions: {
          archive: { labels: { en: ['Archive'], 'de-DE': ['Archivieren'] }, order: 'first' },
        },
      }),
    ).toEqual([]);
  });

  it('rejects an unknown match mode', () => {
    const problems = validateDomActionMap({
      version: 1,
      actions: { x: { labels: { en: ['archive'] }, match: 'regex' } },
    });
    expect(problems.some((p) => p.includes('.match must be one of'))).toBe(true);
  });

  it('rejects match on a selector-only action and a wrong version', () => {
    const problems = validateDomActionMap({
      version: 2,
      actions: { x: { selectors: ['#a'], match: 'exact', order: 'first' } },
    });
    expect(problems.some((p) => p.includes('version must be 1'))).toBe(true);
    expect(problems.some((p) => p.includes('.match is only valid with labels'))).toBe(true);
  });

  it('accepts each order, orthogonal to the selectors-or-labels choice', () => {
    expect(
      validateDomActionMap({
        version: 1,
        actions: {
          a: { selectors: ['#a'], order: 'last' },
          b: { labels: { en: ['b'] }, order: 'first' },
          c: { labels: { en: ['c'] }, order: 'only' },
        },
      }),
    ).toEqual([]);
  });

  it('rejects an unknown order', () => {
    const problems = validateDomActionMap({
      version: 1,
      actions: { x: { selectors: ['#a'], order: 'middle' } },
    });
    expect(problems.some((p) => p.includes('.order must be one of first, last, only'))).toBe(true);
  });

  it('accepts a restricted attrs list', () => {
    expect(
      validateDomActionMap({
        version: 1,
        actions: { x: { labels: { en: ['a'] }, attrs: ['aria-label'], order: 'only' } },
      }),
    ).toEqual([]);
  });

  it('rejects an unknown attrs value', () => {
    const problems = validateDomActionMap({
      version: 1,
      actions: {
        x: { labels: { en: ['a'] }, attrs: ['aria-labelledby'], order: 'first' },
      },
    });
    expect(problems.some((p) => p.includes('.attrs must be one of'))).toBe(true);
  });

  it('rejects a repeated attrs value', () => {
    const problems = validateDomActionMap({
      version: 1,
      actions: {
        x: { labels: { en: ['a'] }, attrs: ['aria-label', 'aria-label'], order: 'first' },
      },
    });
    expect(problems.some((p) => p.includes('.attrs repeats'))).toBe(true);
  });
});

describe('labelSelectors', () => {
  it('emits one :lang-scoped fragment per attribute per label with the exact operator', () => {
    expect(labelSelectors({ labels: { en: ['compose'] }, order: 'first' })).toEqual([
      '[aria-label="compose" i]:lang(en)',
      '[data-tooltip="compose" i]:lang(en)',
      '[title="compose" i]:lang(en)',
    ]);
  });

  it('uses ^= for startsWith and *= for contains', () => {
    expect(
      labelSelectors({ labels: { en: ['compose'] }, match: 'startsWith', order: 'first' })[0],
    ).toBe('[aria-label^="compose" i]:lang(en)');
    expect(
      labelSelectors({ labels: { en: ['compose'] }, match: 'contains', order: 'first' })[0],
    ).toBe('[aria-label*="compose" i]:lang(en)');
  });

  it('emits only the overriding regional key for an action that has one', () => {
    expect(
      labelSelectors({ labels: { en: ['Archive'], 'en-GB': ['Bin'] }, order: 'first' }, [
        'aria-label',
      ]),
    ).toEqual(['[aria-label="bin" i]:lang(en-GB)']);
  });

  it('emits a :lang scope per language branch', () => {
    expect(
      labelSelectors({ labels: { en: ['Archive'], 'de-DE': ['Archivieren'] }, order: 'first' }, [
        'aria-label',
      ]),
    ).toEqual(['[aria-label="archive" i]:lang(en)', '[aria-label="archivieren" i]:lang(de-DE)']);
  });

  it('escapes embedded quotes and backslashes', () => {
    expect(
      labelSelectors({ labels: { en: ['say "hi"\\'] }, order: 'first' }, ['aria-label']),
    ).toEqual(['[aria-label="say \\"hi\\"\\\\" i]:lang(en)']);
  });

  it('returns nothing for a selector-only action', () => {
    expect(labelSelectors({ selectors: ['[gh="cm"]'], order: 'first' })).toEqual([]);
  });
});
