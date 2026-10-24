#!/usr/bin/env node
/**
 * dom-drift.mjs
 *
 * A canary for the strong DOM hooks both apps drive Google's controls through.
 *
 * Gmail and Calendar change without warning, and a hook that once named a control
 * can survive as a selector that now resolves to nothing or to the wrong node. The
 * canary resolves every hook with the same page-side `findAction` the apps use and
 * compares the control it lands on against the English accessible name, read off a
 * signed-in English account. The English label is the test oracle only; no matcher
 * reads it, and the locale map stays out of this tool.
 *
 * Launch the app under test with its debug port first, then point the canary at it:
 *
 *   pnpm run magimail:debug                                  # CDP on 9222
 *   node tools/dom-drift.mjs --app magimail
 *
 *   pnpm run magical:debug                                   # CDP on 9223
 *   node tools/dom-drift.mjs --app magical
 *
 * `--port` overrides the app's default port, and `--target <title substring>` names
 * the account when more than one view is awake. A control that is not rendered in
 * the current view is reported `skip`, not `fail`, because reaching a state is not a
 * check: the canary drives the page into the state each hook needs, then resolves the
 * hook with `findAction` and compares it. It selects Gmail threads until one is
 * unread, opens and closes Calendar event chips for the delete hook, scans those
 * chips for an invitation for the RSVP hooks, and opens Calendar search for `Go
 * back`. It never activates a control it is checking, never creates or edits an
 * event and never changes mail. On Calendar it routes the view to day and then week
 * itself. The day arrows are named for the view that renders them, "Previous day" in
 * day view and "Previous week" in week view, so a check in one view says nothing
 * about the other.
 *
 * The tool is a manual or CI-local canary. A red run means Google moved something a
 * person has to look at, which is not a job for blocking CI.
 *
 * Requires `pnpm --filter @magimail/core run build`, because the shared preamble is
 * loaded from the package's built entry (whose own entry imports electron).
 */
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const APPS = {
  magimail: { port: '9222', host: 'mail.google.com' },
  magical: { port: '9223', host: 'calendar.google.com' },
};

const argv = process.argv.slice(2);
let app = 'magimail';
let port = '';
let targetMatch = '';
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--app') {
    app = argv[++i];
  } else if (arg === '--port') {
    port = argv[++i];
  } else if (arg === '--target') {
    targetMatch = argv[++i];
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }
}
if (!APPS[app]) {
  console.error(`Unknown --app "${app}"; expected one of ${Object.keys(APPS).join(', ')}`);
  process.exit(1);
}
if (!port) port = APPS[app].port;

/** The page-side `findAction` the apps drive Google's controls through. */
function loadPreamble() {
  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const realLoad = Module._load;
  // @magimail/core's entry imports electron at load, which a plain-Node tool cannot
  // resolve; only DOM_DRIVE_PREAMBLE is read, so electron is stubbed for the require.
  Module._load = function (request, ...rest) {
    if (request === 'electron') return new Proxy({}, { get: () => function electronStub() {} });
    return realLoad.call(this, request, ...rest);
  };
  try {
    return require('../packages/core/dist/index.js').DOM_DRIVE_PREAMBLE;
  } catch (err) {
    console.error('✗ Cannot load @magimail/core.');
    console.error('  Build it first: pnpm --filter @magimail/core run build');
    console.error(`  ${err.message}`);
    process.exit(1);
  } finally {
    Module._load = realLoad;
  }
}

const PREAMBLE = loadPreamble();

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------

/** Pause between page-side polls, so a routing loop does not spin. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Raises the app's window at the OS level.
 *
 * `Page.bringToFront` orders the tab inside Chromium but does not make the application
 * frontmost, and Google's chip handler ignores a click while another application is in
 * front, so the peek panel never opens. Best-effort and macOS-only, matching the apps
 * and this tool; a failure (no process, no System Events permission) just means the
 * click has to fend for itself.
 */
function frontApp() {
  const name = app === 'magical' ? 'Magical' : 'Magimail';
  try {
    const pids = execFileSync('pgrep', ['-f', `MacOS/${name} --demo`], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
    const script = pids[0]
      ? `tell application "System Events" to set frontmost of (first process whose unix id is ${pids[0]}) to true`
      : `tell application "${name}" to activate`;
    execFileSync('osascript', ['-e', script], { stdio: 'ignore' });
  } catch {
    // Not on macOS, no demo process, or no Automation permission: carry on.
  }
}

/**
 * The page went away: released by the app, or navigated out from under us.
 *
 * This is deliberately not a `skip`. A view that has been released is not a page with
 * nothing on it, and reporting one as the other is how a run that checked nothing comes
 * back looking like a run that checked everything.
 */
class PageGoneError extends Error {}

/**
 * The page target to attach to, resolved fresh every time.
 *
 * The apps destroy and recreate an account's view on their own schedule — an idle
 * account is released after `inactiveAccountSuspendMinutes` — so a target resolved once
 * at startup can be stale before the first check runs. Nothing here caches it.
 */
async function findPageTarget() {
  let targets;
  try {
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/json/list`);
    targets = await res.json();
  } catch {
    return { target: null, pages: [] };
  }
  const pages = targets.filter((t) => t.type === 'page');
  const candidates = pages.filter((t) => (t.url || '').includes(APPS[app].host));
  const target = targetMatch
    ? candidates.find((t) => (t.title || '').toLowerCase().includes(targetMatch.toLowerCase()))
    : candidates[0];
  return { target: target ?? null, pages };
}

let ws = null;
/** Whether the view was replaced under us at any point, so the run can say so. */
let reattached = false;

/** Attaches to the page, optionally waiting for one to appear. */
async function attach({ waitMs = 0 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { target } = await findPageTarget();
    if (target && target.webSocketDebuggerUrl) {
      const socket = new globalThis.WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = reject;
      });
      socket.addEventListener('close', () => {
        if (ws === socket) ws = null;
      });
      ws = socket;
      return;
    }
    if (Date.now() >= deadline) throw new PageGoneError(`no ${app} page target on port ${port}`);
    await sleep(500);
  }
}

/** Sends one command on one socket, rejecting if the page goes away first. */
function sendOn(socket, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 100000);
    const cleanup = () => {
      socket.removeEventListener('message', onMsg);
      socket.removeEventListener('close', onClose);
    };
    const onMsg = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.id !== id) return;
        cleanup();
        resolve(data);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };
    // A target that is released closes the socket without ever answering the in-flight
    // command; reject rather than leaving the await pending.
    const onClose = () => {
      cleanup();
      reject(new PageGoneError('the page went away'));
    };
    socket.addEventListener('message', onMsg);
    socket.addEventListener('close', onClose);
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      cleanup();
      reject(new PageGoneError(`the page went away: ${err.message}`));
    }
  });
}

/**
 * Sends a command, reattaching if the page went away.
 *
 * A view released mid-run is waited for rather than turned into a result: the app
 * recreates an account's view when it is woken, so a run can outlive a suspension. If it
 * never comes back this throws, and the run says the page went away instead of printing
 * a table of skips.
 */
async function sendCdp(method, params = {}) {
  if (!ws) await reattach();
  try {
    return await sendOn(ws, method, params);
  } catch (err) {
    if (!(err instanceof PageGoneError)) throw err;
    // The socket died as the command went out, so this command is lost: wait for the
    // app to bring a view back and send it again.
    ws = null;
    await reattach();
    return await sendOn(ws, method, params);
  }
}

/**
 * Waits for the app to bring the page back, and says so, once.
 *
 * A released view is waited for rather than turned into a result: the apps recreate an
 * account's view when it is woken, so a run can outlive a suspension. If it never
 * returns this throws, and the run reports that rather than a table of skips.
 */
async function reattach() {
  try {
    await attach({ waitMs: 10000 });
  } catch (err) {
    if (!(err instanceof PageGoneError)) throw err;
    throw new PageGoneError('the page went away and did not come back');
  }
  if (reattached) return;
  reattached = true;
  console.error(`⚠ The ${app} page went away mid-run; reattached to a fresh view.`);
  console.error('  Both apps release an idle account after inactiveAccountSuspendMinutes, and 0');
  console.error(
    '  keeps every visited account resident. Checks after this point run against the new',
  );
  console.error('  view, so a skip below may be that rather than anything about the page.');
}

await attach().catch((err) => {
  if (!(err instanceof PageGoneError)) throw err;
  console.error(`✗ No ${app} page target on port ${port}.`);
  console.error(`  Launch it with pnpm run ${app}:debug. The app may also have released the`);
  console.error("  account's view: an idle account is suspended after");
  console.error('  inactiveAccountSuspendMinutes, and 0 keeps every visited account resident.');
  process.exit(1);
});

async function evaluate(expression) {
  const res = await sendCdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.error) throw new Error(res.error.message);
  const { result, exceptionDetails } = res.result;
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  }
  return result?.value;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Runs `findAction` on the page and returns the parts that survive JSON: which band
 * resolved, the selector or label that matched, and the matched control's name.
 */
async function resolve(action) {
  const expr = `
    ${PREAMBLE}
    (() => {
      const r = findAction(document, ${JSON.stringify(action)});
      return {
        via: r.via,
        matchedBy: r.matchedBy,
        ariaLabel: r.el ? r.el.getAttribute('aria-label') : null,
        text: r.el ? (r.el.textContent || '').trim().slice(0, 80) : null,
      };
    })()
  `;
  return evaluate(expr);
}

function hookDescription(action) {
  if (action.selectors) return action.selectors.join(', ');
  const labels = Object.values(action.labels ?? {}).flat();
  return `label: ${JSON.stringify(labels)}`;
}

/**
 * Turns a resolver result into a verdict. `none` is a skip: the control is not
 * rendered in this view, which is a statement about the page, not the hook.
 */
function judge(check, res) {
  const hook = hookDescription(check.action);
  if (res.via === 'none') {
    return { name: check.name, hook, status: 'skip', observed: 'not laid out in this view' };
  }
  if (res.via === 'ambiguous') {
    return { name: check.name, hook, status: 'fail', observed: 'ambiguous (more than one match)' };
  }
  if (check.band === 'label') {
    return res.via === 'label'
      ? { name: check.name, hook, status: 'pass', observed: 'resolved uniquely through the label' }
      : { name: check.name, hook, status: 'fail', observed: `via ${res.via}` };
  }
  if (res.via !== 'hook') {
    return { name: check.name, hook, status: 'fail', observed: `via ${res.via}` };
  }
  const observed = check.oracle.attr === 'text' ? res.text : res.ariaLabel;
  const expected = check.oracle.value;
  const ok = Array.isArray(expected) ? expected.includes(observed) : observed === expected;
  const shown = `${check.oracle.attr}=${JSON.stringify(observed)}`;
  return { name: check.name, hook, status: ok ? 'pass' : 'fail', observed: shown };
}

async function runCheck(check) {
  return judge(check, await resolve(check.action));
}

// Gmail's list toolbar only lays out while a thread is selected, and it shows either
// "Mark as read" or "Mark as unread" depending on the selected thread — a read thread
// lays out `div[act="2"]`, so "Mark as read" only appears on an unread one. Select
// every row in turn, record each hook the first time it lays out, and deselect as it
// goes so the inbox is left as it was found.
async function checkGmail() {
  // Gmail lays the list toolbar out only from a real selection, and a checkbox click in a
  // background window does not select — the same frontmost requirement the Calendar chip
  // has. Raise the app once before selecting rows.
  frontApp();
  await sendCdp('Page.bringToFront', {});
  await sleep(250);
  const results = [];

  results.push(
    await runCheck({
      name: 'compose',
      band: 'hook',
      action: { selectors: ['[gh="cm"]'], order: 'only' },
      oracle: { attr: 'text', value: 'Compose' },
    }),
  );

  const toolbarChecks = [
    {
      name: 'archive',
      band: 'hook',
      action: { selectors: ['div[act="7"]'], order: 'only' },
      oracle: { attr: 'aria-label', value: 'Archive' },
    },
    {
      name: 'trash',
      band: 'hook',
      action: { selectors: ['div[act="10"]'], order: 'only' },
      oracle: { attr: 'aria-label', value: 'Delete' },
    },
    {
      name: 'mark read',
      band: 'hook',
      action: { selectors: ['div[act="1"]'], order: 'only' },
      oracle: { attr: 'aria-label', value: 'Mark as read' },
    },
    {
      name: 'mark unread',
      band: 'hook',
      action: { selectors: ['div[act="2"]'], order: 'only' },
      oracle: { attr: 'aria-label', value: 'Mark as unread' },
    },
  ];

  const found = new Map();
  const rows = await evaluate('document.querySelectorAll(\'tr[role="row"]\').length');
  for (let i = 0; i < rows; i++) {
    const selected = await evaluate(`
      (async () => {
        const rows = Array.from(document.querySelectorAll('tr[role="row"]'));
        const checkbox = rows[${i}] && rows[${i}].querySelector('div[role="checkbox"]');
        if (!checkbox) return false;
        checkbox.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
        return true;
      })()
    `);
    if (!selected) break;
    for (const check of toolbarChecks) {
      if (found.has(check.name)) continue;
      const verdict = await runCheck(check);
      if (verdict.status !== 'skip') found.set(check.name, verdict);
    }
    await evaluate(`
      (async () => {
        const rows = Array.from(document.querySelectorAll('tr[role="row"]'));
        const checkbox = rows[${i}] && rows[${i}].querySelector('div[role="checkbox"]');
        if (checkbox) checkbox.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
      })()
    `);
    if (found.size === toolbarChecks.length) break;
  }
  for (const check of toolbarChecks) {
    results.push(
      found.get(check.name) ?? {
        name: check.name,
        hook: hookDescription(check.action),
        status: 'skip',
        observed: 'no selected thread laid it out',
      },
    );
  }
  return results;
}

/**
 * Routes the view to a named Calendar view and waits for it to lay out.
 *
 * The day arrows carry a view-specific name ("Previous day" in day view, "Previous
 * week" in week view), so a check run in whichever view happened to be awake proves
 * nothing about the others. Driving the view makes the check deterministic, and lets a
 * match tied to one view's wording fail on the view that renders another.
 */
async function routeToView(view) {
  await evaluate(`
    (() => {
      const base = location.pathname.replace(/\\/r(?:\\/(?:day|week|month|year|custom))?(?:\\/.*)?$/, '');
      location.href = base + '/r/${view}';
      return true;
    })()
  `);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const ready = await evaluate(
      `new RegExp('/r/${view}(?:/|$)').test(location.pathname) &&
       document.querySelector('[data-viewkey]') !== null`,
    ).catch(() => false);
    if (ready) {
      await sleep(700);
      return;
    }
  }
}

/**
 * Combines one nav check's verdicts across the views it ran in.
 *
 * A control that resolves in one view but not another is the day-only regression: the
 * matcher is tied to a name a single view renders. `none` in every view is a genuine
 * absence and stays a skip; a failure in any view is a failure.
 */
function judgeAcrossViews(check, perView) {
  const hook = hookDescription(check.action);
  const failed = perView.find((p) => p.verdict.status === 'fail');
  if (failed) return failed.verdict;
  const passed = perView.filter((p) => p.verdict.status === 'pass');
  const skipped = perView.filter((p) => p.verdict.status === 'skip');
  if (passed.length === perView.length) {
    return {
      name: check.name,
      hook,
      status: 'pass',
      observed: `resolved uniquely in ${perView.map((p) => p.view).join(', ')}`,
    };
  }
  if (skipped.length === perView.length) {
    return { name: check.name, hook, status: 'skip', observed: 'not laid out in any checked view' };
  }
  return {
    name: check.name,
    hook,
    status: 'fail',
    observed:
      `resolved in ${passed.map((p) => p.view).join(', ')} but not ` +
      skipped.map((p) => p.view).join(', '),
  };
}

/**
 * Closes whatever Calendar event panel is open and waits, bounded, for it to leave so
 * the grid is clickable again. The panel's own close button is preferred; Escape is
 * the fallback for a panel that renders without one.
 */
async function closeCalendarPanel() {
  await evaluate(`
    (async () => {
      const close = document.querySelector('#xDetDlgCloseBu');
      if (close) {
        close.click();
      } else {
        for (const type of ['keydown', 'keyup']) {
          document.dispatchEvent(new KeyboardEvent(type, {
            key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true,
          }));
        }
      }
      return true;
    })()
  `);
  for (let i = 0; i < 20; i++) {
    const open = await evaluate(`document.getElementById('xDetDlg') !== null`);
    if (!open) return;
    await sleep(150);
  }
}

/**
 * The ids of the event chips laid out in the grid, polled because a grid mid-render
 * after a route change or a panel close reads as empty. An empty list after the wait is
 * a genuinely empty grid.
 */
async function laidOutChipIds(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ids = await evaluate(`
      [...new Set(Array.from(document.querySelectorAll('[data-eventid]'))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((el) => el.getAttribute('data-eventid')))]
    `);
    if (ids.length > 0 || Date.now() > deadline) return ids;
    await sleep(250);
  }
}

/**
 * Opens one chip and reports whether its panel arrived.
 *
 * A plain `click()` on the chip element is enough — Google's handler takes it — and
 * waiting inside the page keeps this to a single round trip. The panel is the evidence
 * a person would use too, so nothing here is cleverer than clicking and looking.
 */
/**
 * Opens one chip and reports whether its panel arrived.
 *
 * The click goes through CDP's input domain rather than `el.click()`: Google's chip
 * handler does not trust a synthesized DOM click, so it opens the panel only sometimes
 * (or falls through to the full editor). A real mouse event at the chip's centre is the
 * input a person gives it, and the panel is then polled for rather than guessed at with
 * a fixed wait.
 */
async function openChipPanel(id) {
  const box = await evaluate(`
    (() => {
      const el = Array.from(document.querySelectorAll('[data-eventid]'))
        .find((node) => node.getAttribute('data-eventid') === ${JSON.stringify(id)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()
  `);
  if (!box) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Google opens the peek panel only when the app is the frontmost application: a chip
    // click while another window is in front is received by nothing. `Page.bringToFront`
    // only orders the tab inside Chromium, so the OS activation is the half that matters,
    // and another window can take the front back between attempts.
    frontApp();
    await sendCdp('Page.bringToFront', {});
    await sleep(250);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await sendCdp('Input.dispatchMouseEvent', {
        type,
        x: box.x,
        y: box.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
    }
    for (let i = 0; i < 15; i++) {
      if (await evaluate(`document.getElementById('xDetDlg') !== null`)) return true;
      await sleep(100);
    }
  }
  return false;
}

/**
 * Opens each laid-out event chip in turn and records the panel hooks that resolve
 * while its panel is open. Delete lives on any event panel; the RSVP buttons only on an
 * invitation, so a panel that holds none leaves those a skip. The chips are re-read
 * after each panel closes, so a grid that renders late is still reached. The chip is
 * only setup: each hook is still resolved and judged by `findAction` afterwards.
 */
async function checkCalendarPanels(checks) {
  const found = new Map();
  let panelSeen = false;
  let chipSeen = false;
  const scanned = new Set();
  for (let i = 0; i < 50 && found.size < checks.length; i++) {
    const ids = await laidOutChipIds();
    if (process.env.DOM_DRIFT_DEBUG)
      console.error('[debug] chips', ids.length, ids.map((id) => id.slice(0, 8)).join(','));
    chipSeen = chipSeen || ids.length > 0;
    const id = ids.find((candidate) => !scanned.has(candidate));
    if (!id) break;
    scanned.add(id);
    const panel = await openChipPanel(id);
    // A chip that opens the full editor instead of the peek navigates the view; leave
    // it and come back to the grid so the remaining chips stay reachable.
    const onWeek = await evaluate(`location.pathname.includes('/r/week')`);
    if (process.env.DOM_DRIFT_DEBUG)
      console.error('[debug] chip', id.slice(0, 8), 'panel', panel, 'onWeek', onWeek);
    if (!onWeek) {
      await evaluate(`
        for (const type of ['keydown', 'keyup']) {
          document.dispatchEvent(new KeyboardEvent(type, {
            key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true,
          }));
        }
        true
      `);
      await routeToView('week');
    }
    panelSeen = panelSeen || panel;
    for (const check of checks) {
      if (found.has(check.name)) continue;
      const verdict = await runCheck(check);
      if (verdict.status !== 'skip') found.set(check.name, verdict);
    }
    await closeCalendarPanel();
  }
  return checks.map((check) => {
    if (found.has(check.name)) return found.get(check.name);
    // A panel did open, so the grid did offer the state; a delete hook that is absent
    // there is drift rather than a skip.
    if (check.name === 'delete event' && panelSeen) {
      return {
        name: check.name,
        hook: hookDescription(check.action),
        status: 'fail',
        observed: 'event panel open but hook not laid out',
      };
    }
    return {
      name: check.name,
      hook: hookDescription(check.action),
      status: 'skip',
      // A chip that was laid out and clicked, but whose panel never arrived, is not an
      // empty grid: saying so sends the reader looking for events that are on screen.
      observed:
        chipSeen && !panelSeen
          ? 'a chip was laid out but its panel never opened'
          : check.skipReason,
    };
  });
}

/**
 * Opens Calendar's search view, checks the `Go back` hook that only renders there,
 * then closes search, clears the query and routes back to the view it started in. The
 * query only reaches the state; the hook is still resolved and judged by `findAction`.
 */
async function checkCalendarGoBack(check, returnView) {
  const query = await evaluate(`
    (() => {
      for (const el of document.querySelectorAll('[data-eventid]')) {
        const match = (el.textContent || '').match(/[A-Za-z]{3,}/);
        if (match) return match[0];
      }
      return 'event';
    })()
  `);
  await evaluate(`
    (async () => {
      const input = document.querySelector('input[name="q"]');
      if (input && input.getBoundingClientRect().width > 0) {
        input.focus();
        input.select();
      } else {
        const button = Array.from(document.querySelectorAll('[aria-label]')).find(
          (el) => (el.getAttribute('aria-label') || '').trim() === 'Search' &&
                  el.getBoundingClientRect().width > 0,
        );
        if (button) button.click();
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      const field = document.querySelector('input[name="q"]');
      if (!field) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      field.focus();
      setter.call(field, ${JSON.stringify(query)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
      }));
      return true;
    })()
  `);
  let inSearch = false;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    inSearch = await evaluate(`location.pathname.includes('/search')`);
    if (inSearch) break;
  }
  const verdict = inSearch
    ? await runCheck(check)
    : {
        name: check.name,
        hook: hookDescription(check.action),
        status: 'skip',
        observed: 'the search view did not open',
      };
  await evaluate(`
    (async () => {
      const back = Array.from(document.querySelectorAll('[aria-label]')).find(
        (el) => (el.getAttribute('aria-label') || '').trim() === 'Go back' &&
                el.getBoundingClientRect().width > 0,
      );
      if (back) back.click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const field = document.querySelector('input[name="q"]');
      if (field) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(field, '');
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    })()
  `);
  const onView = await evaluate(`new RegExp('/r/${returnView}(?:/|$)').test(location.pathname)`);
  if (!onView) await routeToView(returnView);
  return verdict;
}

async function checkCalendar() {
  const panelChecks = [
    {
      name: 'delete event',
      band: 'hook',
      skipReason: 'no event laid out in the grid',
      action: { selectors: ['#xDetDlgDelBu'], order: 'only' },
      oracle: { attr: 'aria-label', value: ['Delete event', 'Remove from this calendar'] },
    },
    {
      name: 'rsvp yes',
      band: 'hook',
      skipReason: 'no invitation among the events laid out in the grid',
      action: { selectors: ['#xRsvpYesBu'], order: 'only' },
      // Live on 2026-10-01 this reads "Respond Yes"; the quoted form is what it was first
      // written against. Both are accepted, because an account whose wording differs by a
      // pair of quotes is not drift.
      oracle: { attr: 'aria-label', value: ["Respond 'Yes'", 'Respond Yes'] },
    },
    {
      name: 'rsvp no',
      band: 'hook',
      skipReason: 'no invitation among the events laid out in the grid',
      action: { selectors: ['#xRsvpNoBu'], order: 'only' },
      oracle: { attr: 'aria-label', value: ["Respond 'No'", 'Respond No'] },
    },
    {
      name: 'rsvp maybe',
      band: 'hook',
      skipReason: 'no invitation among the events laid out in the grid',
      action: { selectors: ['#xRsvpMaybeBu'], order: 'only' },
      oracle: { attr: 'aria-label', value: ["Respond 'Maybe'", 'Respond Maybe'] },
    },
  ];
  const navChecks = [
    // The nav controls carry no hook: the accessible name is the only handle, so the
    // assertion is that `order: 'only'` still resolves one control rather than
    // reporting an ambiguous second. Comparing the name to itself would prove nothing.
    // These four are named in `views`, so they are resolved in each view in turn: a
    // matcher that only fits one view's wording resolves nowhere in the other.
    {
      name: 'nav search',
      band: 'label',
      views: ['day', 'week'],
      action: { labels: { en: ['Search'] }, attrs: ['aria-label'], order: 'only' },
    },
    {
      name: 'nav today',
      band: 'label',
      views: ['day', 'week'],
      action: {
        labels: { en: ['Today'] },
        match: 'startsWith',
        attrs: ['aria-label'],
        order: 'only',
      },
    },
    {
      name: 'nav previous',
      band: 'label',
      views: ['day', 'week'],
      action: {
        labels: { en: ['Previous'] },
        match: 'startsWith',
        attrs: ['aria-label'],
        exclude: ['#drawerMiniMonthNavigator'],
        order: 'only',
      },
    },
    {
      name: 'nav next',
      band: 'label',
      views: ['day', 'week'],
      action: {
        labels: { en: ['Next'] },
        match: 'startsWith',
        attrs: ['aria-label'],
        exclude: ['#drawerMiniMonthNavigator'],
        order: 'only',
      },
    },
  ];
  const backCheck = {
    name: 'nav go back',
    band: 'label',
    action: { labels: { en: ['Go back'] }, attrs: ['aria-label'], order: 'only' },
  };

  // The panel hooks only exist while an event panel is open, so route to a view that
  // lays chips out and open them one at a time. The nav checks then drive day and
  // week themselves; `Go back` needs the search view, opened last and closed after.
  await routeToView('week');
  const results = await checkCalendarPanels(panelChecks);
  for (const check of navChecks) {
    const perView = [];
    for (const view of check.views) {
      await routeToView(view);
      perView.push({ view, verdict: await runCheck(check) });
    }
    results.push(judgeAcrossViews(check, perView));
  }
  results.push(await checkCalendarGoBack(backCheck, 'week'));
  return results;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let results;
try {
  const lang = await evaluate('document.documentElement.lang || ""');
  if (!/^en\b/i.test(lang)) {
    console.error(
      `✗ The view is not in English (document.documentElement.lang = ${JSON.stringify(lang)}).`,
    );
    console.error(
      '  The English label is the oracle, so the canary only runs on an English account.',
    );
    process.exit(1);
  }
  results = app === 'magical' ? await checkCalendar() : await checkGmail();
} catch (err) {
  if (!(err instanceof PageGoneError)) throw err;
  // A page that is not there cannot have offered anything, so this is not a result.
  // Printing a table of skips for it would read as a run that had checked the page.
  console.error(`✗ The ${app} page went away before every check had run.`);
  console.error("  Both apps release an idle account's view after inactiveAccountSuspendMinutes,");
  console.error('  and a released view is not an empty page. Raise that setting — 0 keeps every');
  console.error('  visited account resident — relaunch the app, and run again.');
  process.exit(1);
} finally {
  ws?.close();
}

const width = {
  status: Math.max(6, ...results.map((r) => r.status.length)),
  name: Math.max(4, ...results.map((r) => r.name.length)),
  hook: Math.max(4, ...results.map((r) => r.hook.length)),
};
console.log(
  `${'RESULT'.padEnd(width.status)}  ${'ACTION'.padEnd(width.name)}  ${'HOOK'.padEnd(width.hook)}  OBSERVED`,
);
for (const r of results) {
  console.log(
    `${r.status.padEnd(width.status)}  ${r.name.padEnd(width.name)}  ${r.hook.padEnd(width.hook)}  ${r.observed}`,
  );
}

const failed = results.filter((r) => r.status === 'fail').length;
const skipped = results.filter((r) => r.status === 'skip').length;
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped.`);
if (app === 'magical' && skipped > 0) {
  console.log(
    'A skip names a state the grid did not offer: no event chip, or no invitation among them.',
  );
}
if (reattached) {
  console.log(
    'The view was replaced mid-run: checks after that point ran against a fresh page, not the one',
  );
  console.log('that was attached when the run started.');
}
process.exit(failed > 0 ? 1 : 0);
