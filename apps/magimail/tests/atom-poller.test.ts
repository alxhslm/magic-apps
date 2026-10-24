import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { configureSecretFiles, resetSecretFiles } from '@magimail/core';
import {
  parseAtomXml,
  extractMessageId,
  toGmailUrlId,
  AtomFeedPoller,
  clearPollerState,
  CHANGE_HINT_COOLDOWN_MS,
  resolveMessageCategory,
  isNewArrival,
  messageArrivedAt,
  ARRIVAL_TOLERANCE_MS,
  atomMessageToTrayMessageItem,
  type AtomPollResult,
  type NotificationCategory,
} from '../src/atom-poller.js';

/**
 * Poller state goes to real files, as it does in the app: the state a restarted
 * poller comes back with is the thing several of these tests are about.
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'magimail-atom-'));

afterAll(() => {
  resetSecretFiles();
  fs.rmSync(userData, { recursive: true, force: true });
});

/** A packaged build, whose state files are encrypted under `key`. */
function packagedBuild(key: Buffer): void {
  configureSecretFiles({
    isPackaged: true,
    fetchKey: () => key,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

// Mock electron components
const mockFetch = vi.fn();
const mockSession = {
  fetch: mockFetch,
};

let powerMonitorCallbacks: Record<string, () => void> = {};
let appCallbacks: Record<string, () => void> = {};
let isWindowFocused = false;

vi.mock('electron', () => ({
  session: {
    fromPartition: vi.fn(() => mockSession),
  },
  powerMonitor: {
    isOnBatteryPower: vi.fn(() => false),
    on: vi.fn((event: string, cb: () => void) => {
      powerMonitorCallbacks[event] = cb;
    }),
  },
  app: {
    getPath: vi.fn(() => userData),
    on: vi.fn((event: string, cb: () => void) => {
      appCallbacks[event] = cb;
    }),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ isFocused: () => isWindowFocused }]),
  },
}));

const feedResponse = (xml: string) => ({ ok: true, status: 200, text: async () => xml });

const EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3"><fullcount>0</fullcount></feed>`;

/**
 * Answer the root feed from a queue, in order, and every category sub-feed with
 * an empty one.
 *
 * A poll issues a variable number of requests — the root feed alone when
 * nothing in it needs classifying, and four sub-feeds alongside it when
 * something does. A flat `mockResolvedValueOnce` chain therefore hands a queued
 * root response to a sub-feed request and slides every later assertion along by
 * one. Routing on the URL lets a fixture describe polls rather than requests.
 *
 * Tests that care what a sub-feed *contains* queue the responses themselves.
 */
function queueRootFeeds(...xmls: string[]): void {
  let next = 0;
  mockFetch.mockReset();
  mockFetch.mockImplementation((url: string) =>
    Promise.resolve(
      url.endsWith('/feed/atom')
        ? feedResponse(xmls[Math.min(next++, xmls.length - 1)])
        : feedResponse(EMPTY_FEED),
    ),
  );
}

describe('Atom XML Parser', () => {
  it('extracts fullcount and entries with decoded entities', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <title>Gmail - Inbox for test@example.com</title>
  <fullcount>2</fullcount>
  <entry>
    <title>Q3 &amp; Q4 Strategy Planning</title>
    <summary>Hey team, &lt;review&gt; the attached &quot;deck&quot; before tomorrow&#39;s sync...</summary>
    <link rel="alternate" href="https://mail.google.com/mail?message_id=1800000000001" type="text/html"/>
    <modified>2026-09-05T11:40:00Z</modified>
    <issued>2026-09-05T11:39:12Z</issued>
    <id>tag:gmail.google.com,2004:1800000000001</id>
    <author>
      <name>Sarah Connor</name>
      <email>sarah@cyberdyne.com</email>
    </author>
  </entry>
  <entry>
    <title>Dinner &amp; drinks</title>
    <summary>Are we still on?</summary>
    <link rel="alternate" href="https://mail.google.com/mail?th=1800000000002" type="text/html"/>
    <modified>2026-09-05T11:42:00Z</modified>
    <issued>2026-09-05T11:41:00Z</issued>
    <id>tag:gmail.google.com,2004:1800000000002</id>
    <author>
      <name>John Connor</name>
      <email>john@resistance.org</email>
    </author>
  </entry>
</feed>`;

    const { fullCount, entries } = parseAtomXml(xml);

    expect(fullCount).toBe(2);
    expect(entries.length).toBe(2);

    expect(entries[0].id).toBe('1800000000001');
    expect(entries[0].subject).toBe('Q3 & Q4 Strategy Planning');
    expect(entries[0].snippet).toBe(
      'Hey team, <review> the attached "deck" before tomorrow\'s sync...',
    );
    expect(entries[0].from).toBe('Sarah Connor <sarah@cyberdyne.com>');

    expect(entries[1].id).toBe('1800000000002');
    expect(entries[1].subject).toBe('Dinner & drinks');
    expect(entries[1].from).toBe('John Connor <john@resistance.org>');
  });

  it('handles empty feed with 0 count', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <title>Gmail - Inbox</title>
  <fullcount>0</fullcount>
</feed>`;

    const { fullCount, entries } = parseAtomXml(xml);
    expect(fullCount).toBe(0);
    expect(entries.length).toBe(0);
  });

  it('returns null fullCount for HTML login page or missing fullcount tag', () => {
    const html = `<!DOCTYPE html><html lang="en"><head><title>Sign in - Google Accounts</title></head><body><form action="/signin"></form></body></html>`;
    const result1 = parseAtomXml(html);
    expect(result1.fullCount).toBeNull();
    expect(result1.entries.length).toBe(0);

    const xmlNoCount = `<?xml version="1.0" encoding="UTF-8"?><feed><title>Gmail</title></feed>`;
    const result2 = parseAtomXml(xmlNoCount);
    expect(result2.fullCount).toBeNull();
  });

  it('correctly extracts message ID from link query or tag format', () => {
    expect(
      extractMessageId(
        'tag:gmail.google.com,2004:1800000000001',
        'https://mail.google.com/mail?message_id=1800000000001',
      ),
    ).toBe('1800000000001');
    expect(
      extractMessageId(
        'tag:gmail.google.com,2004:1800000000001',
        'https://mail.google.com/mail?th=1800000000001',
      ),
    ).toBe('1800000000001');
    expect(extractMessageId('tag:gmail.google.com,2004:1800000000001', '')).toBe('1800000000001');
    expect(extractMessageId('msg_12345', '')).toBe('msg_12345');
  });

  it("converts the feed's decimal ids to the hex form Gmail URLs use", () => {
    // The real feed reports decimal; #inbox/<id> only resolves hex.
    expect(toGmailUrlId('1873497444986126337')).toBe('1a00000000000001');
    // Beyond Number.MAX_SAFE_INTEGER, so this has to go through BigInt.
    expect(toGmailUrlId('9007199254740993')).not.toBe('20000000000001');
  });

  it('leaves ids that are already hex alone', () => {
    expect(toGmailUrlId('1800000000001')).toBe('1800000000001');
    expect(toGmailUrlId('1a00000000000001')).toBe('1a00000000000001');
    // 16 digits or fewer could be a hex id as it stands, so it is left be.
    expect(toGmailUrlId('1234567890123456')).toBe('1234567890123456');
    expect(toGmailUrlId('msg_12345')).toBe('msg_12345');
    expect(toGmailUrlId('')).toBe('');
  });

  it('carries the decimal id for identity and the hex one for URLs', () => {
    const { entries } = parseAtomXml(
      '<feed><fullcount>1</fullcount><entry>' +
        '<title>Hi</title>' +
        '<id>tag:gmail.google.com,2004:1873497444986126337</id>' +
        '<link href="https://mail.google.com/mail?message_id=1873497444986126337&amp;view=conv" />' +
        '</entry></feed>',
    );
    expect(entries[0].id).toBe('1873497444986126337');
    expect(entries[0].threadId).toBe('1a00000000000001');
  });
});

describe('AtomFeedPoller', () => {
  let pollResults: AtomPollResult[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockFetch.mockReset();
    pollResults = [];
    powerMonitorCallbacks = {};
    appCallbacks = {};
    isWindowFocused = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initial poll establishes baseline without dispatching notification banners', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <fullcount>1</fullcount>
  <entry>
    <title>Welcome</title>
    <summary>Welcome to your inbox</summary>
    <id>tag:gmail.google.com,2004:msg1</id>
    <author><name>Google</name><email>no-reply@google.com</email></author>
  </entry>
</feed>`;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => xml,
    });

    const poller = new AtomFeedPoller('acc1', 'persist:acc1', 60, (res) => {
      pollResults.push(res);
    });

    await poller.pollNow();

    expect(pollResults.length).toBe(1);
    expect(pollResults[0].totalUnread).toBe(1);
    // Initial run establishes baseline; newMessages should be empty so we do not spam notifications on launch
    expect(pollResults[0].newMessages.length).toBe(0);

    poller.stop();
  });

  it('subsequent poll notifies genuinely new messages', async () => {
    const initialXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <fullcount>1</fullcount>
  <entry>
    <title>Welcome</title>
    <summary>Welcome to your inbox</summary>
    <id>tag:gmail.google.com,2004:msg1</id>
  </entry>
</feed>`;

    const secondXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <fullcount>2</fullcount>
  <entry>
    <title>Urgent Update</title>
    <summary>Please review immediately</summary>
    <id>tag:gmail.google.com,2004:msg2</id>
    <author><name>Boss</name><email>boss@work.com</email></author>
  </entry>
  <entry>
    <title>Welcome</title>
    <summary>Welcome to your inbox</summary>
    <id>tag:gmail.google.com,2004:msg1</id>
  </entry>
</feed>`;

    queueRootFeeds(initialXml, secondXml);

    const poller = new AtomFeedPoller('acc2', 'persist:acc2', 60, (res) => {
      pollResults.push(res);
    });

    // 1. Initial poll
    await poller.pollNow();

    // 2. Subsequent poll with new message
    await poller.pollNow();

    expect(pollResults.length).toBe(2);
    expect(pollResults[1].totalUnread).toBe(2);
    expect(pollResults[1].newMessages.length).toBe(1);
    expect(pollResults[1].newMessages[0].id).toBe('msg2');
    expect(pollResults[1].newMessages[0].subject).toBe('Urgent Update');

    poller.stop();
  });

  it('drops the count when messages leave the inbox (read or archived)', async () => {
    // The Atom feed is unread-inbox only. Reading and archiving are
    // indistinguishable from its point of view — the entry disappears and
    // <fullcount> falls — and drafts never appear in it at all. That is what
    // guarantees the badge counts only true inbox mail.
    const beforeXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <fullcount>3</fullcount>
  <entry><title>One</title><id>tag:gmail.google.com,2004:msg1</id></entry>
  <entry><title>Two</title><id>tag:gmail.google.com,2004:msg2</id></entry>
  <entry><title>Three</title><id>tag:gmail.google.com,2004:msg3</id></entry>
</feed>`;

    // msg3 archived (or read) — gone from the feed, fullcount down to 2.
    const afterXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <fullcount>2</fullcount>
  <entry><title>One</title><id>tag:gmail.google.com,2004:msg1</id></entry>
  <entry><title>Two</title><id>tag:gmail.google.com,2004:msg2</id></entry>
</feed>`;

    queueRootFeeds(beforeXml, afterXml);

    const poller = new AtomFeedPoller('acc-archive', 'persist:acc-archive', 60, (res) => {
      pollResults.push(res);
    });

    await poller.pollNow();
    await poller.pollNow();

    expect(pollResults[0].totalUnread).toBe(3);
    expect(pollResults[1].totalUnread).toBe(2);
    // Nothing arrived, so no notification should fire on the way down.
    expect(pollResults[1].newMessages.length).toBe(0);

    poller.stop();
  });

  it('forgets the persisted state of an account that has gone', async () => {
    // The file is named after the account and nothing reads it once its poller is
    // stopped, so a removed account would leave a seen-id record on disk for ever.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <fullcount>1</fullcount>
  <entry>
    <title>Still here</title>
    <issued>${new Date().toISOString()}</issued>
    <id>tag:gmail.google.com,2004:clear1</id>
  </entry>
</feed>`;
    queueRootFeeds(xml);

    const poller = new AtomFeedPoller('acc-clear', 'persist:acc-clear', 60, () => {});
    await poller.pollNow();
    poller.stop();

    const stateFile = path.join(userData, 'atom-state', 'acc-clear.json');
    expect(fs.existsSync(stateFile)).toBe(true);

    clearPollerState('acc-clear');
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  it('handles 401 unauthenticated gracefully without crashing, reporting auth_required', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const poller = new AtomFeedPoller('acc4', 'persist:acc4', 60, (res) => {
      pollResults.push(res);
    });

    await expect(poller.pollNow()).resolves.toBeUndefined();
    expect(pollResults.length).toBe(1);
    expect(pollResults[0].status).toBe('auth_required');

    poller.stop();
  });

  it('reports restricted, not offline, when an administrator policy refuses the feed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });

    const poller = new AtomFeedPoller('acc-restricted', 'persist:acc-restricted', 60, (res) => {
      pollResults.push(res);
    });

    await expect(poller.pollNow()).resolves.toBeUndefined();
    expect(pollResults[0].status).toBe('restricted');

    poller.stop();
  });

  it('reads an HTML policy block as restricted rather than as an expired session', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        '<!DOCTYPE html><html><body><h1>Access denied</h1><p>This service is blocked by your administrator.</p></body></html>',
    });

    const poller = new AtomFeedPoller('acc-policy-html', 'persist:acc-policy-html', 60, (res) => {
      pollResults.push(res);
    });

    await poller.pollNow();
    expect(pollResults[0].status).toBe('restricted');

    poller.stop();
  });

  it('login-page HTML response returns auth_required and does not zero previous count', async () => {
    const validXml = `<?xml version="1.0" encoding="UTF-8"?><feed><fullcount>5</fullcount></feed>`;
    const loginHtml = `<!DOCTYPE html><html><head><title>Sign in</title></head><body>Login</body></html>`;

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => validXml,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => loginHtml,
      });

    const poller = new AtomFeedPoller('acc-auth-test', 'persist:acc-auth-test', 60, (res) => {
      pollResults.push(res);
    });

    // 1. Initial successful poll sets unread = 5
    await poller.pollNow();
    expect(pollResults.length).toBe(1);
    expect(pollResults[0].status).toBe('ok');
    expect(pollResults[0].totalUnread).toBe(5);

    // 2. Second poll returns login HTML: must NOT report 0 unread!
    await poller.pollNow();
    expect(pollResults.length).toBe(2);
    expect(pollResults[1].status).toBe('auth_required');
    expect(pollResults[1].totalUnread).toBe(5); // Retained previous count!

    poller.stop();
  });

  it('401 response retains previous unread count', async () => {
    const validXml = `<?xml version="1.0" encoding="UTF-8"?><feed><fullcount>3</fullcount></feed>`;

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => validXml,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

    const poller = new AtomFeedPoller('acc-401-retain', 'persist:acc-401-retain', 60, (res) => {
      pollResults.push(res);
    });

    await poller.pollNow();
    expect(pollResults[0].totalUnread).toBe(3);

    await poller.pollNow();
    expect(pollResults[1].status).toBe('auth_required');
    expect(pollResults[1].totalUnread).toBe(3); // Never overwritten with 0

    poller.stop();
  });

  it('subsequent successful poll clears auth_required on recovery', async () => {
    const loginHtml = `<html>Login</html>`;
    const recoveredXml = `<?xml version="1.0" encoding="UTF-8"?><feed><fullcount>7</fullcount></feed>`;

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => loginHtml,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => recoveredXml,
      });

    const poller = new AtomFeedPoller('acc-recovery', 'persist:acc-recovery', 60, (res) => {
      pollResults.push(res);
    });

    // 1. Initial poll fails auth
    await poller.pollNow();
    expect(pollResults[0].status).toBe('auth_required');

    // 2. Recovery poll succeeds
    await poller.pollNow();
    expect(pollResults[1].status).toBe('ok');
    expect(pollResults[1].totalUnread).toBe(7);

    poller.stop();
  });

  it('network fetch error reports network_error without zeroing previous count', async () => {
    const validXml = `<?xml version="1.0" encoding="UTF-8"?><feed><fullcount>4</fullcount></feed>`;

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => validXml,
      })
      .mockRejectedValueOnce(new TypeError('fetch failed'));

    const poller = new AtomFeedPoller('acc-net-err', 'persist:acc-net-err', 60, (res) => {
      pollResults.push(res);
    });

    await poller.pollNow();
    expect(pollResults[0].totalUnread).toBe(4);

    await poller.pollNow();
    expect(pollResults[1].status).toBe('network_error');
    expect(pollResults[1].totalUnread).toBe(4);

    poller.stop();
  });

  it('applies the configured interval literally, switching on power source', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `<feed><fullcount>0</fullcount></feed>`,
    });

    const poller = new AtomFeedPoller('acc5', 'persist:acc5', 60, 180, () => {});
    poller.start();

    // On AC power: the configured 60s, unmodified.
    expect(poller.getEffectiveInterval()).toBe(60000);

    expect(powerMonitorCallbacks['on-battery']).toBeDefined();
    powerMonitorCallbacks['on-battery']();
    expect(poller.getEffectiveInterval()).toBe(180000);

    expect(powerMonitorCallbacks['on-ac']).toBeDefined();
    powerMonitorCallbacks['on-ac']();
    expect(poller.getEffectiveInterval()).toBe(60000);

    // Window focus must not influence the interval at all.
    isWindowFocused = false;
    appCallbacks['browser-window-blur']?.();
    expect(poller.getEffectiveInterval()).toBe(60000);
    appCallbacks['browser-window-focus']?.();
    expect(poller.getEffectiveInterval()).toBe(60000);

    // Dynamic reconfiguration still takes effect.
    poller.setIntervals(30, 120);
    expect(poller.getEffectiveInterval()).toBe(30000);
    powerMonitorCallbacks['on-battery']();
    expect(poller.getEffectiveInterval()).toBe(120000);

    expect(powerMonitorCallbacks['suspend']).toBeDefined();
    powerMonitorCallbacks['suspend']();

    expect(powerMonitorCallbacks['resume']).toBeDefined();
    powerMonitorCallbacks['resume']();

    expect(mockFetch).toHaveBeenCalled();

    poller.stop();
  });
});

describe('Mailbox change hints', () => {
  it('polls shortly after a hint rather than waiting for the scheduled tick', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `<feed><fullcount>3</fullcount></feed>`,
    });

    const poller = new AtomFeedPoller('hint1', 'persist:hint1', 60, 180, () => {});
    await poller.pollNow();
    const baseline = mockFetch.mock.calls.length;

    poller.requestImmediatePoll();
    expect(mockFetch.mock.calls.length).toBe(baseline); // deferred, not instant

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch.mock.calls.length).toBe(baseline + 1);

    poller.stop();
    vi.useRealTimers();
  });

  it('collapses a simultaneous burst of hints into a single poll', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `<feed><fullcount>0</fullcount></feed>`,
    });

    const poller = new AtomFeedPoller('hint2', 'persist:hint2', 60, 180, () => {});
    await poller.pollNow();
    const baseline = mockFetch.mock.calls.length;

    // A draft edit or view change can fire several hints in quick succession.
    poller.requestImmediatePoll();
    poller.requestImmediatePoll();
    poller.requestImmediatePoll();

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch.mock.calls.length).toBe(baseline + 1);

    poller.stop();
    vi.useRealTimers();
  });

  it('defers a hint that lands inside the cooldown instead of dropping it', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `<feed><fullcount>0</fullcount></feed>`,
    });

    const poller = new AtomFeedPoller('hint4', 'persist:hint4', 60, 180, () => {});
    await poller.pollNow();
    const baseline = mockFetch.mock.calls.length;

    // Switching accounts rewrites the title and spends the first hint.
    poller.requestImmediatePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch.mock.calls.length).toBe(baseline + 1);

    // The user then marks a message unread, well inside the cooldown. This is
    // the regression: the action used to be discarded, leaving the badge to
    // wait for the next scheduled tick.
    poller.requestImmediatePoll();
    await vi.advanceTimersByTimeAsync(CHANGE_HINT_COOLDOWN_MS);
    expect(mockFetch.mock.calls.length).toBe(baseline + 2);

    poller.stop();
    vi.useRealTimers();
  });

  it('ignores hints once the poller is stopped', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `<feed><fullcount>0</fullcount></feed>`,
    });

    const poller = new AtomFeedPoller('hint3', 'persist:hint3', 60, 180, () => {});
    await poller.pollNow();
    poller.stop();
    const baseline = mockFetch.mock.calls.length;

    poller.requestImmediatePoll();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockFetch.mock.calls.length).toBe(baseline);

    vi.useRealTimers();
  });
});

describe('Category filtering', () => {
  let pollResults: AtomPollResult[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockFetch.mockReset();
    pollResults = [];
    powerMonitorCallbacks = {};
    appCallbacks = {};
    isWindowFocused = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const rootXml = (count: number) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <fullcount>${count}</fullcount>
</feed>`;

  it('includes all categories when no settings are off', async () => {
    // Only root feed should be fetched; result equals root fullCount
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => rootXml(10),
    });

    const poller = new AtomFeedPoller('cat1', 'persist:cat1', 60, (res) => {
      pollResults.push(res);
    });
    // No settings configured — default is empty {} (all categories included)
    await poller.pollNow();

    expect(pollResults.length).toBe(1);
    expect(pollResults[0].totalUnread).toBe(10);
    // Root feed only — no sub-feed requests
    expect(mockFetch).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  it('subtracts off-category counts from total', async () => {
    // Root returns 10; forums sub-feed returns 3 → displayed = 7
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => rootXml(10),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => rootXml(3),
      });

    const poller = new AtomFeedPoller('cat2', 'persist:cat2', 60, (res) => {
      pollResults.push(res);
    });
    poller.updateNotificationSettings({ forums: 'off' });
    await poller.pollNow();

    expect(pollResults.length).toBe(1);
    expect(pollResults[0].totalUnread).toBe(7);
    // Root + 1 sub-feed
    expect(mockFetch).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it('handles off-category feed 401 gracefully', async () => {
    // Root returns 10; forums sub-feed returns 401 → fallback to root count (10)
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => rootXml(10),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

    const poller = new AtomFeedPoller('cat3', 'persist:cat3', 60, (res) => {
      pollResults.push(res);
    });
    poller.updateNotificationSettings({ forums: 'off' });

    await expect(poller.pollNow()).resolves.toBeUndefined();

    expect(pollResults.length).toBe(1);
    // 401 sub-feed contributes 0; displayed = 10 - 0 = 10
    expect(pollResults[0].totalUnread).toBe(10);

    poller.stop();
  });

  it('clamps to 0 when off categories exceed total', async () => {
    // Root returns 2; forums returns 5 due to race — result should clamp to 0
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => rootXml(2),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => rootXml(5),
      });

    const poller = new AtomFeedPoller('cat4', 'persist:cat4', 60, (res) => {
      pollResults.push(res);
    });
    poller.updateNotificationSettings({ forums: 'off' });
    await poller.pollNow();

    expect(pollResults.length).toBe(1);
    expect(pollResults[0].totalUnread).toBe(0);

    poller.stop();
  });

  it('subtracts multiple off-category counts simultaneously', async () => {
    // Root = 15; forums = 3; promotions = 4 → displayed = 15 - 3 - 4 = 8
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => rootXml(15) }) // root
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => rootXml(3) }) // forums sub-feed
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => rootXml(4) }); // promotions sub-feed

    const poller = new AtomFeedPoller('cat5', 'persist:cat5', 60, (res) => {
      pollResults.push(res);
    });
    poller.updateNotificationSettings({ forums: 'off', promotions: 'off' });
    await poller.pollNow();

    expect(pollResults[0].totalUnread).toBe(8);
    // Root + 2 sub-feeds
    expect(mockFetch).toHaveBeenCalledTimes(3);

    poller.stop();
  });

  it('does not subtract badge, silent, or loud categories from total', async () => {
    // Only 'off' should be subtracted — badge/silent/loud all count toward the badge
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => rootXml(10) });

    const poller = new AtomFeedPoller('cat6', 'persist:cat6', 60, (res) => {
      pollResults.push(res);
    });
    poller.updateNotificationSettings({
      primary: 'loud',
      updates: 'silent',
      promotions: 'badge',
      social: 'badge',
      forums: 'badge',
    });
    await poller.pollNow();

    expect(pollResults[0].totalUnread).toBe(10);
    // Only the root feed should have been fetched — no sub-feed requests
    expect(mockFetch).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  it('ignores unknown category keys in notification settings gracefully', async () => {
    // An unknown key (e.g. a typo) should not trigger a sub-feed fetch
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => rootXml(5) });

    const poller = new AtomFeedPoller('cat7', 'persist:cat7', 60, (res) => {
      pollResults.push(res);
    });
    poller.updateNotificationSettings({ unknownCategory: 'off' } as Record<string, string>);
    await poller.pollNow();

    expect(pollResults[0].totalUnread).toBe(5);
    // Only root feed — unknown key is not in CATEGORY_FEED_PATHS so no sub-fetch
    expect(mockFetch).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  it('updateNotificationSettings takes effect on the next poll', async () => {
    // First poll: no settings configured → count = 10
    // Second poll: forums now off, sub-feed returns 3 → count = 7
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => rootXml(10) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => rootXml(10) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => rootXml(3) });

    const poller = new AtomFeedPoller('cat8', 'persist:cat8', 60, (res) => {
      pollResults.push(res);
    });

    await poller.pollNow();
    expect(pollResults[0].totalUnread).toBe(10);

    poller.updateNotificationSettings({ forums: 'off' });
    await poller.pollNow();
    expect(pollResults[1].totalUnread).toBe(7);

    poller.stop();
  });
});

describe('resolveMessageCategory', () => {
  const feeds = (entries: Record<string, string[]>): Map<NotificationCategory, Set<string>> =>
    new Map(
      Object.entries(entries).map(([cat, ids]) => [cat as NotificationCategory, new Set(ids)]),
    );

  it('reports the category whose sub-feed contains the message', () => {
    const ids = feeds({ updates: ['a'], social: ['b'], promotions: ['c'], forums: ['d'] });
    expect(resolveMessageCategory('a', ids)).toBe('updates');
    expect(resolveMessageCategory('b', ids)).toBe('social');
    expect(resolveMessageCategory('c', ids)).toBe('promotions');
    expect(resolveMessageCategory('d', ids)).toBe('forums');
  });

  it('falls back to primary when the message matches no sub-feed', () => {
    // The residue case, and the common one: Gmail has no "primary" sub-feed
    // membership to match against, so primary is defined by exclusion.
    expect(resolveMessageCategory('unmatched', feeds({ updates: ['a'], forums: ['d'] }))).toBe(
      'primary',
    );
  });

  it('falls back to primary when no sub-feed could be fetched at all', () => {
    // A 401 or a timeout leaves the map empty. Announcing under primary is the
    // safe direction: the message is still heard rather than silently dropped
    // into a category the user may have turned off.
    expect(resolveMessageCategory('a', feeds({}))).toBe('primary');
  });

  it('applies a fixed precedence if a message appears in two sub-feeds', () => {
    expect(resolveMessageCategory('x', feeds({ promotions: ['x'], updates: ['x'] }))).toBe(
      'updates',
    );
  });
});

describe('Category tagging', () => {
  let pollResults: AtomPollResult[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockFetch.mockReset();
    pollResults = [];
    powerMonitorCallbacks = {};
    appCallbacks = {};
    isWindowFocused = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const feedXml = (count: number, ids: string[]) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <fullcount>${count}</fullcount>
  ${ids
    .map(
      (id) => `<entry>
    <title>Subject ${id}</title>
    <id>tag:gmail.google.com,2004:${id}</id>
  </entry>`,
    )
    .join('\n  ')}
</feed>`;

  const ok = (xml: string) => ({ ok: true, status: 200, text: async () => xml });

  it('tags a new message with the sub-feed it appears in', async () => {
    mockFetch
      // baseline poll: msg1 already present, and classified like any other entry
      .mockResolvedValueOnce(ok(feedXml(1, ['msg1'])))
      // sub-feeds, fetched in lookup order: updates, social, promotions, forums
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      // second poll: msg2 has arrived
      .mockResolvedValueOnce(ok(feedXml(2, ['msg2', 'msg1'])))
      .mockResolvedValueOnce(ok(feedXml(1, ['msg2'])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])));

    const poller = new AtomFeedPoller('cattag1', 'persist:cattag1', 60, (res) => {
      pollResults.push(res);
    });
    await poller.pollNow();
    await poller.pollNow();

    expect(pollResults[1].newMessages.map((m) => m.id)).toEqual(['msg2']);
    expect(pollResults[1].newMessages[0].category).toBe('updates');

    poller.stop();
  });

  it('leaves a message that matches no sub-feed as primary', async () => {
    mockFetch
      .mockResolvedValueOnce(ok(feedXml(1, ['msg1'])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(2, ['msg2', 'msg1'])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])));

    const poller = new AtomFeedPoller('cattag2', 'persist:cattag2', 60, (res) => {
      pollResults.push(res);
    });
    await poller.pollNow();
    await poller.pollNow();

    expect(pollResults[1].newMessages[0].category).toBe('primary');

    poller.stop();
  });

  it('classifies the feed once, then costs nothing until the feed changes', async () => {
    mockFetch
      .mockResolvedValueOnce(ok(feedXml(1, ['msg1'])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(1, ['msg1'])));

    const poller = new AtomFeedPoller('cattag3', 'persist:cattag3', 60, (res) => {
      pollResults.push(res);
    });
    await poller.pollNow();
    // Root plus the four lookup sub-feeds: the feed held an id with no verdict.
    expect(mockFetch).toHaveBeenCalledTimes(5);

    await poller.pollNow();
    expect(pollResults[1].newMessages).toEqual([]);
    // The second poll adds the root feed alone — msg1's verdict is remembered.
    expect(mockFetch).toHaveBeenCalledTimes(6);

    poller.stop();
  });

  it('fetches a silenced category once, serving both the count and the tagging', async () => {
    // `forums` is off, so its unread is subtracted from the badge; new mail
    // also needs every lookup category fetched. It must not be fetched twice.
    mockFetch
      .mockResolvedValueOnce(ok(feedXml(1, ['msg1'])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(10, ['msg2', 'msg1'])))
      // forums first: it joins the set for its count before the lookup categories
      .mockResolvedValueOnce(ok(feedXml(3, ['msg2'])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])));

    const poller = new AtomFeedPoller('cattag4', 'persist:cattag4', 60, (res) => {
      pollResults.push(res);
    });
    await poller.pollNow();
    poller.updateNotificationSettings({ forums: 'off' });
    await poller.pollNow();

    // 2 root polls + 4 distinct sub-feeds each — forums is fetched once per
    // poll, serving its count and the tagging together rather than twice
    expect(mockFetch).toHaveBeenCalledTimes(10);
    expect(pollResults[1].totalUnread).toBe(7);
    expect(pollResults[1].newMessages[0].category).toBe('forums');

    poller.stop();
  });

  it('tags every thread in the feed, not only the announced ones', async () => {
    mockFetch
      .mockResolvedValueOnce(ok(feedXml(2, ['msg1', 'msg2'])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(1, ['msg2'])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])));

    const poller = new AtomFeedPoller('cattag5', 'persist:cattag5', 60, (res) => {
      pollResults.push(res);
    });
    await poller.pollNow();

    // A baseline poll announces nothing. The full feed was classified though;
    // confirm via isLive, which tracks what the latest feed listed.
    expect(pollResults[0].newMessages).toEqual([]);
    expect(poller.isLive('msg1')).toBe(true);
    expect(poller.isLive('msg2')).toBe(true);

    poller.stop();
  });

  it('records no verdict when a lookup sub-feed failed', async () => {
    mockFetch
      // First poll: updates is refused, so an id matching nothing might be an
      // update rather than primary — the difference the user would see.
      .mockResolvedValueOnce(ok(feedXml(1, ['msg1'])))
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' })
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      // Second poll: updates answers, and msg1 was an update all along.
      .mockResolvedValueOnce(ok(feedXml(1, ['msg1'])))
      .mockResolvedValueOnce(ok(feedXml(1, ['msg1'])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])));

    const poller = new AtomFeedPoller('cattag6', 'persist:cattag6', 60, (res) => {
      pollResults.push(res);
    });

    // First poll: updates sub-feed failed, so no category can be assigned.
    await poller.pollNow();
    expect(poller.getCategory('msg1')).toBeUndefined();

    // Second poll: updates answered — msg1 is now known to be an update.
    await poller.pollNow();
    expect(poller.getCategory('msg1')).toBe('updates');

    poller.stop();
  });

  it('reports the count before classifying, so marking unread is not held up', async () => {
    // The regression this guards: a thread marked unread re-enters the feed
    // having been pruned from the memo, so classifying in front of the callback
    // put four sub-feed fetches between the user's click and the badge.
    queueRootFeeds(feedXml(1, ['msg1']));

    let fetchesWhenReported = 0;
    const poller = new AtomFeedPoller('cattag8', 'persist:cattag8', 60, (res) => {
      fetchesWhenReported = mockFetch.mock.calls.length;
      pollResults.push(res);
    });
    await poller.pollNow();

    // The root feed alone had been fetched when the count went out.
    expect(fetchesWhenReported).toBe(1);
    // The four lookups still happen — after it.
    expect(mockFetch).toHaveBeenCalledTimes(5);

    poller.stop();
  });

  it('does not hold the poll lock while it classifies', async () => {
    // A hint landing while the lookups are still in flight must still poll.
    // `pollNow` drops a call made while one is running, so holding the lock
    // across classification discards the hint rather than deferring it.
    let releaseSubFeeds: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSubFeeds = resolve;
    });

    mockFetch.mockReset();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/feed/atom')) return feedResponse(feedXml(1, ['msg1']));
      await gate;
      return feedResponse(EMPTY_FEED);
    });

    const poller = new AtomFeedPoller('cattag9', 'persist:cattag9', 60, (res) => {
      pollResults.push(res);
    });

    const first = poller.pollNow();
    await vi.advanceTimersByTimeAsync(0);
    // The count is out, and classification is stalled on the gate.
    expect(pollResults.length).toBe(1);

    // Not awaited: this poll's own classification waits on the same gate. What
    // matters is that it got past the lock and reported at all.
    const second = poller.pollNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollResults.length).toBe(2);

    releaseSubFeeds();
    await Promise.all([first, second]);
    poller.stop();
  });

  it('forgets a thread once it drops out of the feed', async () => {
    mockFetch
      // Classified as social.
      .mockResolvedValueOnce(ok(feedXml(1, ['msg1'])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(1, ['msg1'])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      // Read, so it leaves the unread-only feed. Nothing left to classify.
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      // Marked unread again, and looked up afresh rather than served stale.
      .mockResolvedValueOnce(ok(feedXml(1, ['msg1'])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(0, [])))
      .mockResolvedValueOnce(ok(feedXml(1, ['msg1'])))
      .mockResolvedValueOnce(ok(feedXml(0, [])));

    const poller = new AtomFeedPoller('cattag7', 'persist:cattag7', 60, (res) => {
      pollResults.push(res);
    });

    await poller.pollNow();
    // Baseline poll classifies everything in the feed; msg1 is in the feed as live.
    expect(poller.isLive('msg1')).toBe(true);

    await poller.pollNow();
    // Read, so it left the feed.
    expect(poller.isLive('msg1')).toBe(false);
    // The empty feed held nothing unclassified, so it cost the root fetch alone.
    expect(mockFetch).toHaveBeenCalledTimes(6);

    await poller.pollNow();
    // Marked unread again — it is back in the feed and re-classified from scratch.
    expect(poller.isLive('msg1')).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(11);

    poller.stop();
  });
});

describe('Arrival time vs unread', () => {
  const msg = (issued: string, modified = ''): Parameters<typeof isNewArrival>[0] =>
    ({
      id: 'm',
      threadId: 'm',
      from: '',
      subject: '',
      snippet: '',
      link: '',
      issued,
      modified,
    }) as Parameters<typeof isNewArrival>[0];

  it('reads the arrival time from issued, falling back to modified', () => {
    expect(messageArrivedAt(msg('2026-09-05T11:39:12Z'))).toBe(Date.parse('2026-09-05T11:39:12Z'));
    expect(messageArrivedAt(msg('', '2026-09-05T11:39:12Z'))).toBe(
      Date.parse('2026-09-05T11:39:12Z'),
    );
    expect(messageArrivedAt(msg('not a date'))).toBeNull();
  });

  it('announces a message that arrived after the watermark', () => {
    const watermark = Date.parse('2026-09-05T10:00:00Z');
    expect(isNewArrival(msg('2026-09-05T11:00:00Z'), watermark)).toBe(true);
  });

  it('allows for delivery delay, so mail overtaken in transit still counts', () => {
    // `issued` is when a message was sent. Greylisting and relay backoff mean a
    // message can land after one stamped later than itself.
    const watermark = Date.parse('2026-09-05T10:00:00Z');
    const delayed = msg(new Date(watermark - 12 * 60 * 1000).toISOString());
    expect(isNewArrival(delayed, watermark)).toBe(true);
  });

  it('stops allowing for it past the tolerance', () => {
    const watermark = Date.parse('2026-09-05T10:00:00Z');
    const older = msg(new Date(watermark - ARRIVAL_TOLERANCE_MS - 1000).toISOString());
    expect(isNewArrival(older, watermark)).toBe(false);
  });

  it('stays quiet about a message that predates the watermark', () => {
    // The case this exists for: an old message marked unread re-enters the
    // feed with an id the poller never recorded. It did not arrive.
    const watermark = Date.parse('2026-09-05T10:00:00Z');
    expect(isNewArrival(msg('2026-08-15T09:00:00Z'), watermark)).toBe(false);
  });

  it('does not swallow a second message landing in the same second', () => {
    const watermark = Date.parse('2026-09-05T10:00:00Z');
    expect(isNewArrival(msg('2026-09-05T10:00:00Z'), watermark)).toBe(true);
  });

  it('announces a message whose date cannot be read', () => {
    expect(isNewArrival(msg(''), Date.parse('2026-09-05T10:00:00Z'))).toBe(true);
  });
});

describe('Notifications follow arrival, counts follow unread', () => {
  let pollResults: AtomPollResult[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockFetch.mockReset();
    pollResults = [];
    powerMonitorCallbacks = {};
    appCallbacks = {};
    isWindowFocused = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  const datedFeed = (count: number, entries: Array<[string, string]>) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <fullcount>${count}</fullcount>
  ${entries
    .map(
      ([id, issued]) => `<entry>
    <title>Subject ${id}</title>
    <id>tag:gmail.google.com,2004:${id}</id>
    <issued>${issued}</issued>
  </entry>`,
    )
    .join('\n  ')}
</feed>`;

  it('does not announce an old message that was marked unread, but still counts it', async () => {
    queueRootFeeds(
      // baseline: one message from an hour ago sets the watermark
      datedFeed(1, [['recent', at(-3600_000)]]),
      // a three-week-old message reappears unread, alongside it
      datedFeed(2, [
        ['recent', at(-3600_000)],
        ['ancient', at(-21 * 86400_000)],
      ]),
    );

    const poller = new AtomFeedPoller('wm1', 'persist:wm1', 60, (res) => pollResults.push(res));
    await poller.pollNow();
    await poller.pollNow();

    // No banner...
    expect(pollResults[1].newMessages).toEqual([]);
    // ...but the badge still reports it, because it *is* unread.
    expect(pollResults[1].totalUnread).toBe(2);
    // Two root polls, each carrying an id with no verdict — 'recent' on the
    // first and 'ancient' on the second — so each pays for the four lookups.
    expect(mockFetch).toHaveBeenCalledTimes(10);

    poller.stop();
  });

  it('announces a message that genuinely arrived after the last poll', async () => {
    queueRootFeeds(
      datedFeed(1, [['old', at(-3600_000)]]),
      datedFeed(2, [
        ['fresh', at(-1000)],
        ['old', at(-3600_000)],
      ]),
    );

    const poller = new AtomFeedPoller('wm2', 'persist:wm2', 60, (res) => pollResults.push(res));
    await poller.pollNow();
    await poller.pollNow();

    expect(pollResults[1].newMessages.map((m) => m.id)).toEqual(['fresh']);

    poller.stop();
  });

  it('is not blinded by a message dated in the future', async () => {
    // Spam routinely carries a date years ahead. If that set the watermark,
    // every genuine arrival after it would be silently suppressed.
    queueRootFeeds(
      datedFeed(1, [['old', at(-3600_000)]]),
      datedFeed(2, [
        ['spam', at(10 * 365 * 86400_000)],
        ['old', at(-3600_000)],
      ]),
      datedFeed(3, [
        ['genuine', at(-1000)],
        ['spam', at(10 * 365 * 86400_000)],
        ['old', at(-3600_000)],
      ]),
    );

    const poller = new AtomFeedPoller('wm3', 'persist:wm3', 60, (res) => pollResults.push(res));
    await poller.pollNow();
    await poller.pollNow();
    await poller.pollNow();

    expect(pollResults[1].newMessages.map((m) => m.id)).toEqual(['spam']);
    expect(pollResults[2].newMessages.map((m) => m.id)).toEqual(['genuine']);

    poller.stop();
  });
});

describe('Reading a message then marking it unread', () => {
  let pollResults: AtomPollResult[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockFetch.mockReset();
    pollResults = [];
    powerMonitorCallbacks = {};
    appCallbacks = {};
    isWindowFocused = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  const datedFeed = (count: number, entries: Array<[string, string]>) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <fullcount>${count}</fullcount>
  ${entries
    .map(
      ([id, issued]) => `<entry>
    <title>Subject ${id}</title>
    <id>tag:gmail.google.com,2004:${id}</id>
    <issued>${issued}</issued>
  </entry>`,
    )
    .join('\n  ')}
</feed>`;

  // The id gate, not the watermark, settles this: a message the poller has
  // announced is recorded for good, so marking it unread minutes later cannot
  // produce a second banner however recently it arrived.
  it('announces once, then stays silent when the message returns unread', async () => {
    queueRootFeeds(
      // baseline
      datedFeed(1, [['old', at(-7200_000)]]),
      // it arrives and is announced
      datedFeed(2, [
        ['fresh', at(-10_000)],
        ['old', at(-7200_000)],
      ]),
      // read, so it leaves the feed
      datedFeed(1, [['old', at(-7200_000)]]),
      // marked unread three minutes later, so it comes back
      datedFeed(2, [
        ['fresh', at(-10_000)],
        ['old', at(-7200_000)],
      ]),
    );

    const poller = new AtomFeedPoller('unread1', 'persist:unread1', 60, (res) =>
      pollResults.push(res),
    );
    await poller.pollNow();
    await poller.pollNow();
    await poller.pollNow();
    await poller.pollNow();

    expect(pollResults[1].newMessages.map((m) => m.id)).toEqual(['fresh']);
    expect(pollResults[3].newMessages).toEqual([]);
    // Still unread, so it still counts.
    expect(pollResults[3].totalUnread).toBe(2);

    poller.stop();
  });

  it('still announces a message delayed in transit behind newer mail', async () => {
    // Never seen unread, sent before the message that set the mark: the
    // tolerance is the only thing that lets this through.
    queueRootFeeds(
      datedFeed(1, [['first', at(-60_000)]]),
      datedFeed(2, [
        ['delayed', at(-15 * 60_000)],
        ['first', at(-60_000)],
      ]),
    );

    const poller = new AtomFeedPoller('unread2', 'persist:unread2', 60, (res) =>
      pollResults.push(res),
    );
    await poller.pollNow();
    await poller.pollNow();

    expect(pollResults[1].newMessages.map((m) => m.id)).toEqual(['delayed']);

    poller.stop();
  });
});

describe('New arrivals badge count', () => {
  let pollResults: AtomPollResult[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockFetch.mockReset();
    pollResults = [];
    powerMonitorCallbacks = {};
    appCallbacks = {};
    isWindowFocused = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSecretFiles();
  });

  const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  const datedFeed = (count: number, entries: Array<[string, string]>) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <fullcount>${count}</fullcount>
  ${entries
    .map(
      ([id, issued]) => `<entry>
    <title>Subject ${id}</title>
    <id>tag:gmail.google.com,2004:${id}</id>
    <issued>${issued}</issued>
  </entry>`,
    )
    .join('\n  ')}
</feed>`;

  it('starts at zero however large the unread backlog is', async () => {
    queueRootFeeds(
      datedFeed(300, [
        ['a', at(-60_000)],
        ['b', at(-120_000)],
      ]),
    );

    const poller = new AtomFeedPoller('arr1', 'persist:arr1', 60, (res) => pollResults.push(res));
    await poller.pollNow();

    expect(pollResults[0].totalUnread).toBe(300);
    expect(pollResults[0].newArrivalCount).toBe(0);
    poller.stop();
  });

  it('counts an arrival, then drops it when the message is read', async () => {
    queueRootFeeds(
      datedFeed(1, [['old', at(-3600_000)]]),
      datedFeed(2, [
        ['fresh', at(-1000)],
        ['old', at(-3600_000)],
      ]),
      // 'fresh' read: it leaves the feed, 'old' stays unread
      datedFeed(1, [['old', at(-3600_000)]]),
    );

    const poller = new AtomFeedPoller('arr2', 'persist:arr2', 60, (res) => pollResults.push(res));
    await poller.pollNow();
    await poller.pollNow();
    await poller.pollNow();

    expect(pollResults[1].newArrivalCount).toBe(1);
    // The backlog is untouched by the read, and the arrival count is now clear.
    expect(pollResults[2].totalUnread).toBe(1);
    expect(pollResults[2].newArrivalCount).toBe(0);
    poller.stop();
  });

  it('ignores a backlog message marked unread again', async () => {
    queueRootFeeds(
      datedFeed(1, [['recent', at(-3600_000)]]),
      datedFeed(2, [
        ['recent', at(-3600_000)],
        ['ancient', at(-21 * 86400_000)],
      ]),
    );

    const poller = new AtomFeedPoller('arr3', 'persist:arr3', 60, (res) => pollResults.push(res));
    await poller.pollNow();
    await poller.pollNow();

    // It counts as unread, as it should, but it did not *arrive*.
    expect(pollResults[1].totalUnread).toBe(2);
    expect(pollResults[1].newArrivalCount).toBe(0);
    poller.stop();
  });

  it('survives a restart, because the badge it feeds does', async () => {
    queueRootFeeds(
      datedFeed(1, [['old', at(-3600_000)]]),
      datedFeed(2, [
        ['fresh', at(-1000)],
        ['old', at(-3600_000)],
      ]),
    );

    const first = new AtomFeedPoller('arr4', 'persist:arr4', 60, (res) => pollResults.push(res));
    await first.pollNow();
    await first.pollNow();
    first.stop();
    expect(pollResults[1].newArrivalCount).toBe(1);

    // Same account id, so the new poller reads the state the old one wrote.
    // Nothing has been read, so the arrival is still waiting.
    queueRootFeeds(
      datedFeed(2, [
        ['fresh', at(-1000)],
        ['old', at(-3600_000)],
      ]),
    );
    const restarted = new AtomFeedPoller('arr4', 'persist:arr4', 60, (res) =>
      pollResults.push(res),
    );
    await restarted.pollNow();

    expect(pollResults[2].newArrivalCount).toBe(1);
    restarted.stop();
  });

  /**
   * The known cost of pruning on absence, pinned deliberately.
   *
   * The feed pages its entry list, so a mailbox larger than one page hides its
   * oldest unread. An arrival that falls out that way is indistinguishable from
   * one that was read, and is dropped — the badge undercounts rather than
   * drifting upward forever, which is the trade `docs/magimail/notifications.md#paged-feed` sets
   * out. Should this
   * ever need revisiting, it is the assertion to change.
   */
  /**
   * The flag is read off the response — `<fullcount>` against the number of
   * entries returned — so no page size is assumed anywhere. Whatever the feed
   * chooses to send, a total larger than the listing means it held some back.
   */
  it('flags the count as a floor when the feed lists fewer than it counts', async () => {
    queueRootFeeds(
      // 40 unread, two listed: the feed kept the rest back.
      datedFeed(40, [
        ['a', at(-1000)],
        ['b', at(-2000)],
      ]),
    );

    const poller = new AtomFeedPoller('inc1', 'persist:inc1', 60, (res) => pollResults.push(res));
    await poller.pollNow();

    expect(pollResults[0].arrivalsIncomplete).toBe(true);
    poller.stop();
  });

  it('reports an exact count when the feed lists everything it counts', async () => {
    queueRootFeeds(
      datedFeed(2, [
        ['a', at(-1000)],
        ['b', at(-2000)],
      ]),
    );

    const poller = new AtomFeedPoller('inc2', 'persist:inc2', 60, (res) => pollResults.push(res));
    await poller.pollNow();

    expect(pollResults[0].arrivalsIncomplete).toBe(false);
    poller.stop();
  });

  it('marks arrivals incomplete and continues when an entry has an unresolvable message id', async () => {
    const xmlWithEmptyId = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <fullcount>2</fullcount>
  <entry>
    <title>Valid Message</title>
    <id>tag:gmail.google.com,2004:msg1</id>
    <issued>${at(-1000)}</issued>
  </entry>
  <entry>
    <title>Unresolvable Message</title>
    <issued>${at(-2000)}</issued>
  </entry>
</feed>`;
    queueRootFeeds(xmlWithEmptyId);

    const poller = new AtomFeedPoller('inc_unresolvable', 'persist:inc_unresolvable', 60, (res) =>
      pollResults.push(res),
    );
    await poller.pollNow();

    expect(pollResults[0].arrivalsIncomplete).toBe(true);
    poller.stop();
  });

  it('reports its saved count before the first poll, so the badge is not blank', async () => {
    queueRootFeeds(
      datedFeed(1, [['old', at(-3600_000)]]),
      datedFeed(2, [
        ['fresh', at(-1000)],
        ['old', at(-3600_000)],
      ]),
    );

    const first = new AtomFeedPoller('arr7', 'persist:arr7', 60, (res) => pollResults.push(res));
    await first.pollNow();
    await first.pollNow();
    first.stop();
    expect(pollResults[1].newArrivalCount).toBe(1);

    // A fresh poller for the same account knows the count from disk alone —
    // no fetch has happened yet.
    const restarted = new AtomFeedPoller('arr7', 'persist:arr7', 60, (res) =>
      pollResults.push(res),
    );
    expect(restarted.getArrivalCount()).toBe(1);
    restarted.stop();
  });

  it('starts from an empty count when the saved state will not decrypt', async () => {
    packagedBuild(Buffer.alloc(32, 8));
    queueRootFeeds(
      datedFeed(1, [['old', at(-3600_000)]]),
      datedFeed(2, [
        ['fresh', at(-1000)],
        ['old', at(-3600_000)],
      ]),
    );

    const first = new AtomFeedPoller('arr8', 'persist:arr8', 60, (res) => pollResults.push(res));
    await first.pollNow();
    await first.pollNow();
    first.stop();
    expect(first.getArrivalCount()).toBe(1);

    // The keychain answers with a different key, so the state on disk yields
    // nothing. The badge starts from zero and the next poll rebuilds it.
    packagedBuild(Buffer.alloc(32, 9));
    const restarted = new AtomFeedPoller('arr8', 'persist:arr8', 60, (res) =>
      pollResults.push(res),
    );
    expect(restarted.getArrivalCount()).toBe(0);
    restarted.stop();
  });

  it('drops an arrival the feed stops listing, even if it is still unread', async () => {
    queueRootFeeds(
      datedFeed(1, [['old', at(-3600_000)]]),
      datedFeed(2, [
        ['fresh', at(-1000)],
        ['old', at(-3600_000)],
      ]),
      // 'fresh' is still unread, but a busy mailbox has pushed it off the page.
      datedFeed(40, [['old', at(-3600_000)]]),
    );

    const poller = new AtomFeedPoller('arr6', 'persist:arr6', 60, (res) => pollResults.push(res));
    await poller.pollNow();
    await poller.pollNow();
    await poller.pollNow();

    expect(pollResults[1].newArrivalCount).toBe(1);
    // Unread says 40; the arrival count has let go of what it can no longer see.
    expect(pollResults[2].totalUnread).toBe(40);
    expect(pollResults[2].newArrivalCount).toBe(0);
    poller.stop();
  });

  it('leaves a silenced category out of the count, as the unread total does', async () => {
    const dated = (count: number, entries: Array<[string, string]>) => datedFeed(count, entries);
    const ok = (xml: string) => ({ ok: true, status: 200, text: async () => xml });

    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('smartlabel_promo')) {
        return Promise.resolve(ok(dated(1, [['ad', at(-1000)]])));
      }
      if (!url.endsWith('/feed/atom')) return Promise.resolve(ok(EMPTY_FEED));
      return Promise.resolve(
        ok(
          mockFetch.mock.calls.filter((c) => (c[0] as string).endsWith('/feed/atom')).length === 1
            ? dated(1, [['old', at(-3600_000)]])
            : dated(2, [
                ['ad', at(-1000)],
                ['old', at(-3600_000)],
              ]),
        ),
      );
    });

    const poller = new AtomFeedPoller('arr5', 'persist:arr5', 60, (res) => pollResults.push(res));
    poller.updateNotificationSettings({ promotions: 'off' });
    await poller.pollNow();
    await poller.pollNow();

    // The message did arrive and is reported as such — `dispatchNotifications`
    // owns whether it is announced — but a silenced category never badges.
    expect(pollResults[1].newMessages.map((m) => m.id)).toEqual(['ad']);
    // 2 unread minus the 1 silenced promotion, and the arrival is silenced too.
    expect(pollResults[1].totalUnread).toBe(1);
    expect(pollResults[1].newArrivalCount).toBe(0);
    poller.stop();
  });

  it('exposes latest feed entries for tray and widget fallback via getLatestEntries', async () => {
    queueRootFeeds(
      datedFeed(2, [
        ['msg1', at(-5000)],
        ['msg2', at(-10000)],
      ]),
    );

    const poller = new AtomFeedPoller('fallback1', 'persist:fallback1', 60, () => {});
    expect(poller.getLatestEntries()).toEqual([]);

    await poller.pollNow();

    const entries = poller.getLatestEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.id)).toEqual(['msg1', 'msg2']);
    poller.stop();
  });

  it('atomMessageToTrayMessageItem converts feed entry to tray item format', () => {
    const item = atomMessageToTrayMessageItem({
      id: 'atom_123',
      threadId: 'atom_123',
      from: 'Taylor <taylor@example.com>',
      subject: 'Hello World',
      snippet: 'This is a test snippet',
      link: 'https://mail.google.com/mail/u/0/#inbox/atom_123',
      issued: '2026-10-18T12:00:00Z',
      modified: '2026-10-18T12:05:00Z',
      category: 'updates',
    });

    expect(item).toEqual({
      id: 'atom_123',
      threadId: 'atom_123',
      from: 'Taylor <taylor@example.com>',
      subject: 'Hello World',
      snippet: 'This is a test snippet',
      modified: new Date('2026-10-18T12:05:00Z'),
      category: 'updates',
      unread: true,
    });
  });
});
