#!/usr/bin/env node
/**
 * test-native-notifications.mjs
 *
 * Local automated integration test for Magimail's native notification subsystem.
 * Verifies the Swift helper RPC, banner dispatch, the action contract between the
 * helper and Main, and settings persistence, without waiting for the Atom poller
 * to find new mail or clicking anything.
 *
 * The companion to Magical's `test-native-alerts.mjs`; the two apps split their
 * notification work the same way, across Electron Main and a Swift helper on
 * `stdin`/`stdout` JSON-RPC.
 *
 * Usage:
 *   pnpm --filter magimail test:native
 *   node apps/magimail/scripts/test-native-notifications.mjs
 */

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/// Resolved from this file, not `process.cwd()`: pnpm runs the script with the
/// package directory as the working directory, and a root-relative path would
/// then read `apps/magimail/apps/magimail/...` and find nothing.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function pass(msg) {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

function fail(msg) {
  console.error(`  ${RED}✗${RESET} ${msg}`);
  process.exit(1);
}

console.log(`${BOLD}▸ Running Magimail Native Notification Subsystem Tests (Local)${RESET}\n`);

// MARK: - 1. Verify Swift Helper JSON-RPC
console.log(`${BOLD}1. Swift Helper JSON-RPC Integration${RESET}`);

const HELPER_PATHS = [
  '/Applications/Magimail.app/Contents/MacOS/MagimailHelper',
  path.join(REPO_ROOT, 'apps/magimail/swift/.build/release/MagimailHelper'),
  path.join(REPO_ROOT, 'apps/magimail/swift/.build/arm64-apple-macosx/release/MagimailHelper'),
];

const helperPath = HELPER_PATHS.find((p) => fs.existsSync(p));
if (!helperPath) {
  fail(
    `MagimailHelper binary not found. Run \`pnpm --filter magimail build:swift\` or install the app.`,
  );
}
pass(`Found helper at: ${helperPath}`);

// A helper run from `.build/` has no bundle identity, so it declines to post a
// banner and says so on stderr. The RPC still answers, which is what is under test.
const isBundled = helperPath.startsWith('/Applications/');

/**
 * Sends one request and waits for the answer to it.
 *
 * Holds `stdin` open until the response arrives rather than closing it straight
 * away. Some methods answer from a `@MainActor` task, and the helper exits the
 * moment `stdin` closes, so closing first races the reply and loses it. It also
 * keeps the helper alive a beat after the response: `notify.dispatch` answers before
 * `UNUserNotificationCenter.add` has handed the banner to the notification daemon.
 */
async function sendRpc(request, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setTimeout(() => child.kill(), 1000);
      resolve({ response, stderr });
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === request.id) finish(parsed);
        } catch {
          // A partial line; wait for the rest.
        }
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', () => finish(null));

    child.stdin.write(JSON.stringify(request) + '\n');
  });
}

const focusRes = await sendRpc({ id: 1, method: 'focusFilter.get', params: {} });
if (focusRes.response?.id === 1 && focusRes.response?.result) {
  const filter = focusRes.response.result;
  pass(`focusFilter.get answered: isFilterActive=${filter.isFilterActive}`);
} else {
  fail(`focusFilter.get failed: ${JSON.stringify(focusRes)}`);
}

const setupRes = await sendRpc({ id: 2, method: 'notify.setup', params: {} });
if (setupRes.response?.id === 2 && setupRes.response?.result === 'ok') {
  pass(`notify.setup handled cleanly and acknowledged with ok`);
} else {
  fail(`notify.setup failed: ${JSON.stringify(setupRes)}`);
}

// The shape Main actually sends: an account, its per-category notification
// settings, and the messages a poll found new.
const dispatchRes = await sendRpc({
  id: 3,
  method: 'notify.dispatch',
  params: {
    accountId: 'account_test',
    notifications: { primary: 'loud', updates: 'silent', promotions: 'badge' },
    messages: [
      {
        id: 'test-feed-id-1',
        threadId: '1a00000000000003',
        from: 'Automated Test',
        subject: 'Testing notify.dispatch over JSON-RPC',
        snippet: 'This banner came from the native notification test script.',
        category: 'primary',
      },
    ],
  },
});
if (dispatchRes.response?.id === 3 && dispatchRes.response?.result === 'ok') {
  pass(`notify.dispatch handled cleanly and acknowledged with ok`);

  // The shared `NotificationControllerBase` declines every banner without a bundle
  // identity, and that decline is the only externally visible difference between a
  // helper that can post and one that cannot. Assert it in both directions, so a
  // refactor that moved the guard cannot quietly break the installed path: a bundled
  // helper that warns would show no banner, and a `.build` helper that stopped
  // warning would be posting under an identity it does not have.
  const declined = dispatchRes.stderr.includes('No bundle identity');
  if (isBundled) {
    if (declined) {
      fail(
        `the bundled helper declined to post a banner (expected none outside Magimail.app):\n${dispatchRes.stderr}`,
      );
    }
    const errored = dispatchRes.stderr
      .split('\n')
      .filter((l) => l.includes('Auth error') || l.includes('Failed to dispatch'));
    if (errored.length > 0) {
      fail(`the bundled helper failed to post:\n    ${errored.join('\n    ')}`);
    }
    pass(`bundled helper registered and posted with the app's identity`);
  } else if (declined) {
    pass(`banner declined without bundle identity, as expected outside Magimail.app`);
  } else {
    fail(`the .build helper posted without a bundle identity it cannot have`);
  }
} else {
  fail(`notify.dispatch failed: ${JSON.stringify(dispatchRes)}`);
}

// MARK: - 2. Verify the action contract across the process boundary
console.log(`\n${BOLD}2. Notification Action Contract (Swift ↔ Main)${RESET}`);

// The helper registers `magimail.<action>` identifiers, strips the prefix and sends
// the remainder back as `notify.action`. Main only acts on what its own type admits,
// so an action added on one side and forgotten on the other fails silently: the
// button appears on the banner and does nothing. Compare the two lists directly.
const swiftSource = path.join(
  REPO_ROOT,
  'apps/magimail/swift/Sources/MagimailHelperLib/NotificationController.swift',
);
const mainSource = path.join(REPO_ROOT, 'apps/magimail/src/notification-manager.ts');

if (!fs.existsSync(swiftSource) || !fs.existsSync(mainSource)) {
  fail(`Cannot read both sides of the contract: ${swiftSource}, ${mainSource}`);
}

// Only the `<name>Action` constants. The same file also carries the category id and
// the per-message identifier, which share the `magimail.` prefix and are not buttons.
const swiftActions = [
  ...fs.readFileSync(swiftSource, 'utf8').matchAll(/\w+Action\s*=\s*"magimail\.([a-zA-Z]+)"/g),
].map((m) => m[1]);

const actionUnion = /action\?:\s*([^;]+);/.exec(fs.readFileSync(mainSource, 'utf8'));
const mainActions = actionUnion
  ? [...actionUnion[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1])
  : [];

if (swiftActions.length === 0 || mainActions.length === 0) {
  fail(
    `Could not read the action lists (swift: ${swiftActions.length}, main: ${mainActions.length}). ` +
      `One of the two files has been restructured and this check needs updating.`,
  );
}

const orphaned = swiftActions.filter((a) => !mainActions.includes(a));
if (orphaned.length === 0) {
  pass(`every banner button Main understands: ${swiftActions.join(', ')}`);
} else {
  fail(
    `the helper offers ${orphaned.join(', ')}, which Main does not act on — ` +
      `the button would appear on the banner and do nothing`,
  );
}

// The reverse is allowed and normal: Main accepts `open`, which is a click on the
// banner body rather than a button, so it has no identifier to register.
const unoffered = mainActions.filter((a) => a !== 'open' && !swiftActions.includes(a));
if (unoffered.length === 0) {
  pass(`Main admits nothing the helper cannot send`);
} else {
  pass(`Main also admits ${unoffered.join(', ')}, which no banner button sends yet`);
}

// MARK: - 3. Verify Settings Store Schema
console.log(`\n${BOLD}3. Settings Persistence & Notification Schema${RESET}`);

const settingsPath = path.join(os.homedir(), 'Library/Application Support/Magimail/settings.json');
if (fs.existsSync(settingsPath)) {
  // A signed build encrypts settings.json at rest, so the bytes are not JSON and
  // parsing them here throws rather than answering. The schema is what the check is
  // for, and the plaintext form is what an unsigned `.build` app writes.
  let content = null;
  try {
    content = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    pass(`settings.json is encrypted at rest on a signed build; schema check skipped`);
  }

  if (content) {
    const categories = content.notifications;
    if (categories && typeof categories === 'object' && typeof categories.primary === 'string') {
      const summary = Object.entries(categories)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      pass(`settings.json carries per-category notification levels: ${summary}`);
    } else {
      fail(`settings.json missing or invalid notifications map: ${JSON.stringify(categories)}`);
    }

    // Worth printing rather than asserting: it explains a run in which no banner
    // appeared. A message sent now raises nothing until the next poll.
    const interval = content.pollIntervalSeconds;
    if (typeof interval === 'number') {
      pass(`Atom poll interval is ${interval}s (${Math.round(interval / 60)} min between polls)`);
    }
  }
} else {
  pass(`settings.json does not exist yet; will be created on first launch.`);
}

// MARK: - 4. Verify Running App State & Accessibility UI
console.log(`\n${BOLD}4. Running App & Native UI Accessibility${RESET}`);

try {
  const menuBarItems = execSync(
    `osascript -e 'tell application "System Events" to tell process "MagimailHelper" to count of menu bar items of menu bar 1'`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
  pass(`MagimailHelper owns ${menuBarItems} menu bar item(s)`);

  const windowNames = execSync(
    `osascript -e 'tell application "System Events" to tell process "MagimailHelper" to get name of every window'`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();

  if (windowNames.includes('Magimail Preferences')) {
    pass(`Magimail Preferences window is open in MagimailHelper`);
  } else {
    pass(`Preferences window not currently open (press Cmd+, in Magimail to inspect it)`);
  }

  // The popover is an NSPopover rather than a window, so it never reaches the
  // accessibility tree and its rows cannot be driven from here. Said once so the
  // next person does not spend an afternoon looking for it.
  pass(`menu bar popover rows are not accessible to System Events; drive them by URL instead`);
} catch {
  pass(
    `MagimailHelper not running or Accessibility permissions not granted; skipped live UI inspection`,
  );
}

// MARK: - 5. Verify Dispatch Evidence in main.log
console.log(`\n${BOLD}5. Notification Dispatch Verification${RESET}`);

const logPath = path.join(os.homedir(), 'Library/Logs/Magimail/main.log');
if (fs.existsSync(logPath)) {
  const all = fs.readFileSync(logPath, 'utf8').split('\n');

  // Only this run of the app. The log is append-only and long-lived, so a failure
  // fixed weeks ago would otherwise keep failing this check forever.
  const lastLaunch = all.findLastIndex((l) => l.includes('(Startup)'));
  const lines = lastLaunch === -1 ? all : all.slice(lastLaunch);
  pass(
    lastLaunch === -1
      ? `reading the whole log; no startup banner found`
      : `reading the ${lines.length} line(s) since the last launch`,
  );

  // A posted banner shows as the RPC, not as the word "notification"; grepping for
  // the latter finds nothing and reads as "no banner ever fired".
  const dispatches = lines.filter((l) => l.includes('notify.dispatch'));
  if (dispatches.length > 0) {
    pass(
      `${dispatches.length} banner dispatch(es) in main.log; most recent:\n    ${dispatches[dispatches.length - 1].replace(/^.*?\[info\]\s*/, '')}`,
    );
  } else {
    pass(`main.log found, but no notify.dispatch lines yet (no new mail since launch)`);
  }

  const actions = lines.filter((l) => l.includes('Thread action '));
  if (actions.length > 0) {
    pass(
      `${actions.length} thread action(s) run; most recent:\n    ${actions[actions.length - 1].replace(/^.*?\[info\]\s*/, '')}`,
    );
  } else {
    pass(`no thread actions run yet (fire one with a magimail://thread/<id>?action= link)`);
  }

  const failures = lines.filter(
    (l) => l.includes('No ') && l.includes('control in the open thread'),
  );
  if (failures.length === 0) {
    pass(`no thread action failed to find its control`);
  } else {
    fail(
      `${failures.length} thread action(s) found no control to click; most recent:\n    ` +
        failures[failures.length - 1].replace(/^.*?\[warn\]\s*/, ''),
    );
  }
} else {
  pass(`No main.log found at ${logPath}`);
}

console.log(`\n${GREEN}${BOLD}✓ All native notification subsystem checks passed!${RESET}\n`);
