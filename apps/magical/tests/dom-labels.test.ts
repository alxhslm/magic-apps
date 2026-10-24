import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { DOM_DRIVE_PREAMBLE, labelSelectors, validateDomActionMap } from '@magimail/core';
import { DOM_ACTION_MAP, domAction } from '../src/dom-labels.js';

/** Every action the map defines that resolves through a strong hook. */
const HOOK_ACTIONS = [
  'create',
  'createEvent',
  'createTask',
  'addTaskButton',
  'searchInput',
  'closeEventDialog',
  'deleteEvent',
  'confirmScope',
  'scopeInstance',
  'rsvpYes',
  'rsvpNo',
  'rsvpMaybe',
  'sidePanel',
] as const;

/** Every action the map defines that resolves through a localised label. */
const LABEL_ACTIONS = [
  'addTaskField',
  'searchButton',
  'today',
  'navPrev',
  'navNext',
  'back',
  'settings',
  'tasksTab',
] as const;

/**
 * The authored ids the map is allowed to carry.
 *
 * Google's own client reads these `x…Bu` ids, so they are in the strong-hook band even
 * though they look generated; `jsname`, the values inside `jsaction`, `jscontroller`,
 * classes and generated ids are not, and the test below keeps them out.
 */
const AUTHORED_IDS = [
  '#xDetDlgCloseBu',
  '#xDetDlgDelBu',
  '#xRsvpYesBu',
  '#xRsvpNoBu',
  '#xRsvpMaybeBu',
];

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

  it('uses only semantic hooks and authored ids, never a generated name or class', () => {
    for (const [name, action] of Object.entries(DOM_ACTION_MAP.actions)) {
      for (const selector of action.selectors ?? []) {
        expect(selector, `${name}: ${selector}`).not.toMatch(/jsname|jslog|jsaction|jscontroller/);
        expect(selector, `${name}: ${selector}`).not.toContain('.');
        const id = selector.startsWith('#') ? selector.split('[')[0] : null;
        if (id) expect(AUTHORED_IDS, `${name}: ${selector}`).toContain(id);
      }
      for (const selector of action.exclude ?? []) {
        expect(selector, `${name} exclude: ${selector}`).not.toMatch(
          /jsname|jslog|jsaction|jscontroller/,
        );
      }
    }
  });

  it('assigns an explicit order to every action', () => {
    for (const [name, action] of Object.entries(DOM_ACTION_MAP.actions)) {
      expect(['first', 'last', 'only'], `${name} must state an order`).toContain(action.order);
    }
  });

  it('claims uniqueness only where the live page renders one control', () => {
    // `only` is asserted live, not guessed. Every `only` action below resolved to exactly
    // one laid-out match on a signed-in calendar, including the four nav labels, which
    // name `aria-label` as their only signal so the tooltip and inner span Google mirrors
    // the label into no longer count. The Tasks pair was measured the same way: the entry
    // is a Material button with no id and no accessible name, reached through the list's
    // `data-shown-add-task-btn` container, and it reveals the field `aria-label="Task
    // title"`, read as `first` because the entry can match more than one element while it
    // animates. `first` is otherwise declaratory, for the two CSS-only actions.
    const expected: Record<string, 'first' | 'last' | 'only'> = {
      create: 'only',
      createEvent: 'only',
      createTask: 'only',
      addTaskButton: 'only',
      addTaskField: 'first',
      searchInput: 'only',
      back: 'only',
      closeEventDialog: 'only',
      deleteEvent: 'only',
      confirmScope: 'only',
      scopeInstance: 'first',
      rsvpYes: 'only',
      rsvpNo: 'only',
      rsvpMaybe: 'only',
      searchButton: 'only',
      today: 'only',
      navPrev: 'only',
      navNext: 'only',
      settings: 'first',
      sidePanel: 'first',
      tasksTab: 'first',
    };
    for (const [name, action] of Object.entries(DOM_ACTION_MAP.actions)) {
      expect(action.order, name).toBe(expected[name]);
    }
    expect(Object.keys(expected).sort()).toEqual(Object.keys(DOM_ACTION_MAP.actions).sort());
  });

  it('matches the dynamic Today aria-label by prefix rather than the whole date', () => {
    expect(domAction('today').match).toBe('startsWith');
  });

  it('restricts the label actions to the aria-label signal', () => {
    // Calendar mirrors each nav button's name into a [role="tooltip"] and an inner span, so
    // matching text as well made an action unique by aria-label report ambiguous. Naming
    // only `aria-label` keeps the match on the control. `settings` joined this list late:
    // without it the default set includes `text`, and `contains "Settings"` matched the whole
    // page through its screen-reader text instead of the control.
    for (const name of ['searchButton', 'today', 'navPrev', 'navNext', 'back', 'settings']) {
      expect(domAction(name).attrs, `${name} should name its signal`).toEqual(['aria-label']);
    }
    // The nav actions render exactly one laid-out control. The settings label also names the
    // region its CSS clause targets, so its order stays `first`.
    for (const name of ['searchButton', 'today', 'navPrev', 'navNext', 'back']) {
      expect(domAction(name).order, name).toBe('only');
    }
  });

  it('makes the day arrows view-agnostic and excludes the mini-month navigator', () => {
    // The toolbar arrow reads "Previous day", "Previous week", "Previous month" or
    // "Previous year" with the view, so the whole day-specific label resolved to nothing
    // outside day view. The prefix matches every view. The mini-month picker inside
    // `#drawerMiniMonthNavigator` also renders "Previous month"/"Next month", so it is
    // excluded to keep `only` on the toolbar button.
    for (const [name, label] of [
      ['navPrev', 'Previous'],
      ['navNext', 'Next'],
    ] as const) {
      const action = domAction(name);
      expect(action.labels?.en).toEqual([label]);
      expect(action.match).toBe('startsWith');
      expect(action.exclude).toEqual(['#drawerMiniMonthNavigator']);
    }
  });
});

describe('findAction resolution through the map', () => {
  it('resolves a scoped hook action through the hook band', () => {
    const button = fakeElement({ attrs: { 'aria-haspopup': 'menu' } });
    const scope = {
      querySelectorAll: (sel: string) => (sel === '[aria-haspopup="menu"]' ? [button] : []),
    };
    const document = fakeRoot({ '[data-is-drawer-closed]': scope });

    const result = findActionIn(document, domAction('create'));

    expect(result.el).toBe(button);
    expect(result.via).toBe('hook');
    expect(result.matchedBy).toBe('[aria-haspopup="menu"]');
  });

  it('reports ambiguous when an only action has a second laid-out match', () => {
    const first = fakeElement();
    const second = fakeElement();
    const document = fakeRoot({}, [], 'en', { '#xDetDlgDelBu': [first, second] });

    const result = findActionIn(document, domAction('deleteEvent'));

    expect(result.el).toBeNull();
    expect(result.via).toBe('ambiguous');
  });

  it('resolves the recurring-delete confirmation through its MDC hook', () => {
    const ok = fakeElement({ attrs: { 'data-mdc-dialog-action': 'ok' } });
    const document = fakeRoot({}, [], 'en-GB', {
      '[role="dialog"] button[data-mdc-dialog-action="ok"]': [ok],
    });

    const result = findActionIn(document, domAction('confirmScope'));

    expect(result.el).toBe(ok);
    expect(result.via).toBe('hook');
  });

  it('resolves a label action through the label band on an en-GB page', () => {
    const back = fakeElement({ attrs: { 'aria-label': 'Go back' } });
    const document = fakeRoot({}, [back], 'en-GB');

    const result = findActionIn(document, domAction('back'));

    expect(result.el).toBe(back);
    expect(result.via).toBe('label');
  });

  it('restricts Today to aria-label so a node that mirrors its text does not match', () => {
    const mirror = fakeElement({ text: 'Today' }); // the wrapper or tooltip Google repeats it into
    const button = fakeElement({ attrs: { 'aria-label': 'Today, Thursday, 1 October' } });
    const document = fakeRoot({}, [mirror, button], 'en-GB');

    const result = findActionIn(document, domAction('today'));

    expect(result.el).toBe(button);
    expect(result.via).toBe('label');
  });

  it('reports ambiguous when a second laid-out aria-label matches an only action', () => {
    const first = fakeElement({ attrs: { 'aria-label': 'Next day' } });
    const second = fakeElement({ attrs: { 'aria-label': 'Next day' } });
    const document = fakeRoot({}, [first, second], 'en-GB');

    expect(findActionIn(document, domAction('navNext')).via).toBe('ambiguous');
  });

  it('matches the dynamic Today aria-label against the live date suffix', () => {
    const today = fakeElement({ attrs: { 'aria-label': 'Today, Thursday, 1 October' } });
    const document = fakeRoot({}, [today], 'en-GB');

    expect(findActionIn(document, domAction('today')).el).toBe(today);
  });

  it('reports none for a label action off English', () => {
    const back = fakeElement({ attrs: { 'aria-label': 'Zurück' } });
    const document = fakeRoot({}, [back], 'de');

    expect(findActionIn(document, domAction('back')).via).toBe('none');
  });
});

describe('labelSelectors for the map', () => {
  it('emits :lang()-scoped fragments for the settings label', () => {
    const fragments = labelSelectors(domAction('settings'));

    expect(fragments).toContain('[aria-label*="settings" i]:lang(en)');
    expect(fragments).toContain('[data-tooltip*="settings" i]:lang(en)');
    expect(fragments).toContain('[title*="settings" i]:lang(en)');
  });

  it('uses the operator that matches the action match mode', () => {
    expect(labelSelectors(domAction('today'))).toContain('[aria-label^="today" i]:lang(en)');
    expect(labelSelectors(domAction('back'))).toContain('[aria-label="go back" i]:lang(en)');
  });
});
