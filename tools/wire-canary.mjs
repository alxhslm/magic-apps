#!/usr/bin/env node
/**
 * wire-canary.mjs
 *
 * Verifies that the live calendar sync feed format matches the schema expected
 * by the production decoder in apps/magical/src/calendar-decoder.ts. Evaluates
 * feeds in memory against a running test session without persisting event records.
 */

import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// 1. Argument parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
let port = process.env.CDP_PORT || '9223';
let targetMatch = '';
let rangeDays = 14;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--port') {
    port = argv[++i];
  } else if (arg === '--target') {
    targetMatch = argv[++i];
  } else if (arg === '--range') {
    rangeDays = Number.parseInt(argv[++i], 10) || 14;
  } else if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    printHelp();
    process.exit(1);
  }
}

function printHelp() {
  console.log(`Usage: node tools/wire-canary.mjs [options]

Options:
  --port <port>       CDP port for running Magical demo instance (default: 9223)
  --target <match>    Filter page target title by substring (e.g. test account email)
  --range <days>      Event range in days to fetch from live endpoint (default: 14)
  --help, -h          Show this help message`);
}

function loadDecoder() {
  const realLoad = Module._load;
  const noop = () => {};
  const loggerStub = {
    createLogger: () => ({
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      verbose: noop,
      silly: noop,
    }),
    redactUrl: (s) => s,
    redactText: (s) => s,
    redactValue: (s) => s,
  };

  Module._load = function (request, ...rest) {
    if (request.includes('logger')) return loggerStub;
    if (request === 'electron') return new Proxy({}, { get: () => function electronStub() {} });
    return realLoad.call(this, request, ...rest);
  };

  try {
    return require('../apps/magical/dist/calendar-decoder.js');
  } catch (err) {
    console.error('✗ Cannot load calendar decoder from apps/magical/dist/calendar-decoder.js');
    console.error('  Build the app first: pnpm --filter magical run build');
    console.error(`  ${err.message}`);
    process.exit(1);
  }
}

const decoder = loadDecoder();
const {
  IDX,
  parsePrefetchEventRangeResponse,
  stripXssiGuard,
  parseTimestampTuple,
  isUnauthenticatedResponse,
} = decoder;

function sendCdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 100000);
    let settled = false;
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      ws.removeEventListener('close', onClose);
      ws.removeEventListener('error', onError);
    };

    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };

    const onMsg = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.id === id) settle(resolve, data);
      } catch (err) {
        settle(reject, err);
      }
    };

    const onClose = () => settle(reject, new Error('CDP page connection closed unexpectedly'));
    const onError = () => settle(reject, new Error('CDP debugger connection error'));

    timer = setTimeout(
      () => settle(reject, new Error('CDP evaluation timed out after 30s')),
      30000,
    );
    timer.unref?.();

    ws.addEventListener('message', onMsg);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError);

    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      settle(reject, err);
    }
  });
}

// ---------------------------------------------------------------------------
// 4. Fetch live payload via CDP (strictly in-memory)
// ---------------------------------------------------------------------------

async function fetchLiveWirePayload() {
  console.log(`Connecting to CDP on 127.0.0.1:${port}...`);
  let targets;
  try {
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/json/list`);
    targets = await res.json();
  } catch {
    console.error(`✗ Cannot connect to CDP on 127.0.0.1:${port}`);
    console.error('  Launch Magical in demo mode with debug port:');
    console.error(
      '    nohup /Applications/Magical.app/Contents/MacOS/Magical --demo --debug-port=9223 >/tmp/magical-demo.log 2>&1 &',
    );
    process.exit(2);
  }

  const pages = targets.filter((t) => t.type === 'page');
  const calPages = pages.filter((t) => (t.url || '').includes('calendar.google.com'));
  const candidate = targetMatch
    ? calPages.find((t) => (t.title || '').toLowerCase().includes(targetMatch.toLowerCase()))
    : calPages[0];

  if (!candidate || !candidate.webSocketDebuggerUrl) {
    console.error(`✗ No active calendar.google.com target found on port ${port}. Found targets:`);
    for (const t of pages) console.error(`  - [${t.type}] ${t.title}`);
    process.exit(2);
  }

  console.log(`✓ Attached to page target: "${candidate.title}"`);

  const ws = new globalThis.WebSocket(candidate.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  try {
    // 1. Discover account details and calendar IDs directly within page context
    const discoveryExpr = `(() => {
      const ids = [];
      for (const div of document.querySelectorAll('div[data-id]')) {
        try {
          const decoded = atob(div.getAttribute('data-id') || '');
          if (decoded && decoded.includes('@') && !ids.includes(decoded)) {
            ids.push(decoded);
          }
        } catch {}
      }
      if (ids.length === 0) {
        try {
          const data = JSON.parse(document.getElementById('initialdata')?.textContent || '');
          const list = data?.[39]?.[1]?.[2]?.[1];
          if (Array.isArray(list)) {
            for (const item of list) {
              const id = item?.[1]?.[0];
              if (typeof id === 'string' && id.includes('@') && !ids.includes(id)) {
                ids.push(id);
              }
            }
          }
        } catch {}
      }
      const match = window.location.pathname.match(/\\/calendar\\/u\\/(\\d+)/);
      const accountIndex = match ? match[1] : '0';
      return { calendarCount: ids.length, ids, accountIndex };
    })()`;

    const discoveryRes = await sendCdp(ws, 'Runtime.evaluate', {
      expression: discoveryExpr,
      returnByValue: true,
      awaitPromise: true,
    });

    if (discoveryRes?.result?.exceptionDetails) {
      const exc = discoveryRes.result.exceptionDetails;
      console.error('✗ Discovery exception:', exc.exception?.description || exc.text);
    }

    const discovery = discoveryRes?.result?.result?.value ||
      discoveryRes?.result?.value || {
        ids: [],
        accountIndex: '0',
        calendarCount: 0,
      };
    const accountIndex = discovery.accountIndex;
    const calendarIds = discovery.ids && discovery.ids.length > 0 ? discovery.ids : ['primary'];

    console.log(`  Account index: /u/${accountIndex}`);
    console.log(`  Discovered ${discovery.calendarCount} subscribed calendar(s)`);

    const fetchExpr = `(async () => {
      const MS_PER_DAY = 86400000;
      const now = new Date();
      const startDay = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / MS_PER_DAY);
      const endDay = startDay + ${rangeDays};
      const CLIENT_BUILD_LABEL = '1017.0.0';
      const CLIENT_FLAGS = [null, 1, 0, null, 1, null, 1, 1, null, null, null, null, null, null, 1, null, 0];
      const payload = [
        [
          ${JSON.stringify(calendarIds)},
          [null, null, startDay, endDay],
          [
            null, 3, CLIENT_BUILD_LABEL, null, null, null, null, 978601681, null,
            'WEB', 'prod-00-eu.web', 1, null, null, null, 0, null, '2026c', 1, 1,
            null, 1, 1, null, 1, 1, 1
          ],
          CLIENT_FLAGS
        ]
      ];
      const body = 'f.req=' + encodeURIComponent(JSON.stringify(payload));
      try {
        const res = await window.fetch('/calendar/u/${accountIndex}/sync.prefetcheventrange', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'X-Is-Xhr-Request': '1',
            'X-If-No-Redirect': '1'
          },
          cache: 'no-store',
          body
        });
        const text = await res.text();
        return { ok: res.ok, status: res.status, text };
      } catch (err) {
        return { ok: false, status: 0, error: String(err) };
      }
    })()`;

    console.log(`  Querying calendar sync feed (${rangeDays} days range)...`);
    const fetchRes = await sendCdp(ws, 'Runtime.evaluate', {
      expression: fetchExpr,
      returnByValue: true,
      awaitPromise: true,
    });

    if (fetchRes?.result?.exceptionDetails) {
      const exc = fetchRes.result.exceptionDetails;
      console.error('✗ In-page fetch exception:', exc.exception?.description || exc.text);
    }

    const result = fetchRes?.result?.result?.value || fetchRes?.result?.value;
    if (!result) {
      throw new Error(
        `No response returned from in-page fetch evaluation: ${JSON.stringify(fetchRes)}`,
      );
    }
    return result;
  } finally {
    ws.close();
  }
}

async function runCanary() {
  const fetchResult = await fetchLiveWirePayload();

  if (
    fetchResult.status === 401 ||
    (fetchResult.text && fetchResult.text.includes('ServiceLogin'))
  ) {
    console.error('\n✗ [AUTH EXPIRED] Session expired or unauthenticated (HTTP 401).');
    console.error('  Log into your test account in the Magical demo window first.');
    process.exit(2);
  }

  if (!fetchResult.ok) {
    console.error(
      `\n✗ [HTTP ERROR] Fetch returned HTTP ${fetchResult.status}: ${fetchResult.error || ''}`,
    );
    process.exit(1);
  }

  const rawText = fetchResult.text;

  console.log('\n--- Calendar Sync Feed Verification ---');
  const checks = [];

  // Check 1: Anti-XSSI guard
  const hasXssiGuard = rawText.startsWith(")]}'\n\n") || rawText.startsWith(")]}'");
  checks.push({
    name: 'Anti-XSSI Guard',
    status: hasXssiGuard ? 'pass' : 'fail',
    detail: hasXssiGuard ? "Body starts with standard )]}' prefix" : "Missing standard )]}' prefix",
  });

  // Check 2: JSON parseability
  let parsed = null;
  try {
    const stripped = stripXssiGuard(rawText);
    parsed = JSON.parse(stripped);
    checks.push({
      name: 'JSON Parse',
      status: 'pass',
      detail: `Valid JSON array (${Array.isArray(parsed) ? `${parsed.length} root items` : typeof parsed})`,
    });
  } catch (err) {
    checks.push({
      name: 'JSON Parse',
      status: 'fail',
      detail: `Parse error: ${err.message}`,
    });
    reportResults(checks);
    process.exit(1);
  }

  // Check for Google unauthenticated error envelope: [["er", null, "401"]]
  if (isUnauthenticatedResponse(parsed)) {
    console.error('\n✗ [AUTH EXPIRED] Google returned unauthenticated error envelope ("er").');
    console.error('  Please log into your test account in the Magical demo window.');
    process.exit(2);
  }

  // Check 3: Action token
  const actionBlock = Array.isArray(parsed) ? parsed[0] : null;
  const actionToken = Array.isArray(actionBlock) ? actionBlock[0] : null;
  const isPerr = actionToken === 'prefetcheventrangeaction.perr';
  checks.push({
    name: 'Action Token',
    status: isPerr ? 'pass' : 'fail',
    detail: `[0.0] is "${actionToken}" (expected "prefetcheventrangeaction.perr")`,
  });

  // Check 4: Payload block & Sync token
  const payloadBlock = Array.isArray(actionBlock) ? actionBlock[2] : null;
  const syncToken = Array.isArray(payloadBlock) ? payloadBlock[0] : null;
  const hasSyncToken = typeof syncToken === 'string' && syncToken.length > 0;
  checks.push({
    name: 'Sync Token',
    status: hasSyncToken ? 'pass' : 'fail',
    detail: hasSyncToken
      ? `[0.2.0] is non-empty string (${syncToken.length} chars)`
      : '[0.2.0] sync token missing',
  });

  // Check 5: Calendars block
  const calendarsBlock = Array.isArray(payloadBlock) ? payloadBlock[1] : null;
  const hasCalendars = Array.isArray(calendarsBlock) && calendarsBlock.length > 0;
  checks.push({
    name: 'Calendar Blocks',
    status: hasCalendars ? 'pass' : 'fail',
    detail: hasCalendars
      ? `Found ${calendarsBlock.length} calendar block(s)`
      : 'No calendar blocks in [0.2.1]',
  });

  // Check 6: Event tuples structural inspection
  if (hasCalendars) {
    for (const c of calendarsBlock) {
      console.log(
        '  Calendar structure:',
        c.map((x) => (Array.isArray(x) ? `Array(${x.length})` : typeof x)),
      );
    }
  }
  const allTuples = [];
  if (hasCalendars) {
    for (const calEntry of calendarsBlock) {
      if (!Array.isArray(calEntry)) continue;
      const eventList = calEntry[1];
      if (Array.isArray(eventList)) {
        for (const ev of eventList) {
          if (Array.isArray(ev)) allTuples.push(ev);
        }
      }
    }
  }

  checks.push({
    name: 'Event Tuples',
    status: allTuples.length > 0 ? 'pass' : 'skip',
    detail: `Extracted ${allTuples.length} raw event tuple(s)`,
  });

  // Check 7: Pinned Indices & Structural Invariants (Strictly types, NO event content)
  const indexFieldTests = [
    {
      name: 'Event ID',
      idx: IDX.id,
      validate: (v) => typeof v === 'string' && v.length > 0,
      required: true,
    },
    {
      name: 'Event Status',
      idx: IDX.status,
      validate: (v) => typeof v === 'number' && (v === 0 || v === 2),
      required: true,
    },
    {
      name: 'Summary',
      idx: IDX.summary,
      validate: (v) => typeof v === 'string' || v === null,
      required: false,
    },
    {
      name: 'Start Timestamp',
      idx: IDX.start,
      validate: (v) => validateTimestamp(v),
      required: true,
      liveOnly: true,
    },
    {
      name: 'End Timestamp',
      idx: IDX.end,
      validate: (v) => validateTimestamp(v),
      required: true,
      liveOnly: true,
    },
    {
      name: 'Recurrence Rule',
      idx: IDX.recurrence,
      validate: (v) => Array.isArray(v) && v.every((r) => typeof r === 'string'),
      required: false,
    },
    {
      name: 'Event Type',
      idx: IDX.eventType,
      validate: (v) => typeof v === 'number' || v === undefined || v === null,
      required: false,
    },
    {
      name: 'Attendees List',
      idx: IDX.attendees,
      validate: (v) => Array.isArray(v) || v === undefined || v === null,
      required: false,
    },
  ];

  let tupleValidationFailed = false;
  const tupleErrors = [];

  for (let i = 0; i < allTuples.length; i++) {
    const tuple = allTuples[i];
    const isLive = tuple[IDX.status] !== 2;
    for (const test of indexFieldTests) {
      if (test.liveOnly && !isLive) continue;
      const val = tuple[test.idx];
      if (test.required && (val === undefined || val === null)) {
        tupleValidationFailed = true;
        tupleErrors.push(
          `Event at index ${i} missing required ${test.name} at position [${test.idx}]`,
        );
      } else if (val !== undefined && val !== null && !test.validate(val)) {
        tupleValidationFailed = true;
        tupleErrors.push(`Event at index ${i} invalid ${test.name} type at position [${test.idx}]`);
      }
    }
  }

  checks.push({
    name: 'Pinned Indices',
    status: allTuples.length === 0 ? 'skip' : tupleValidationFailed ? 'fail' : 'pass',
    detail: tupleValidationFailed
      ? `${tupleErrors.length} type/index error(s):\n      - ${tupleErrors.slice(0, 3).join('\n      - ')}`
      : `Verified type contracts across ${allTuples.length} tuples`,
  });

  // Feature Coverage Checks
  const recurringEvents = allTuples.filter(
    (tuple) => tuple[IDX.recurrence] || tuple[IDX.seriesId] || tuple[IDX.seriesAnchor],
  );
  const countRecurrences = recurringEvents.filter((tuple) => {
    const raw = tuple[IDX.recurrence];
    return Array.isArray(raw) && raw.some((r) => typeof r === 'string' && r.includes('COUNT='));
  }).length;
  const untilRecurrences = recurringEvents.filter((tuple) => {
    const raw = tuple[IDX.recurrence];
    return Array.isArray(raw) && raw.some((r) => typeof r === 'string' && r.includes('UNTIL='));
  }).length;

  checks.push({
    name: 'Coverage: Recur (COUNT)',
    status: countRecurrences > 0 ? 'pass' : 'skip',
    detail:
      countRecurrences > 0
        ? `Exercised on ${countRecurrences} series with fixed occurrence count`
        : 'None found in window (seed with MCP to test)',
  });

  checks.push({
    name: 'Coverage: Recur (UNTIL)',
    status: untilRecurrences > 0 ? 'pass' : 'skip',
    detail:
      untilRecurrences > 0
        ? `Exercised on ${untilRecurrences} series with explicit end date`
        : 'None found in window (seed with MCP to test)',
  });

  const conferenceCount = allTuples.filter(
    (tuple) =>
      tuple[IDX.meetUrl] ||
      (Array.isArray(tuple[IDX.conference]) && tuple[IDX.conference].length > 0),
  ).length;
  checks.push({
    name: 'Coverage: Video Conf',
    status: conferenceCount > 0 ? 'pass' : 'skip',
    detail:
      conferenceCount > 0
        ? `Exercised on ${conferenceCount} conference event(s)`
        : 'None found in window (seed with MCP to test)',
  });

  const attendeesCount = allTuples.filter(
    (tuple) => Array.isArray(tuple[IDX.attendees]) && tuple[IDX.attendees].length > 0,
  ).length;
  checks.push({
    name: 'Coverage: Attendees',
    status: attendeesCount > 0 ? 'pass' : 'skip',
    detail:
      attendeesCount > 0
        ? `Exercised on ${attendeesCount} event(s) with guests`
        : 'None found in window (seed with MCP to test)',
  });

  const allDayCount = allTuples.filter((tuple) => {
    const start = tuple[IDX.start];
    return Array.isArray(start) && typeof start[0] === 'number';
  }).length;
  checks.push({
    name: 'Coverage: All-Day',
    status: allDayCount > 0 ? 'pass' : 'skip',
    detail:
      allDayCount > 0
        ? `Exercised on ${allDayCount} all-day event(s)`
        : 'None found in window (seed with MCP to test)',
  });

  // Structural Scenarios: Tombstones, Recurrence Exceptions, Renamed/Moved Instances
  const tombstoneCount = allTuples.filter((tuple) => tuple[IDX.status] === 2).length;
  checks.push({
    name: 'Coverage: Tombstones',
    status: tombstoneCount > 0 ? 'pass' : 'skip',
    detail:
      tombstoneCount > 0
        ? `Exercised on ${tombstoneCount} deleted/tombstoned event(s)`
        : 'None found in window (delete an event to test tombstone delivery)',
  });

  const OCCURRENCE_STAMP = /_R?(\d{8}(?:T\d{6})?)Z?$/;
  const anchorCount = allTuples.filter(
    (tuple) =>
      (typeof tuple[IDX.id] === 'string' && OCCURRENCE_STAMP.test(tuple[IDX.id])) ||
      (typeof tuple[IDX.seriesId] === 'string' && tuple[IDX.seriesId].length > 0) ||
      (typeof tuple[IDX.seriesAnchor] === 'string' && tuple[IDX.seriesAnchor].includes('_R')),
  ).length;
  checks.push({
    name: 'Coverage: Recur Instances',
    status: anchorCount > 0 ? 'pass' : 'skip',
    detail:
      anchorCount > 0
        ? `Exercised on ${anchorCount} materialized/exception occurrence(s)`
        : 'None found in window (edit an occurrence to test instance handling)',
  });

  const exdateCount = allTuples.filter((tuple) => {
    const raw = tuple[IDX.recurrence];
    return (
      Array.isArray(raw) &&
      raw.some((r) => typeof r === 'string' && (r.startsWith('EXDATE:') || r.startsWith('EXDATE;')))
    );
  }).length;
  checks.push({
    name: 'Coverage: EXDATE Rules',
    status: exdateCount > 0 ? 'pass' : 'skip',
    detail:
      exdateCount > 0
        ? `Exercised on ${exdateCount} series carrying EXDATE exclusion(s)`
        : 'None found in window (move or exclude an occurrence to test exclusion rules)',
  });

  const specialKindCount = allTuples.filter(
    (tuple) => typeof tuple[IDX.eventType] === 'number' && tuple[IDX.eventType] !== 0,
  ).length;
  checks.push({
    name: 'Coverage: Special Kinds',
    status: specialKindCount > 0 ? 'pass' : 'skip',
    detail:
      specialKindCount > 0
        ? `Exercised on ${specialKindCount} non-default event(s) (focus, OOO, or location)`
        : 'None found in window (seed a Focus Time or Out of Office block to test)',
  });

  const reminderCount = allTuples.filter(
    (tuple) => Array.isArray(tuple[IDX.reminders]) && tuple[IDX.reminders].length > 0,
  ).length;
  checks.push({
    name: 'Coverage: Reminders',
    status: reminderCount > 0 ? 'pass' : 'skip',
    detail:
      reminderCount > 0
        ? `Exercised on ${reminderCount} event(s) with custom notification overrides`
        : 'None found in window (seed an event with reminder override to test)',
  });

  // Check 8: Production Parser Integration
  let decodedResult = null;
  let decoderError = null;
  try {
    decodedResult = parsePrefetchEventRangeResponse(rawText);
  } catch (err) {
    decoderError = err;
  }

  checks.push({
    name: 'Production Decoder',
    status: decoderError ? 'fail' : 'pass',
    detail: decoderError
      ? `parsePrefetchEventRangeResponse threw: ${decoderError.message}`
      : `Parsed ${decodedResult?.events?.length || 0} event(s) across ${decodedResult?.calendars?.length || 0} calendar(s) without error`,
  });

  // Check 9: Field Set Drift Inspection (Detect new or missing positional indices)
  const observedIndices = new Set();
  for (const tuple of allTuples) {
    for (let idx = 0; idx < tuple.length; idx++) {
      if (tuple[idx] !== null && tuple[idx] !== undefined) {
        observedIndices.add(idx);
      }
    }
  }

  const knownIndices = new Set(Object.values(IDX));
  const unknownIndices = [...observedIndices]
    .filter((idx) => !knownIndices.has(idx))
    .sort((a, b) => a - b);

  checks.push({
    name: 'Schema Drift Diff',
    status: 'pass',
    detail:
      unknownIndices.length > 0
        ? `Observed ${unknownIndices.length} unpinned index position(s) with data: [${unknownIndices.join(', ')}]`
        : 'All observed non-null fields match known schema indices',
  });

  reportResults(checks);

  const failedCount = checks.filter((c) => c.status === 'fail').length;
  if (failedCount > 0) {
    console.log(`\nCANARY FAILED: ${failedCount} structural check(s) reported failure.`);
    process.exit(1);
  }

  console.log(
    '\n✓ CANARY PASSED: Calendar sync feed is up to date and matches production decoder.',
  );
  process.exit(0);
}

function validateTimestamp(val) {
  const parsed = parseTimestampTuple(val);
  if (!parsed || !(parsed.date instanceof Date) || Number.isNaN(parsed.date.getTime()))
    return false;
  const ms = parsed.date.getTime();
  // Valid calendar range: 1900 to 2100
  return ms > -2.2e12 && ms < 4.1e12;
}

function reportResults(checks) {
  const width = {
    status: Math.max(6, ...checks.map((c) => c.status.length)),
    name: Math.max(18, ...checks.map((c) => c.name.length)),
  };

  console.log(`\n${'STATUS'.padEnd(width.status)}  ${'CHECK'.padEnd(width.name)}  DETAIL`);
  console.log(`${'-'.repeat(width.status)}  ${'-'.repeat(width.name)}  ${'-'.repeat(30)}`);

  for (const c of checks) {
    const symbol = c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '⊘';
    console.log(
      `${`${symbol} ${c.status}`.padEnd(width.status)}  ${c.name.padEnd(width.name)}  ${c.detail}`,
    );
  }
}

runCanary().catch((err) => {
  console.error('\n✗ Fatal error during canary execution:', err);
  process.exit(1);
});
