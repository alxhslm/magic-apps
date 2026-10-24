#!/usr/bin/env node
/**
 * replay-calendar-wire.mjs
 *
 * Runs a saved range payload through the production decoder and recurrence expander and lists what
 * the app would show that Google's Calendar API does not have, and vice versa. Offline: no app, no
 * polling, no reinstall — the capture is the only input. See
 * `.agents/skills/replaying-the-calendar-wire/SKILL.md`.
 *
 * Usage:
 *   node tools/replay-calendar-wire.mjs --map /tmp/corpus/map.json --truth /tmp/corpus/truth.json \
 *     --from 2026-10-02T00:00:00Z --to 2026-12-12T23:59:59Z
 *
 * `--map` is `{ "<capture path>": "<account email>" }` and `--truth` is the same
 * `{ "<account email>": [event, …] }` shape the truth fetch writes.
 *
 * Build first: the decoder and expander are required from `apps/magical/dist`, as the other
 * canaries do, so `pnpm --filter magical run build` must have run.
 *
 * Matching is uid-and-instant first, then title-and-instant. The API returns one entry per calendar
 * holding an event and the two copies of one meeting carry different titles per calendar, while the
 * app folds them into one; the uid names the meeting on both sides. An imported calendar spells its
 * `iCalUID` differently from the wire's `uid`, which the title fallback pairs up.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
let mapPath = null;
let truthPath = null;
let from = null;
let to = null;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--map') mapPath = argv[++i];
  else if (arg === '--truth') truthPath = argv[++i];
  else if (arg === '--from') from = argv[++i];
  else if (arg === '--to') to = argv[++i];
  else if (arg === '--help' || arg === '-h') {
    console.log(
      'usage: node tools/replay-calendar-wire.mjs --map <map.json> --truth <truth.json> --from <ISO> --to <ISO>',
    );
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }
}

if (!mapPath || !truthPath || !from || !to) {
  console.error('--map, --truth, --from and --to are required');
  process.exit(1);
}

let decoder;
let recurrence;
try {
  decoder = require('../apps/magical/dist/calendar-decoder.js');
  recurrence = require('../apps/magical/dist/calendar-recurrence.js');
} catch {
  console.error('cannot load the build; run `pnpm --filter magical run build` first');
  process.exit(1);
}

const range = { start: new Date(from), end: new Date(to) };
const norm = (s) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
/** The meeting, without the domain or the occurrence suffix the two sides spell differently. */
const uidOf = (u) =>
  (u ?? '')
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/_[r]?\d{8}(t\d{6})?z?$/, '');
const uidKey = (uid, instant) => `uid:${uidOf(uid)}|${instant}`;
const sumKey = (summary, instant) => `sum:${norm(summary)}|${instant}`;
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const take = (m, k) => {
  const held = m.get(k) ?? 0;
  if (held < 1) return false;
  m.set(k, held - 1);
  return true;
};
const at = (instant) => new Date(instant).toISOString().slice(0, 16).replace('T', ' ');

const feeds = Object.entries(JSON.parse(readFileSync(mapPath, 'utf8')));
const truth = JSON.parse(readFileSync(truthPath, 'utf8'));

for (const [file, email] of feeds) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    console.log(`\n### ${email}: no capture at ${file}`);
    continue;
  }

  const decoded = decoder.parsePrefetchEventRangeResponse(raw, 'replay').events;
  const out = recurrence.expandRecurringEvents(decoded, range);

  const apiRows = [];
  for (const e of truth[email] ?? []) {
    if (e.status === 'cancelled') continue;
    const s = e.start ?? {};
    const en = e.end ?? {};
    const start = s.date ? Date.parse(`${s.date}T00:00:00.000Z`) : Date.parse(s.dateTime);
    const end = en.date ? Date.parse(`${en.date}T00:00:00.000Z`) : Date.parse(en.dateTime);
    if (!Number.isFinite(start)) continue;
    if (start > range.end.getTime() || (Number.isFinite(end) && end < range.start.getTime())) {
      continue;
    }
    apiRows.push({ uid: e.iCalUID, summary: e.summary, instant: start });
  }
  const appRows = out.map((e) => ({
    uid: e.uid,
    summary: e.summary,
    instant: e.startTime.getTime(),
  }));

  const appByUid = new Map();
  const appBySum = new Map();
  for (const r of appRows) {
    bump(appByUid, uidKey(r.uid, r.instant));
    bump(appBySum, sumKey(r.summary, r.instant));
  }
  const missing = [];
  for (const r of apiRows) {
    if (take(appByUid, uidKey(r.uid, r.instant))) continue;
    if (take(appBySum, sumKey(r.summary, r.instant))) continue;
    missing.push(`${(r.summary ?? '').slice(0, 46)} @ ${at(r.instant)}`);
  }

  const apiByUid = new Map();
  const apiBySum = new Map();
  for (const r of apiRows) {
    bump(apiByUid, uidKey(r.uid, r.instant));
    bump(apiBySum, sumKey(r.summary, r.instant));
  }
  const extra = [];
  for (const r of appRows) {
    if (take(apiByUid, uidKey(r.uid, r.instant))) continue;
    if (take(apiBySum, sumKey(r.summary, r.instant))) continue;
    extra.push(`${(r.summary ?? '').slice(0, 46)} @ ${at(r.instant)}`);
  }

  console.log(
    `\n### ${email}: decoded=${out.length} api=${apiRows.length} missing=${missing.length} extra=${extra.length}`,
  );
  for (const m of missing.sort()) console.log('  MISSING ', m);
  for (const x of extra.sort()) console.log('  EXTRA   ', x);
}
