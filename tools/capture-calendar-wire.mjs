#!/usr/bin/env node
/**
 * capture-calendar-wire.mjs
 *
 * Saves the raw calendar range payload — the protobuf-in-arrays response behind Google's `)]}'`
 * guard — for one or more calendars, so the decoder and the recurrence expander can be replayed
 * against it offline. See `.agents/skills/replaying-the-calendar-wire/SKILL.md`.
 *
 * The payload is the wire. It is full of the account's own data, so it is written wherever `--out`
 * says and never into the repository: use a path under `/tmp` and keep it there.
 *
 * Usage:
 *   node tools/capture-calendar-wire.mjs --out /tmp/corpus/sample-corpus.txt \
 *     --calendar taylor@example.com --calendar family@group.calendar.google.com \
 *     [--port 9223] [--back 9] [--ahead 62]
 *
 * `--back` and `--ahead` default to the poll window Magical actually asks for, so the capture is
 * the payload the app sees rather than a wider one Google answers differently. See
 * `.agents/skills/replaying-the-calendar-wire/SKILL.md` for why that matters.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
let port = process.env.CDP_PORT || '9223';
let out = null;
let back = 9;
let ahead = 62;
const calendars = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--port') port = argv[++i];
  else if (arg === '--out') out = argv[++i];
  else if (arg === '--calendar') calendars.push(argv[++i]);
  else if (arg === '--calendars-file') {
    // A JSON array of calendar ids, which is what the app's own request carries and what an
    // `accounts.json` entry holds. Passing a dozen ids as separate shell arguments invites quoting
    // mistakes that come back as an empty payload rather than as an error.
    const parsed = JSON.parse(readFileSync(argv[++i], 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('--calendars-file must hold a JSON array');
    calendars.push(...parsed.filter((id) => typeof id === 'string'));
  } else if (arg === '--back') back = Number.parseInt(argv[++i], 10);
  else if (arg === '--ahead') ahead = Number.parseInt(argv[++i], 10);
  else if (arg === '--help' || arg === '-h') {
    console.log(
      'usage: node tools/capture-calendar-wire.mjs --out <file> (--calendar <id>… | --calendars-file <json>) [--port N] [--back N] [--ahead N]',
    );
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }
}

if (!out || calendars.length === 0) {
  console.error('--out and at least one --calendar are required');
  process.exit(1);
}

const startDay = Math.floor(Date.now() / 86_400_000) - back;
const endDay = startDay + back + ahead;

// The body is `buildEventRangeBody` in `apps/magical/src/calendar-poller.ts`, character for
// character. The client build label and capability flags do not merely decorate the request: the
// endpoint answers a different client with a different *shape*, and a capture sent with the wrong
// fingerprint comes back without the series' occurrence schedules — which reads as a hundred
// missing events. Keep this in step with the poller or the capture stops describing the app.
const CLIENT_BUILD_LABEL = 'calendar.web_20260909.10_p0';
// Index 6 is `1` on purpose: it is the capability bit that makes the endpoint include each
// recurring series' own occurrence schedule. With `0` the same request comes back with rules and
// materialised occurrences only, which is the shape a capture must NOT be checked against.
const CLIENT_FLAGS = [null, 1, 1, 1, 1, null, 1, 0];
const clientBlock = [
  null,
  3,
  CLIENT_BUILD_LABEL,
  null,
  null,
  null,
  null,
  978601681,
  null,
  'WEB',
  'prod-00-eu.web',
  1,
  null,
  null,
  null,
  0,
  null,
  '2026c',
  1,
  1,
  null,
  1,
  1,
  null,
  1,
  1,
  1,
];

const expression = [
  '(async () => {',
  '  const m = location.pathname.match(/\\/calendar\\/u\\/(\\d+)/);',
  "  const idx = m ? m[1] : '0';",
  `  const payload = [[${JSON.stringify(calendars)}, [null, null, ${startDay}, ${endDay}],`,
  `    ${JSON.stringify(clientBlock)},`,
  `    ${JSON.stringify(CLIENT_FLAGS)}]];`,
  "  const res = await fetch('/calendar/u/' + idx + '/sync.prefetcheventrange', {",
  "    method: 'POST',",
  "    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Is-Xhr-Request': '1', 'X-If-No-Redirect': '1' },",
  "    cache: 'no-store',",
  "    body: 'f.req=' + encodeURIComponent(JSON.stringify(payload))",
  '  });',
  '  return await res.text();',
  '})()',
].join('\n');

const targets = await (await globalThis.fetch(`http://127.0.0.1:${port}/json/list`)).json();
const pages = targets.filter(
  (t) => t.type === 'page' && (t.url || '').includes('calendar.google.com'),
);
if (pages.length === 0) {
  console.error(
    `no calendar page on the debug port ${port}; is Magical running with --debug-port?`,
  );
  process.exit(1);
}

/**
 * Reads the payload from one page.
 *
 * Magical keeps a calendar view alive per account, so several pages answer here and they are not
 * interchangeable: the endpoint returns an empty calendar list for an account that does not hold
 * the calendars asked for. The caller is the account whose view is in front, and only the page
 * holding those calendars answers with events.
 */
async function captureFrom(page) {
  const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  try {
    const body = await new Promise((resolve, reject) => {
      ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id === 1) resolve(message.result?.result?.value);
      });
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
      setTimeout(() => reject(new Error('timed out reading the wire')), 60_000);
    });
    return String(body);
  } finally {
    ws.close();
  }
}

function countEvents(text) {
  try {
    const parsed = JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
    let rows = 0;
    for (const calendar of parsed[0][2][1] ?? []) {
      if (!Array.isArray(calendar) || !Array.isArray(calendar[1])) continue;
      for (const tuple of calendar[1]) if (Array.isArray(tuple) && Array.isArray(tuple[35])) rows++;
    }
    return rows;
  } catch {
    return 0;
  }
}

// Try every calendar page and keep the one with the most events: the others belong to accounts
// that do not hold these calendars and answer an empty list.
let best = { text: '', rows: 0, url: '' };
for (const page of pages) {
  const text = await captureFrom(page);
  const rows = countEvents(text);
  if (rows > best.rows) best = { text, rows, url: page.url };
}

// The payload is written whatever it holds: an empty answer is the evidence that the calendars
// asked for are not this account's, and it is better to have the bytes than a bare exit code.
if (best.rows === 0) {
  console.error(
    'no page returned events for those calendars; is the account whose calendar you want the active one?',
  );
}

writeFileSync(out, best.text);
console.log(`wrote ${out}`);
console.log(`  window  -${back}d .. +${ahead}d`);
console.log(`  events  ${best.rows}`);
console.log("  the file holds the account's own data: keep it under /tmp, never in the repo");
