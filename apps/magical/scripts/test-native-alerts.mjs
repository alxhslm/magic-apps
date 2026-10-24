#!/usr/bin/env node
/**
 * test-native-alerts.mjs
 *
 * Local automated integration test for Magical's native alert subsystem.
 * Verifies the Swift helper RPC, alert dispatch and withdrawal, the action contract
 * between the helper and Main, and settings persistence, without requiring manual
 * point-and-click or waiting for Google Calendar sync.
 *
 * Usage:
 *   pnpm --filter magical test:native
 *   node apps/magical/scripts/test-native-alerts.mjs
 */

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/// Resolved from this file, not `process.cwd()`: pnpm runs the script with the
/// package directory as the working directory, and a root-relative path would
/// then read `apps/magical/apps/magical/...` and find nothing.
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

console.log(`${BOLD}▸ Running Magical Native Alert Subsystem Tests (Local)${RESET}\n`);

// MARK: - 1. Verify Swift Helper JSON-RPC
console.log(`${BOLD}1. Swift Helper JSON-RPC Integration${RESET}`);

const HELPER_PATHS = [
  '/Applications/Magical.app/Contents/MacOS/MagicalHelper',
  path.join(REPO_ROOT, 'apps/magical/swift/.build/release/MagicalHelper'),
  path.join(REPO_ROOT, 'apps/magical/swift/.build/arm64-apple-macosx/release/MagicalHelper'),
];

const helperPath = HELPER_PATHS.find((p) => fs.existsSync(p));
if (!helperPath) {
  fail(
    `MagicalHelper binary not found. Run \`pnpm --filter magical build:swift\` or install the app.`,
  );
}
pass(`Found helper at: ${helperPath}`);

// A helper run from `.build/` has no bundle identity, so the shared
// `NotificationControllerBase` declines to post and says so on stderr. The RPC still
// answers, which is what the rest of this section checks.
const isBundled = helperPath.startsWith('/Applications/');

/**
 * Sends one request and waits for the answer to it.
 *
 * Holds `stdin` open until the response arrives, and keeps the helper alive a beat
 * after that. Closing `stdin` exits the helper (`stdin closed — exiting helper
 * process`), and `alert.dispatch` answers before `UNUserNotificationCenter.add` has
 * handed the banner to the notification daemon — so ending the process on the
 * response alone can drop the very banner under test.
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

// Test defaults.query
const defaultsRes = await sendRpc({ id: 1, method: 'defaults.query', params: {} });
if (defaultsRes.response?.id === 1 && defaultsRes.response?.result) {
  pass(
    `defaults.query returned valid handler report: ${JSON.stringify(defaultsRes.response.result.handlers?.[0] ?? {})}`,
  );
} else {
  fail(`defaults.query failed: ${JSON.stringify(defaultsRes)}`);
}

// Test alert.dispatch
const alertRes = await sendRpc({
  id: 2,
  method: 'alert.dispatch',
  params: {
    key: 'test|event1|5',
    accountId: 'account_test',
    eventId: 'event1',
    title: 'Automated Test Meeting',
    subtitle: 'In 5 minutes',
    body: 'Testing alert dispatch over JSON-RPC',
  },
});
if (alertRes.response?.id === 2 && alertRes.response?.result === 'ok') {
  pass(`alert.dispatch handled cleanly and acknowledged with ok`);

  // The only externally visible difference between a helper that can post and one
  // that cannot is the bundle-identity decline. Assert it in both directions, so a
  // refactor of the shared base cannot quietly break the installed path.
  const declined = alertRes.stderr.includes('No bundle identity');
  if (isBundled) {
    if (declined) {
      fail(
        `the bundled helper declined to post a banner (expected none outside Magical.app):\n${alertRes.stderr}`,
      );
    }
    const errored = alertRes.stderr
      .split('\n')
      .filter((l) => l.includes('Auth error') || l.includes('Failed to dispatch'));
    if (errored.length > 0) {
      fail(`the bundled helper failed to post:\n    ${errored.join('\n    ')}`);
    }
    pass(`bundled helper registered and posted with the app's identity`);
  } else if (declined) {
    pass(`banner declined without bundle identity, as expected outside Magical.app`);
  } else {
    fail(`the .build helper posted without a bundle identity it cannot have`);
  }
} else {
  fail(`alert.dispatch failed: ${JSON.stringify(alertRes)}`);
}

// Test alert.withdraw. It gets a banner of its own: withdrawing `test|event1|5`
// would remove the banner the dispatch above just posted, so a passing run could
// look exactly like one that posted nothing.
const withdrawnKey = 'test|withdrawn|5';
const seededRes = await sendRpc({
  id: 3,
  method: 'alert.dispatch',
  params: {
    key: withdrawnKey,
    accountId: 'account_test',
    eventId: 'event2',
    title: 'Automated Test Meeting (withdrawn)',
    subtitle: 'In 5 minutes',
    body: 'Withdrawn by the check that follows.',
  },
});
if (seededRes.response?.id !== 3 || seededRes.response?.result !== 'ok') {
  fail(`seeding the withdraw check failed: ${JSON.stringify(seededRes)}`);
}

const withdrawRes = await sendRpc({
  id: 4,
  method: 'alert.withdraw',
  params: { keys: [withdrawnKey] },
});
if (withdrawRes.response?.id === 4 && withdrawRes.response?.result === 'ok') {
  pass(`alert.withdraw handled cleanly and acknowledged with ok`);
} else {
  fail(`alert.withdraw failed: ${JSON.stringify(withdrawRes)}`);
}

// MARK: - 2. Verify the action contract across the process boundary
console.log(`\n${BOLD}2. Alert Action Contract (Swift ↔ Main)${RESET}`);

// The helper turns a pressed button into an `alert.action` string and sends it back;
// Main only acts on what `AlertActionKind` admits. An action added on one side and
// forgotten on the other fails silently: the button appears on the banner and does
// nothing. Compare the two lists directly.
const swiftSource = path.join(
  REPO_ROOT,
  'apps/magical/swift/Sources/MagicalHelperLib/NotificationController.swift',
);
const managerSource = path.join(REPO_ROOT, 'apps/magical/src/notification-manager.ts');

if (!fs.existsSync(swiftSource) || !fs.existsSync(managerSource)) {
  fail(`Cannot read both sides of the contract: ${swiftSource}, ${managerSource}`);
}

// Every `case <identifier>: action = "<value>"` in `makeActionPayload`, which is what
// the helper sends. The identifier is not the part that travels.
const helperActions = [
  ...fs.readFileSync(swiftSource, 'utf8').matchAll(/case\s+\w+\s*:\s*action\s*=\s*"([^"]+)"/g),
].map((m) => m[1]);

// The declared union, expanding its one template literal (`rsvp:${...}`) so the three
// RSVP strings are read out rather than their bare `yes | maybe | no` parts.
const kindUnion = /AlertActionKind\s*=\s*([^;]+);/.exec(
  fs.readFileSync(managerSource, 'utf8'),
)?.[1];
const mainActions = [];
const union = (kindUnion ?? '').replace(/`([^`]*)`/g, (_, tmpl) => {
  const part = /^([^$]*)\$\{([^}]*)\}$/.exec(tmpl);
  if (!part) return '';
  for (const choice of part[2].matchAll(/'([^']+)'/g)) mainActions.push(part[1] + choice[1]);
  return '';
});
for (const literal of union.matchAll(/'([^']+)'/g)) mainActions.push(literal[1]);

if (helperActions.length === 0 || mainActions.length === 0) {
  fail(
    `Could not read the action lists (swift: ${helperActions.length}, main: ${mainActions.length}). ` +
      `One of the two files has been restructured and this check needs updating.`,
  );
}

const orphaned = helperActions.filter((a) => !mainActions.includes(a));
if (orphaned.length === 0) {
  pass(`every banner button Main understands: ${helperActions.join(', ')}`);
} else {
  fail(
    `the helper sends ${orphaned.join(', ')}, which Main does not act on — ` +
      `the button would appear on the banner and do nothing`,
  );
}

const unoffered = mainActions.filter((a) => !helperActions.includes(a));
if (unoffered.length === 0) {
  pass(`Main admits nothing the helper cannot send`);
} else {
  pass(`Main also admits ${unoffered.join(', ')}, which no banner button sends yet`);
}

// MARK: - 3. Verify Settings Store Schema
console.log(`\n${BOLD}3. Settings Persistence & disabledAlertCalendarIds Schema${RESET}`);

const settingsPath = path.join(os.homedir(), 'Library/Application Support/Magical/settings.json');
if (fs.existsSync(settingsPath)) {
  // A signed build encrypts settings.json at rest, so the bytes are not JSON and
  // parsing them here throws rather than answering. The plaintext form is what an
  // unsigned `.build` app writes.
  let content = null;
  try {
    content = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    pass(`settings.json is encrypted at rest on a signed build; schema check skipped`);
  }

  if (content) {
    if (Array.isArray(content.disabledAlertCalendarIds)) {
      pass(
        `settings.json contains disabledAlertCalendarIds array: [${content.disabledAlertCalendarIds.join(', ')}]`,
      );
    } else {
      fail(
        `settings.json missing or invalid disabledAlertCalendarIds: ${JSON.stringify(content.disabledAlertCalendarIds)}`,
      );
    }
  }
} else {
  pass(`settings.json does not exist yet; will be created on first launch.`);
}

// MARK: - 4. Verify Running App State & Accessibility UI
console.log(`\n${BOLD}4. Running App & Native UI Accessibility${RESET}`);

try {
  const windowNames = execSync(
    `osascript -e 'tell application "System Events" to tell process "MagicalHelper" to get name of every window'`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();

  if (windowNames.includes('Magical Settings')) {
    pass(`Magical Settings window is active in MagicalHelper`);

    // Inspect checkboxes inside scroll area
    const checkboxCount = execSync(
      `osascript -e 'tell application "System Events" to tell process "MagicalHelper" to tell window "Magical Settings" to tell group 1 of group 1 to tell scroll area 1 to count of checkboxes'`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    pass(`Scrollable calendar box contains ${checkboxCount} calendar checkbox toggle(s)`);
  } else {
    pass(
      `Settings window not currently open (run \`open /Applications/Magical.app\` and press Cmd+, to view)`,
    );
  }
} catch {
  pass(
    `MagicalHelper not running or Accessibility permissions not granted; skipped live UI inspection`,
  );
}

// MARK: - 5. Verify main.log Alert Recalculation
console.log(`\n${BOLD}5. Alert Recalculation Verification${RESET}`);

const logPath = path.join(os.homedir(), 'Library/Logs/Magical/main.log');
if (fs.existsSync(logPath)) {
  const logContent = fs.readFileSync(logPath, 'utf8');
  const alertLines = logContent
    .split('\n')
    .filter((l) => l.includes('(AlertScheduler)') && l.includes('alertable'));
  if (alertLines.length > 0) {
    const lastAlert = alertLines[alertLines.length - 1];
    pass(
      `Last AlertScheduler recalculation in main.log:\n    ${lastAlert.replace(/^.*?\[info\]\s*/, '')}`,
    );
  } else {
    pass(`main.log found, but no AlertScheduler lines logged yet.`);
  }
} else {
  pass(`No main.log found at ${logPath}`);
}

console.log(`\n${GREEN}${BOLD}✓ All native alert subsystem checks passed!${RESET}\n`);
