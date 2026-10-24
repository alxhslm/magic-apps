import { describe, it, expect, vi } from 'vitest';
import vm from 'node:vm';
import { AccountsManager } from '../src/accounts-manager.js';

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp/magical-test') },
  WebContentsView: vi.fn().mockImplementation(function () {
    return {
      webContents: {
        loadURL: vi.fn(),
        getURL: vi.fn(() => 'https://calendar.google.com/calendar/u/0/r/week/2026/9/14'),
        getTitle: vi.fn(() => 'Calendar'),
        executeJavaScript: vi.fn().mockResolvedValue(true),
        sendInputEvent: vi.fn(),
        focus: vi.fn(),
        isDestroyed: vi.fn(() => false),
        isLoading: vi.fn(() => false),
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        setBackgroundThrottling: vi.fn(),
      },
      setBackgroundColor: vi.fn(),
      setBounds: vi.fn(),
    };
  }),
  session: {
    fromPartition: vi.fn(() => ({
      webRequest: { onBeforeSendHeaders: vi.fn(), onBeforeRequest: vi.fn() },
      setUserAgent: vi.fn(),
    })),
  },
}));

vi.mock('../src/settings-store.js', () => ({
  loadSettings: vi.fn(() => ({
    theme: 'system',
    transparentBackground: true,
    hideSidebar: false,
    addEventAccountPicker: 'active',
    inactiveAccountSuspendMinutes: 5,
  })),
  SUSPEND_NEVER: 0,
}));

const mockWindow = {
  getContentSize: () => [1000, 800],
  on: vi.fn(),
  contentView: {
    children: [] as unknown[],
    addChildView: vi.fn(),
    removeChildView: vi.fn(),
  },
} as never;

/**
 * Answers each injected script by what it asks for, so a test can assert on the route
 * without standing up a page. `currentPath` is what decides the mode to preserve,
 * `viewKey` is what Calendar reports when the path names no mode, and `editing` is what
 * decides whether routing is allowed at all.
 *
 * The script that pushes state is the one that waits for the redraw to settle, so what
 * it resolves with is whether the route arrived. `arrives: false` is a view that never
 * stops redrawing.
 */
function harness({
  currentPath = '/calendar/u/0/r/week/2026/9/14',
  editing = false,
  hasChip = true,
  viewKey = null as string | null,
  arrives = true,
  chipAtPoint = true,
  panelOpen = false,
  taskCompleted = false,
  btnRect = { x: 100, y: 100, width: 50, height: 30 },
} = {}) {
  const manager = new AccountsManager(mockWindow, '/fake/preload.js');
  const view = manager.getActiveView();
  const scripts: string[] = [];

  let livePath = currentPath;
  vi.mocked(view!.webContents.getURL).mockImplementation(
    () => `https://calendar.google.com${livePath}`,
  );

  vi.mocked(view!.webContents.executeJavaScript).mockImplementation((script: string) => {
    if (script.includes('closest(\'[role="dialog"]\')')) return Promise.resolve(panelOpen);
    scripts.push(script);
    if (script.includes('location.pathname + location.search')) return Promise.resolve(currentPath);
    if (script.includes('data-viewkey')) return Promise.resolve(viewKey);
    if (script.includes('eventedit')) return Promise.resolve(editing);
    // The task panel's completion button holds its own state, so it answers both the
    // question of whether the task is already done and, after the click, whether Google
    // took it.
    if (script.includes('button.dataset.completed')) return Promise.resolve(true);
    if (script.includes('?.dataset.completed'))
      return Promise.resolve(taskCompleted ? 'true' : 'false');
    if (script.includes('elementFromPoint')) {
      return Promise.resolve(chipAtPoint ? { x: 120, y: 80 } : null);
    }
    if (script.includes('getBoundingClientRect')) return Promise.resolve(btnRect);
    if (script.includes('Boolean(document.querySelector') && script.includes('data-eventid')) {
      return Promise.resolve(hasChip);
    }
    if (script.includes('pushState')) {
      const pushed = /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(script)?.[1];
      if (pushed && arrives) livePath = pushed;
      return Promise.resolve(arrives);
    }
    return Promise.resolve(true);
  });

  const accountId = manager.getAccounts()[0].id;
  return { manager, accountId, scripts, view: view! };
}

/** Ties a view's URL to a path the test moves around, which is what tells `routeTo` it
 * is already where it was asked to go. */
function trackRoute(view: { webContents: Electron.WebContents }, readPath: () => string): void {
  vi.mocked(view.webContents.getURL).mockImplementation(
    () => `https://calendar.google.com${readPath()}`,
  );
}

const pushedPath = (scripts: string[]): string | undefined =>
  /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(
    scripts.find((s) => s.includes('pushState')) ?? '',
  )?.[1];

/**
 * Runs an injected confirmation script against a stand-in page, so a test can prove the
 * predicate reads the state the click left behind rather than a snapshot of it. `page`
 * is the live region's text and whether a dialog is drawn; the script decides for itself
 * whether that is evidence that the delete landed.
 */
function runInPage(script: string, page: { dialogOpen: boolean; announcement: string }) {
  const live = [{ textContent: page.announcement }];
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  const document = {
    body: {},
    querySelectorAll: (selector: string) => (selector.includes('aria-live') ? live : []),
    querySelector: (selector: string) =>
      selector === '[role="dialog"]' ? (page.dialogOpen ? {} : null) : null,
  };
  const win: Record<string, unknown> = {
    document,
    MutationObserver,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    console,
    Array,
    Object,
    String,
    Boolean,
    TypeError,
    JSON,
    Math,
  };
  win.window = win;
  return vm.runInContext(script, vm.createContext(win)) as Promise<unknown>;
}

describe('revealEvent', () => {
  it('keeps the view mode it found, so a link moves the user in time only', async () => {
    const { manager, accountId, scripts } = harness({
      currentPath: '/calendar/u/0/r/week/2026/9/14',
    });

    await manager.revealEvent(accountId, 'EID', new Date(2026, 8, 17));

    expect(pushedPath(scripts)).toBe('/calendar/u/0/r/week/2026/9/17');
  });

  it('falls back to day view when the mode cannot be read', async () => {
    const { manager, accountId, scripts } = harness({ currentPath: '/calendar/u/0/r' });

    await manager.revealEvent(accountId, 'EID', new Date(2026, 8, 17));

    expect(pushedPath(scripts)).toBe('/calendar/u/0/r/day/2026/9/17');
  });

  it('stays on the account index the view is already at', async () => {
    const { manager, accountId, scripts } = harness({
      currentPath: '/calendar/u/1/r/week/2026/9/14',
    });

    await manager.revealEvent(accountId, 'EID', new Date(2026, 8, 17));

    expect(pushedPath(scripts)).toBe('/calendar/u/1/r/week/2026/9/17');
  });

  it('leaves an open editor alone rather than routing out from under it', async () => {
    const { manager, accountId, scripts } = harness({ editing: true });

    expect(await manager.revealEvent(accountId, 'EID', new Date(2026, 8, 17))).toBe('busy');
    expect(scripts.some((s) => s.includes('pushState'))).toBe(false);
  });

  it('keeps the view Calendar reports when the path does not name one', async () => {
    // An account woken by a link resumes at `/calendar/u/<n>/r`, where the view on
    // screen is a user setting the URL never mentions.
    const { manager, accountId, scripts } = harness({
      currentPath: '/calendar/u/0/r',
      viewKey: 'WEEK',
    });

    await manager.revealEvent(accountId, 'EID', new Date(2026, 8, 17));

    expect(pushedPath(scripts)).toBe('/calendar/u/0/r/week/2026/9/17');
  });

  it('falls back to day view from a view that draws no event chips', async () => {
    // Year and schedule render no `data-eventid` at all, so staying in one leaves
    // nothing to open.
    const { manager, accountId, scripts } = harness({
      currentPath: '/calendar/u/0/r',
      viewKey: 'YEAR',
    });

    await manager.revealEvent(accountId, 'EID', new Date(2026, 8, 17));

    expect(pushedPath(scripts)).toBe('/calendar/u/0/r/day/2026/9/17');
  });

  it('reports a failed route rather than clicking into a view that never rendered', async () => {
    // Calendar keeps the outgoing view's chips for a moment after the route, so a
    // click sent before the new view renders lands on a node about to be discarded.
    vi.useFakeTimers();
    const { manager, accountId, scripts } = harness({ arrives: false });

    const outcome = manager.revealEvent(accountId, 'EID', new Date(2026, 8, 17));
    await vi.advanceTimersByTimeAsync(6000);

    expect(await outcome).toBe('failed');
    expect(scripts.some((s) => s.includes('button.click()'))).toBe(false);
    vi.useRealTimers();
  });
});

/**
 * Whether a selector of the form this builds would pick one `data-eventid` out of the grid.
 *
 * A DOM would be the honest way to ask, and there is none in this suite. Only the three
 * clause shapes the chip selector emits are handled, which is what keeps this a check on
 * the selector rather than a second implementation of CSS.
 */
function selects(selector: string, chipId: string): boolean {
  return selector.split(/,(?=\[)/).some((clause) => {
    const exact = /^\[data-eventid="([^"]*)"\]$/.exec(clause);
    if (exact) return chipId === exact[1];
    const endsWith = /^\[data-eventid\^="([^"]*)"\]\[data-eventid\$="([^"]*)"\]$/.exec(clause);
    if (endsWith) return chipId.startsWith(endsWith[1]) && chipId.endsWith(endsWith[2]);
    const contains = /^\[data-eventid\^="([^"]*)"\]\[data-eventid\*="([^"]*)"\]$/.exec(clause);
    if (contains) return chipId.startsWith(contains[1]) && chipId.includes(contains[2]);
    return false;
  });
}

/** The selector the manager injected to find a chip, read back off the script it ran. */
const chipSelector = (scripts: string[]): string => {
  // Scan the scripts for a querySelectorAll literal that actually names data-eventid,
  // rather than the first querySelectorAll anywhere: the shared DOM preamble now carries
  // its own querySelectorAll, so a preamble-only match would read back the wrong string.
  for (const script of scripts) {
    for (const match of script.matchAll(/querySelectorAll\(("(?:[^"\\]|\\.)*")\)/g)) {
      const selector = JSON.parse(match[1]) as string;
      if (selector.includes('data-eventid')) return selector;
    }
  }
  return '';
};

describe('the event chip selector', () => {
  // Calendar gives a working location a `data-eventid` of its own making rather than the
  // `eid`: `_WL_<startMs>__<endMs>__<base64 calendarId>__<eventId>`, measured against a
  // live account. Nothing of the eid survives in it but the trailing event id, so an
  // equality match found no chip and both surfaces that need one did nothing — the
  // popover opened a working location nowhere, and deleting one left it in place.
  const eid = Buffer.from('wl7x9 me@work.com', 'utf8').toString('base64url');
  const workingLocationChip = `_WL_1790035200000__1790121600000__bWVAd29yay5jb20__wl7x9`;

  it('finds a working location, whose chip carries no eid at all', async () => {
    const { manager, accountId, scripts } = harness();

    await manager.revealEvent(accountId, eid, new Date(2026, 8, 17));

    expect(selects(chipSelector(scripts), workingLocationChip)).toBe(true);
  });

  // A recurring working location carries its series and occurrence ids as well, which
  // leaves the event id in the middle rather than at the end.
  const recurringChip =
    '_WL_1790035200000__1790294400000__bWVAd29yay5jb20' +
    '__series_mock_001_20260922__wl7x9__mock_event_id_001';

  it('finds a recurring working location, whose event id is not the last segment', async () => {
    const { manager, accountId, scripts } = harness();

    await manager.revealEvent(accountId, eid, new Date(2026, 8, 17));

    expect(selects(chipSelector(scripts), recurringChip)).toBe(true);
  });

  it('does not reach a recurring chip whose id merely starts the same way', async () => {
    const { manager, accountId, scripts } = harness();

    await manager.revealEvent(accountId, eid, new Date(2026, 8, 17));

    const longerId = recurringChip.replace('__wl7x9__', '__wl7x9extra__');
    expect(selects(chipSelector(scripts), longerId)).toBe(false);
  });

  it('still finds an ordinary chip, which carries the eid itself', async () => {
    const { manager, accountId, scripts } = harness();

    await manager.revealEvent(accountId, eid, new Date(2026, 8, 17));

    expect(selects(chipSelector(scripts), eid)).toBe(true);
  });

  it('does not reach a working location belonging to another event', async () => {
    const { manager, accountId, scripts } = harness();

    await manager.revealEvent(accountId, eid, new Date(2026, 8, 17));

    const otherEvent = `_WL_1790035200000__1790121600000__bWVAd29yay5jb20__someoneelse`;
    expect(selects(chipSelector(scripts), otherEvent)).toBe(false);
  });

  it('adds no working-location clause to an eid it cannot read', async () => {
    const { manager, accountId, scripts } = harness();

    await manager.revealEvent(accountId, 'EID', new Date(2026, 8, 17));

    expect(chipSelector(scripts)).toBe('[data-eventid="EID"],[data-eventid="ttb_EID"]');
  });
});

/**
 * Runs the busy check the manager injected, against a stand-in page.
 *
 * The harness answers that script with a fixed boolean, so the only way to check the
 * question it actually asks is to run it. The stand-in answers the three selectors the
 * script uses and nothing else, which keeps this a check on the guard rather than a
 * second implementation of the DOM.
 */
function busyOn(
  scripts: string[],
  page: { path: string; dialogs: { fields: number }[]; alert?: boolean },
) {
  const script = scripts.find((s) => s.includes('eventedit'));
  if (!script) throw new Error('the manager never asked whether the view was busy');

  const dialog = (fields: number) => ({
    querySelector: (sel: string) => (sel.includes('input') && fields > 0 ? ({} as unknown) : null),
  });
  const document = {
    querySelector: (sel: string) => (sel.includes('alertdialog') && page.alert ? {} : null),
    querySelectorAll: (sel: string) =>
      sel.includes('dialog') ? page.dialogs.map((d) => dialog(d.fields)) : [],
  };

  // Trimmed before it is spliced in: the injected script opens with a newline, and
  // `return` followed by one returns undefined rather than the expression.
  return new Function('document', 'location', `return ${script.trim()}`)(document, {
    pathname: page.path,
  }) as boolean;
}

describe('the guard against acting mid-edit', () => {
  const day = '/calendar/u/0/r/day/2026/9/23';

  it("does not count an event's own detail popup, which holds nothing to lose", async () => {
    const { manager, accountId, scripts } = harness();

    await manager.revealEvent(accountId, 'EID', new Date(2026, 8, 17));

    expect(busyOn(scripts, { path: day, dialogs: [{ fields: 0 }] })).toBe(false);
  });

  it('counts the quick-create overlay, which holds a title the user typed', async () => {
    const { manager, accountId, scripts } = harness();

    await manager.revealEvent(accountId, 'EID', new Date(2026, 8, 17));

    expect(busyOn(scripts, { path: day, dialogs: [{ fields: 9 }] })).toBe(true);
  });

  it('counts a detail popup the user has opened an editor on top of', async () => {
    const { manager, accountId, scripts } = harness();

    await manager.revealEvent(accountId, 'EID', new Date(2026, 8, 17));

    expect(busyOn(scripts, { path: day, dialogs: [{ fields: 0 }, { fields: 4 }] })).toBe(true);
  });

  it('counts the discard alert and the editor route', async () => {
    const { manager, accountId, scripts } = harness();

    await manager.revealEvent(accountId, 'EID', new Date(2026, 8, 17));

    expect(busyOn(scripts, { path: day, dialogs: [], alert: true })).toBe(true);
    expect(busyOn(scripts, { path: '/calendar/u/0/r/eventedit/EID', dialogs: [] })).toBe(true);
  });
});

describe('performRsvp', () => {
  it("routes to the event's date, clicks the RSVP control, and restores the route", async () => {
    let path = '/calendar/u/0/r/week/2026/9/14';
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const view = manager.getActiveView();
    const scripts: string[] = [];
    trackRoute(view!, () => path);

    vi.mocked(view!.webContents.executeJavaScript).mockImplementation((script: string) => {
      if (script.includes('closest(\'[role="dialog"]\')')) return Promise.resolve(false);
      scripts.push(script);
      if (script.includes('location.pathname + location.search')) return Promise.resolve(path);
      if (script.includes('data-viewkey')) return Promise.resolve(null);
      if (script.includes('eventedit')) return Promise.resolve(false);
      if (script.includes('pushState')) {
        const match = /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(script);
        if (match) path = match[1];
        return Promise.resolve(true);
      }
      if (script.includes('getBoundingClientRect')) {
        return Promise.resolve({ x: 120, y: 80, width: 60, height: 32 });
      }
      if (script.includes('Boolean(document.querySelector') && script.includes('data-eventid')) {
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    });

    const accountId = manager.getAccounts()[0].id;
    const outcome = await manager.performRsvp(accountId, 'EID_1', 'yes', new Date(2026, 8, 17));

    expect(outcome).toBe('ok');
    // The week stays a week: answering an invitation moves the user in time, not out of
    // the view they had open.
    const pushed = scripts
      .filter((s) => s.includes('pushState'))
      .map((s) => /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(s)?.[1]);
    expect(pushed).toEqual(['/calendar/u/0/r/week/2026/9/17', '/calendar/u/0/r/week/2026/9/14']);

    // Two real clicks: the chip that opens the panel, then the reply inside it.
    const downs = vi
      .mocked(view!.webContents.sendInputEvent)
      .mock.calls.filter(([e]) => (e as { type: string }).type === 'mouseDown');
    expect(downs).toHaveLength(2);
    const reply = downs[downs.length - 1][0] as unknown as { x?: number; y?: number };
    expect(reply.x).toBe(120);
    expect(reply.y).toBe(80);

    expect(scripts.some((s) => s.includes('waitUntil') && s.includes('xRsvpYesBu'))).toBe(true);
  });

  it('answers the recurring scope modal for the occurrence, not the series', async () => {
    const { manager, accountId, scripts, view } = harness({ hasChip: true });
    vi.mocked(view.webContents.sendInputEvent).mockImplementation((event) => {
      if ((event as { type: string }).type === 'mouseDown') scripts.push('CLICK');
    });

    await manager.performRsvp(accountId, 'EID_1', 'yes', new Date(2026, 8, 17));

    // A recurring invitation is not answered by the control itself: Calendar raises a
    // modal asking which occurrences the reply covers, and the reply is only sent once
    // its OK is pressed. The radio group is what tells that modal from the event panel.
    const scope = scripts.find((s) => s.includes('radiogroup'));
    expect(scope).toBeDefined();
    expect(scope).toContain('instance.checked');
    expect(scope).toContain('okBtn.click()');

    // What the page was saying is read before the reply, because the modal is answered
    // afterwards and a comparison made after the click has nothing left to compare to.
    const clicks = scripts.flatMap((s, i) => (s === 'CLICK' ? [i] : []));
    const snapshot = scripts.findIndex((s) => s.includes('dialogWasOpen: document'));
    expect(clicks).toHaveLength(2);
    expect(snapshot).toBeGreaterThan(clicks[0]);
    expect(snapshot).toBeLessThan(clicks[1]);
  });

  it('skips day routing when the event chip is already present in the active view', async () => {
    const { manager, accountId, scripts } = harness({ hasChip: true });

    const outcome = await manager.performRsvp(accountId, 'EID_1', 'yes', new Date(2026, 8, 17));

    expect(outcome).toBe('ok');
    expect(scripts.some((s) => s.includes('pushState'))).toBe(false);
  });

  it('does not restore route if user navigated away while RSVP was in progress', async () => {
    let path = '/calendar/u/0/r/week/2026/9/14';
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const view = manager.getActiveView();
    const scripts: string[] = [];
    trackRoute(view!, () => path);

    vi.mocked(view!.webContents.executeJavaScript).mockImplementation((script: string) => {
      if (script.includes('closest(\'[role="dialog"]\')')) return Promise.resolve(false);
      scripts.push(script);
      if (script.includes('location.pathname + location.search')) return Promise.resolve(path);
      if (script.includes('data-viewkey')) return Promise.resolve(null);
      if (script.includes('eventedit')) return Promise.resolve(false);
      if (script.includes('pushState')) {
        const match = /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(script);
        if (match) path = match[1];
        return Promise.resolve(true);
      }
      if (script.includes('waitUntil') && script.includes('xRsvp')) {
        // The user moves to another month while the reply is in flight.
        path = '/calendar/u/0/r/month/2026/10/1';
        return Promise.resolve(true);
      }
      if (script.includes('getBoundingClientRect')) {
        return Promise.resolve({ x: 120, y: 80, width: 60, height: 32 });
      }
      if (script.includes('Boolean(document.querySelector') && script.includes('data-eventid')) {
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    });

    const accountId = manager.getAccounts()[0].id;
    const outcome = await manager.performRsvp(accountId, 'EID_1', 'yes', new Date(2026, 8, 17));

    expect(outcome).toBe('ok');
    const pushed = scripts
      .filter((s) => s.includes('pushState'))
      .map((s) => /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(s)?.[1]);
    expect(pushed).toEqual(['/calendar/u/0/r/week/2026/9/17']);
  });

  it('leaves an open editor alone rather than sending an RSVP out from under it', async () => {
    const { manager, accountId, scripts } = harness({ editing: true });

    expect(await manager.performRsvp(accountId, 'EID', 'yes', new Date(2026, 8, 17))).toBe('busy');
    expect(scripts.some((s) => s.includes('pushState'))).toBe(false);
  });
});

describe('deleteEvent', () => {
  it('refuses to click a chip that is not the thing drawn at its own centre', async () => {
    // Clicking a point is what Calendar's chip handler requires, and it is also how a
    // scrolling grid deletes the wrong event: the coordinate keeps pointing at a spot
    // after something else has moved into it. The chip is only clicked when
    // `elementFromPoint` says the chip is what a click there would reach.
    const { manager, accountId, view } = harness({ chipAtPoint: false });

    expect(await manager.deleteEvent(accountId, 'EID', new Date(2026, 8, 17))).toBe('failed');

    const downs = vi
      .mocked(view.webContents.sendInputEvent)
      .mock.calls.filter(([e]) => (e as { type: string }).type === 'mouseDown');
    expect(downs).toHaveLength(0);
  });

  it('clicks the chip and then the delete control inside the panel it opens', async () => {
    const { manager, accountId, view } = harness();

    expect(await manager.deleteEvent(accountId, 'EID', new Date(2026, 8, 17))).toBe('ok');

    // Two real clicks: the chip that opens the panel, then Delete inside it. Both have
    // to be trusted input, because Calendar ignores a synthetic `click()` on either.
    const downs = vi
      .mocked(view.webContents.sendInputEvent)
      .mock.calls.filter(([e]) => (e as { type: string }).type === 'mouseDown');
    expect(downs).toHaveLength(2);
  });

  it('uses the panel that is already open rather than the chip underneath it', async () => {
    // An open panel covers its own chip, and the click check refuses to land on the panel
    // rather than on the chip. The panel carries the event's id, so the chip lookup finds
    // it as well as the chip does — without this the delete takes its "a chip is already
    // on screen" branch and then clicks something that is behind the panel.
    const { manager, accountId, view } = harness({ panelOpen: true });

    expect(await manager.deleteEvent(accountId, 'EID', new Date(2026, 8, 17))).toBe('ok');

    // One real click: Delete, inside the panel that is already open.
    const downs = vi
      .mocked(view.webContents.sendInputEvent)
      .mock.calls.filter(([e]) => (e as { type: string }).type === 'mouseDown');
    expect(downs).toHaveLength(1);
  });

  it('reports a delete as done when the panel closed before the confirmation ran', async () => {
    // The delete click shuts the panel and updates the live region at once, but the
    // confirmation only runs after the recurring-modal wait. A "before" snapshot read
    // after the click is therefore empty: the panel is already shut and the region
    // already holds its new text, so a delete that happened reports failed. The page
    // here flips on the delete click and the real script is run against it.
    const page = { dialogOpen: true, announcement: 'Loading…' };
    let downs = 0;
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const view = manager.getActiveView()!;
    let path = '/calendar/u/0/r/week/2026/9/14';
    trackRoute(view, () => path);

    vi.mocked(view.webContents.sendInputEvent).mockImplementation((event) => {
      if ((event as { type: string }).type !== 'mouseDown') return;
      downs += 1;
      // The trusted delete click is the second one: chip, then Delete.
      if (downs === 2) {
        page.dialogOpen = false;
        page.announcement = 'Event deleted';
      }
    });

    vi.mocked(view.webContents.executeJavaScript).mockImplementation((script: string) => {
      if (script.includes('closest(\'[role="dialog"]\')')) return Promise.resolve(false);
      if (script.includes('location.pathname + location.search')) return Promise.resolve(path);
      if (script.includes('data-viewkey')) return Promise.resolve(null);
      if (script.includes('eventedit')) return Promise.resolve(false);
      if (script.includes('elementFromPoint')) return Promise.resolve({ x: 120, y: 80 });
      if (script.includes('getBoundingClientRect')) {
        return Promise.resolve({ x: 100, y: 100, width: 50, height: 30 });
      }
      if (script.includes('Boolean(document.querySelector') && script.includes('data-eventid')) {
        return Promise.resolve(true);
      }
      if (script.includes('pushState')) {
        const pushed = /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(script)?.[1];
        if (pushed) path = pushed;
        return Promise.resolve(true);
      }
      // No recurring modal is drawn for a single event.
      if (script.includes('data-mdc-dialog-action')) return Promise.resolve(undefined);
      // The confirmation script itself, run against the page it is injected into.
      if (script.includes('const LIVE') && script.includes('waitUntil')) {
        return runInPage(script, page);
      }
      // The pre-click snapshot: reads the panel without waiting.
      if (script.includes('const LIVE'))
        return Promise.resolve({ announcement: page.announcement, dialogWasOpen: page.dialogOpen });
      return Promise.resolve(true);
    });

    const accountId = manager.getAccounts()[0].id;
    expect(await manager.deleteEvent(accountId, 'EID', new Date(2026, 8, 17))).toBe('ok');
  });

  it('does not restore route if user navigated away during deletion', async () => {
    let path = '/calendar/u/0/r/week/2026/9/14';
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const view = manager.getActiveView();
    const scripts: string[] = [];
    trackRoute(view!, () => path);

    vi.mocked(view!.webContents.executeJavaScript).mockImplementation((script: string) => {
      if (script.includes('closest(\'[role="dialog"]\')')) return Promise.resolve(false);
      scripts.push(script);
      if (script.includes('location.pathname + location.search')) return Promise.resolve(path);
      if (script.includes('data-viewkey')) return Promise.resolve(null);
      if (script.includes('eventedit')) return Promise.resolve(false);
      if (script.includes('pushState')) {
        const match = /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(script);
        if (match) path = match[1];
        return Promise.resolve(true);
      }
      if (script.includes('waitUntil') && script.includes('dialogWasOpen')) {
        // The user moves to another month while the delete is in flight.
        path = '/calendar/u/0/r/month/2026/10/1';
        return Promise.resolve(true);
      }
      if (script.includes('Boolean(document.querySelector') && script.includes('data-eventid')) {
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    });

    const accountId = manager.getAccounts()[0].id;
    const outcome = await manager.deleteEvent(accountId, 'EID', new Date(2026, 8, 17));

    expect(outcome).toBe('ok');
    const pushed = scripts
      .filter((s) => s.includes('pushState'))
      .map((s) => /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(s)?.[1]);
    expect(pushed).toEqual(['/calendar/u/0/r/week/2026/9/17']);
  });

  it('leaves an open editor alone rather than deleting behind it', async () => {
    const { manager, accountId, scripts } = harness({ editing: true });

    expect(await manager.deleteEvent(accountId, 'EID', new Date(2026, 8, 17))).toBe('busy');
    expect(scripts.some((s) => s.includes('pushState'))).toBe(false);
  });

  it('does not fall back to the editor route for a task, which has none', async () => {
    const { manager, accountId, scripts } = harness({ hasChip: false, chipAtPoint: false });

    expect(await manager.deleteEvent(accountId, 'EID', new Date(2026, 8, 17), true)).toBe('failed');

    expect(scripts.some((s) => s.includes('/eventedit/EID'))).toBe(false);
  });

  it('does not route to the editor when the day view cannot delete', async () => {
    // The day view is the only route: `/r/eventedit` opened an editor the user never
    // asked for and left them one keystroke from changing a meeting.
    const { manager, accountId, scripts } = harness({ hasChip: false, chipAtPoint: false });

    expect(await manager.deleteEvent(accountId, 'EID', new Date(2026, 8, 17))).toBe('failed');

    expect(scripts.some((s) => s.includes('/eventedit/EID'))).toBe(false);
  });
});

describe('the chip a task is drawn as', () => {
  // Google prefixes a task's `data-eventid` with `ttb_` and its own `eid=` link with
  // nothing, so matching the id alone found no chip and every reveal and delete of a
  // task clicked nothing at all.
  it('is matched under the prefixed id as well as the bare one', async () => {
    const { manager, accountId, scripts } = harness();

    await manager.revealEvent(accountId, 'EID', new Date(2026, 8, 17));

    const chipScript = scripts.find((s) => s.includes('elementFromPoint'));
    expect(chipScript).toContain('[data-eventid=\\"EID\\"]');
    expect(chipScript).toContain('[data-eventid=\\"ttb_EID\\"]');
  });
});

describe('setTaskCompleted', () => {
  it('clicks the chip and then the completion control inside the panel', async () => {
    const { manager, accountId, view } = harness();

    expect(await manager.setTaskCompleted(accountId, 'EID', new Date(2026, 8, 17), true)).toBe(
      'ok',
    );

    const downs = vi
      .mocked(view.webContents.sendInputEvent)
      .mock.calls.filter(([e]) => (e as { type: string }).type === 'mouseDown');
    expect(downs).toHaveLength(2);
  });

  it('leaves a task already in the wanted state alone, since the same control unticks it', async () => {
    const { manager, accountId, view } = harness({ taskCompleted: true });

    expect(await manager.setTaskCompleted(accountId, 'EID', new Date(2026, 8, 17), true)).toBe(
      'ok',
    );

    // One click, the chip's. Clicking the control again would reopen the task.
    const downs = vi
      .mocked(view.webContents.sendInputEvent)
      .mock.calls.filter(([e]) => (e as { type: string }).type === 'mouseDown');
    expect(downs).toHaveLength(1);
  });

  it('clicks the control to reopen a completed task', async () => {
    const { manager, accountId, view } = harness({ taskCompleted: true });

    expect(await manager.setTaskCompleted(accountId, 'EID', new Date(2026, 8, 17), false)).toBe(
      'ok',
    );

    const downs = vi
      .mocked(view.webContents.sendInputEvent)
      .mock.calls.filter(([e]) => (e as { type: string }).type === 'mouseDown');
    expect(downs).toHaveLength(2);
  });

  it('leaves an open task alone when asked to reopen it', async () => {
    const { manager, accountId, view } = harness();

    expect(await manager.setTaskCompleted(accountId, 'EID', new Date(2026, 8, 17), false)).toBe(
      'ok',
    );

    const downs = vi
      .mocked(view.webContents.sendInputEvent)
      .mock.calls.filter(([e]) => (e as { type: string }).type === 'mouseDown');
    expect(downs).toHaveLength(1);
  });

  it('leaves an open editor alone rather than completing behind it', async () => {
    const { manager, accountId, scripts } = harness({ editing: true });

    expect(await manager.setTaskCompleted(accountId, 'EID', new Date(2026, 8, 17), true)).toBe(
      'busy',
    );
    expect(scripts.some((s) => s.includes('pushState'))).toBe(false);
  });

  it('puts the view back where it was, since completing is triage', async () => {
    let path = '/calendar/u/0/r/week/2026/9/14';
    const { manager, accountId, scripts, view } = harness({ hasChip: false });
    trackRoute(view, () => path);
    vi.mocked(view.webContents.executeJavaScript).mockImplementation((script: string) => {
      if (script.includes('closest(\'[role="dialog"]\')')) return Promise.resolve(false);
      scripts.push(script);
      if (script.includes('location.pathname + location.search')) return Promise.resolve(path);
      if (script.includes('data-viewkey')) return Promise.resolve(null);
      if (script.includes('eventedit')) return Promise.resolve(false);
      if (script.includes('button.dataset.completed')) return Promise.resolve(true);
      if (script.includes('?.dataset.completed')) return Promise.resolve('false');
      if (script.includes('elementFromPoint')) return Promise.resolve({ x: 120, y: 80 });
      if (script.includes('getBoundingClientRect')) {
        return Promise.resolve({ x: 100, y: 100, width: 50, height: 30 });
      }
      if (script.includes('Boolean(document.querySelector') && script.includes('data-eventid')) {
        return Promise.resolve(false);
      }
      if (script.includes('pushState')) {
        const pushed = /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(script)?.[1];
        if (pushed) path = pushed;
        return Promise.resolve(true);
      }
      return Promise.resolve(true);
    });

    expect(await manager.setTaskCompleted(accountId, 'EID', new Date(2026, 8, 17), true)).toBe(
      'ok',
    );

    const pushed = scripts
      .filter((s) => s.includes('pushState'))
      .map((s) => /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(s)?.[1]);
    expect(pushed).toEqual(['/calendar/u/0/r/week/2026/9/17', '/calendar/u/0/r/week/2026/9/14']);
  });
});
