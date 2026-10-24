import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { DOM_DRIVE_PREAMBLE, labelSelectors, validateDomActionMap } from '@magimail/core';
import { DOM_ACTION_MAP, domAction } from '../src/dom-labels.js';

/** Every action the map defines, and the band it is expected to resolve through. */
const HOOK_ACTIONS = [
  'archive',
  'trash',
  'markRead',
  'markUnread',
  'refresh',
  'compose',
  'search',
  'sidePanel',
  'composeTo',
  'composeSubject',
  'composeBody',
  'composeCc',
  'composeBcc',
  'back',
] as const;

const LABEL_ACTIONS = [
  'addCc',
  'addBcc',
  'reply',
  'replyAll',
  'forward',
  'sidePanelToggle',
  'gemini',
  'quickSettings',
  'addOnTab',
  'adRowExact',
  'adRowPhrase',
] as const;

interface FakeElementSpec {
  attrs?: Record<string, string>;
  text?: string;
  laidOut?: boolean;
}

function fakeElement(spec: FakeElementSpec = {}) {
  const { attrs = {}, text = '', laidOut = true } = spec;
  return {
    nodeType: 1,
    offsetParent: laidOut ? {} : null,
    getClientRects: () => (laidOut ? [{}] : []),
    getAttribute: (attr: string) => (attr in attrs ? attrs[attr] : null),
    textContent: text,
    closest: () => null,
  };
}

function fakeRoot(
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

/** Run the page-side resolver against a fake document, the way the injected script does. */
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
    el: unknown;
    via: string;
    matchedBy: string | null;
  };
}

describe('dom-labels.json', () => {
  it('validates against the shared action-map rules', () => {
    expect(validateDomActionMap(DOM_ACTION_MAP)).toEqual([]);
  });

  it('names exactly the actions the code drives', () => {
    expect(Object.keys(DOM_ACTION_MAP.actions).sort()).toEqual(
      [...HOOK_ACTIONS, ...LABEL_ACTIONS].sort(),
    );
  });

  it('sets exactly one band per action: a hook or a label, never both', () => {
    for (const name of HOOK_ACTIONS) {
      const action = domAction(name);
      expect(action.selectors?.length, `${name} should carry selectors`).toBeGreaterThan(0);
      expect(action.labels, `${name} should not carry labels`).toBeUndefined();
    }
    for (const name of LABEL_ACTIONS) {
      const action = domAction(name);
      expect(action.labels?.en?.length, `${name} should carry en labels`).toBeGreaterThan(0);
      expect(action.selectors, `${name} should not carry selectors`).toBeUndefined();
    }
  });

  it('uses no generated name, class or id in a runtime selector', () => {
    for (const [name, action] of Object.entries(DOM_ACTION_MAP.actions)) {
      for (const selector of action.selectors ?? []) {
        expect(selector, `${name}: ${selector}`).not.toMatch(/jsname|jslog|jsaction|jscontroller/);
        expect(selector, `${name}: ${selector}`).not.toContain('.');
        expect(selector, `${name}: ${selector}`).not.toContain('#');
      }
    }
  });

  it('matches reply controls by the last of the per-message controls', () => {
    for (const name of ['reply', 'replyAll', 'forward']) {
      expect(domAction(name).order, name).toBe('last');
    }
  });

  it('uses startsWith for the labels Google appends a chord hint to', () => {
    expect(domAction('addCc').match).toBe('startsWith');
    expect(domAction('addBcc').match).toBe('startsWith');
  });

  it('uses contains only for the ad phrases, the add-on tab and the settings region', () => {
    // The bare "Ad"/"Sponsored" are exact: "ad" is a substring of "read", so a
    // `contains` match would hide every row (and the whole inbox).
    expect(domAction('adRowExact').match).toBeUndefined();
    expect(domAction('adRowPhrase').match).toBe('contains');
    expect(domAction('addOnTab').match).toBe('contains');
  });

  it('assigns an explicit order to every action', () => {
    for (const [name, action] of Object.entries(DOM_ACTION_MAP.actions)) {
      expect(['first', 'last', 'only'], `${name} must state an order`).toContain(action.order);
    }
  });

  it('claims uniqueness only where the page actually renders one control', () => {
    // `only` is asserted live, not guessed: an action that yields a second
    // laid-out match on the real page is downgraded to `first`.
    const expected: Record<string, 'first' | 'last' | 'only'> = {
      // Exactly one laid-out control on the live page.
      archive: 'only',
      trash: 'only',
      markRead: 'only',
      markUnread: 'only',
      refresh: 'only',
      compose: 'only',
      search: 'only',
      sidePanel: 'only',
      composeTo: 'only',
      composeSubject: 'only',
      composeBody: 'only',
      composeCc: 'only',
      composeBcc: 'only',
      addCc: 'only',
      addBcc: 'only',
      // One control per message, so the newest is the last of them.
      reply: 'last',
      replyAll: 'last',
      forward: 'last',
      // Several laid-out matches on the live page (a control and its tooltip, or
      // a wrapper whose text is the label) — verified ambiguous, so `first`.
      sidePanelToggle: 'first',
      gemini: 'first',
      quickSettings: 'first',
      // CSS-only; several matches are normal.
      addOnTab: 'first',
      adRowExact: 'first',
      adRowPhrase: 'first',
      back: 'only',
    };
    for (const [name, action] of Object.entries(DOM_ACTION_MAP.actions)) {
      expect(action.order, name).toBe(expected[name]);
    }
    expect(Object.keys(expected).sort()).toEqual(Object.keys(DOM_ACTION_MAP.actions).sort());
  });
});

describe('findAction resolution through the map', () => {
  it('resolves a hook action through the hook band', () => {
    const archive = fakeElement();
    const document = fakeRoot({}, [], 'en', { 'div[act="7"]': [archive] });

    const result = findActionIn(document, domAction('archive'));

    expect(result.el).toBe(archive);
    expect(result.via).toBe('hook');
    expect(result.matchedBy).toBe('div[act="7"]');
  });

  it('reports ambiguous when an only action has a second laid-out match', () => {
    const first = fakeElement();
    const second = fakeElement();
    const document = fakeRoot({}, [], 'en', { 'div[act="7"]': [first, second] });

    const result = findActionIn(document, domAction('archive'));

    expect(result.el).toBeNull();
    expect(result.via).toBe('ambiguous');
  });

  it('resolves a label action through the label band on an en-GB page', () => {
    const reply = fakeElement({ attrs: { 'aria-label': 'Reply' } });
    const document = fakeRoot({}, [reply], 'en-GB');

    const result = findActionIn(document, domAction('reply'));

    expect(result.el).toBe(reply);
    expect(result.via).toBe('label');
  });

  it('resolves the last label match for reply, the newest message', () => {
    const older = fakeElement({ attrs: { 'aria-label': 'Reply' } });
    const newer = fakeElement({ attrs: { 'aria-label': 'Reply' } });
    const document = fakeRoot({}, [older, newer], 'en-GB');

    const result = findActionIn(document, domAction('reply'));

    expect(result.el).toBe(newer);
  });

  it('matches the Add Cc label against the live chord-hint suffix', () => {
    const cc = fakeElement({ attrs: { 'aria-label': 'Add Cc recipients ‪(⌘⇧C)‬' } });
    const document = fakeRoot({}, [cc], 'en-GB');

    expect(findActionIn(document, domAction('addCc')).el).toBe(cc);
  });

  it('reports none for a label action off English', () => {
    const reply = fakeElement({ attrs: { 'aria-label': 'Répondre' } });
    const document = fakeRoot({}, [reply], 'fr');

    expect(findActionIn(document, domAction('reply')).via).toBe('none');
  });
});

describe('labelSelectors for the map', () => {
  it('emits :lang()-scoped fragments for every attribute a label can land on', () => {
    const fragments = labelSelectors(domAction('gemini'));

    expect(fragments).toContain('[aria-label="ask gemini" i]:lang(en)');
    expect(fragments).toContain('[data-tooltip="ask gemini" i]:lang(en)');
    expect(fragments).toContain('[title="ask gemini" i]:lang(en)');
  });

  it('uses the operator that matches the action match mode', () => {
    expect(labelSelectors(domAction('addCc'))).toContain(
      '[aria-label^="add cc recipients" i]:lang(en)',
    );
    expect(labelSelectors(domAction('adRowPhrase'))).toContain(
      '[aria-label*="ad info" i]:lang(en)',
    );
    expect(labelSelectors(domAction('adRowExact'))).toContain('[aria-label="ad" i]:lang(en)');
  });
});
