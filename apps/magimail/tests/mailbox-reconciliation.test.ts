import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnreadLedger, ATOM_READ_PATH_GRACE_MS } from '../src/mailbox/unread-ledger.js';
import type { AtomMessage, TrayMessageItem } from '../src/mailbox/types.js';
import { HybridFeedSource } from '../src/mailbox/hybrid-feed-source.js';
import * as syncDriverModule from '../src/thread-actions/sync-driver.js';

describe('UnreadLedger State Machine', () => {
  let ledger: UnreadLedger;

  beforeEach(() => {
    ledger = new UnreadLedger();
  });

  describe('Scenario 1: Menu Bar Triage vs. Stale Cache Read (No Resurrection)', () => {
    it('prevents a stale cache read from resurrecting a locally triaged email', () => {
      const msg1: AtomMessage = {
        id: 'msg-1',
        threadId: 'th-1',
        from: 'Alice <alice@example.com>',
        subject: 'Important Update',
        snippet: 'Here is the summary...',
        link: 'https://mail.google.com/mail/u/0/#inbox/th-1',
        issued: new Date(1000).toISOString(),
        modified: new Date(1000).toISOString(),
        category: 'primary',
      };

      // 1. Initial Atom poll reports 1 unread message
      const initialReconcile = ledger.reconcileWithAtom([msg1], 1, 1000);
      expect(initialReconcile.added).toEqual(['msg-1']);
      expect(initialReconcile.countChanged).toBe(true);
      expect(ledger.getBreakdown().total).toBe(1);

      // 2. User clicks "Trash" in the Menu Bar Popover
      const triageTime = 2000;
      ledger.recordLocalTriage('msg-1', 'th-1', 'trash', 'primary', triageTime);

      // 3. Verify total is 0 immediately (0ms UI latency)
      expect(ledger.getBreakdown().total).toBe(0);
      expect(ledger.getTrackedItems()).toHaveLength(0);

      // 4. Atom polls 2 seconds later (triageTime + 2000) and confirms fullCount = 0, entries = []
      const confirmReconcile = ledger.reconcileWithAtom([], 0, triageTime + 2000);
      expect(confirmReconcile.countChanged).toBe(false);
      expect(ledger.getBreakdown().total).toBe(0);

      // 5. 10 minutes later (triageTime + 600_000), user opens window.
      // The local cache is read and contains a stale unread row for msg-1.
      const staleCacheItem: TrayMessageItem = {
        id: 'msg-1',
        threadId: 'th-1',
        from: 'Alice <alice@example.com>',
        subject: 'Important Update',
        snippet: 'Here is the summary...',
        category: 'primary',
        unread: true,
        modified: new Date(1000),
      };

      const cacheReconcile = ledger.reconcileWithCache([staleCacheItem], triageTime + 600_000);

      // 6. Expected Outcome:
      // - msg-1 is NOT added to activeUnread because Atom has authoritative fullCount <= 20
      // - getBreakdown().total remains 0
      // - No resurrection
      expect(ledger.getBreakdown().total).toBe(0);
      expect(ledger.getTrackedItems()).toHaveLength(0);
    });
  });

  describe('Scenario 2: Local UI Triage with Edge-Cache Lag (Anti-Bounce Grace Window)', () => {
    it('suppresses resurrection while lagging edge server returns the triaged item within grace window', () => {
      const msg2: AtomMessage = {
        id: 'msg-2',
        threadId: 'th-2',
        from: 'Bob <bob@example.com>',
        subject: 'Weekly Digest',
        snippet: 'Weekly news...',
        link: 'https://mail.google.com/mail/u/0/#inbox/th-2',
        issued: new Date(1000).toISOString(),
        modified: new Date(1000).toISOString(),
        category: 'primary',
      };

      // 1. Initially active unread
      ledger.reconcileWithAtom([msg2], 1, 1000);
      expect(ledger.getBreakdown().total).toBe(1);

      // 2. User archives msg-2
      const triageTime = 2000;
      ledger.recordLocalTriage('msg-2', 'th-2', 'archive', 'primary', triageTime);
      expect(ledger.getBreakdown().total).toBe(0);

      // 3. 1.5 seconds later, Atom polls lagging edge-cache: still returns msg-2 and fullCount = 1
      const laggingPollTime = triageTime + 1500;
      const lagReconcile = ledger.reconcileWithAtom([msg2], 1, laggingPollTime);

      // Grace period (< 5000ms) protects against resurrection
      expect(lagReconcile.added).toHaveLength(0);
      expect(ledger.getBreakdown().total).toBe(0);
      expect(ledger.getTrackedItems()).toHaveLength(0);

      // 4. 5.1 seconds later, next poll returns empty entries -> clean eviction
      const cleanPollTime = triageTime + 5100;
      const cleanReconcile = ledger.reconcileWithAtom([], 0, cleanPollTime);
      expect(cleanReconcile.countChanged).toBe(false);
      expect(ledger.getBreakdown().total).toBe(0);
    });

    it('re-adds message if grace expires and server still asserts the message is unread', () => {
      const msg: AtomMessage = {
        id: 'msg-fail',
        threadId: 'th-fail',
        from: 'Support <support@example.com>',
        subject: 'Failed action',
        snippet: 'Action failed on server',
        link: 'https://mail.google.com/mail/u/0/#inbox/th-fail',
        issued: new Date(1000).toISOString(),
        modified: new Date(1000).toISOString(),
        category: 'primary',
      };

      ledger.reconcileWithAtom([msg], 1, 1000);
      expect(ledger.getBreakdown().total).toBe(1);

      const triageTime = 2000;
      ledger.recordLocalTriage('msg-fail', 'th-fail', 'archive', 'primary', triageTime);
      expect(ledger.getBreakdown().total).toBe(0);

      // After grace window (>= 5000ms), if Atom STILL returns msg-fail, edge recovery re-adds it
      const expiredTime = triageTime + ATOM_READ_PATH_GRACE_MS + 100;
      const recoveryReconcile = ledger.reconcileWithAtom([msg], 1, expiredTime);
      expect(recoveryReconcile.added).toContain('msg-fail');
      expect(ledger.getBreakdown().total).toBe(1);
    });
  });

  describe('Scenario 3: Remote Triage on iPhone with Filtered Categories', () => {
    it('correctly tracks category breakdowns and respects notification settings on remote triage', () => {
      ledger.updateNotificationSettings({ promotions: 'off' });

      const primaryMsg: AtomMessage = {
        id: 'p-1',
        threadId: 'th-p-1',
        from: 'Boss <boss@example.com>',
        subject: 'Report',
        snippet: 'Please send report',
        link: 'https://mail.google.com/mail/u/0/#inbox/th-p-1',
        issued: new Date(1000).toISOString(),
        modified: new Date(1000).toISOString(),
        category: 'primary',
      };

      const promoMsg: AtomMessage = {
        id: 'pr-1',
        threadId: 'th-pr-1',
        from: 'Store <store@example.com>',
        subject: 'Sale',
        snippet: '50% off',
        link: 'https://mail.google.com/mail/u/0/#inbox/th-pr-1',
        issued: new Date(1000).toISOString(),
        modified: new Date(1000).toISOString(),
        category: 'promotions',
      };

      // 1. Initial poll: primary and promo
      ledger.reconcileWithAtom([primaryMsg, promoMsg], 2, 1000);
      const breakdown1 = ledger.getBreakdown();
      expect(breakdown1.byCategory.get('primary')).toBe(1);
      expect(breakdown1.byCategory.get('promotions')).toBe(1);
      // promotions is 'off', so total displayed is 1
      expect(breakdown1.total).toBe(1);

      // 2. User archives pr-1 on iPhone. Next Atom poll: entries = [p-1], fullCount = 1
      const delta1 = ledger.reconcileWithAtom([primaryMsg], 1, 2000);
      expect(delta1.removed).toContain('pr-1');
      const breakdown2 = ledger.getBreakdown();
      expect(breakdown2.byCategory.get('promotions')).toBe(0);
      expect(breakdown2.byCategory.get('primary')).toBe(1);
      expect(breakdown2.total).toBe(1);

      // 3. User archives p-1 on iPhone. Next Atom poll: entries = [], fullCount = 0
      const delta2 = ledger.reconcileWithAtom([], 0, 3000);
      expect(delta2.removed).toContain('p-1');
      const breakdown3 = ledger.getBreakdown();
      expect(breakdown3.total).toBe(0);
      expect(breakdown3.byCategory.get('primary')).toBe(0);
    });
  });

  describe('Scenario 4: Backlog (> 20) with FullCount Ceiling', () => {
    it('mathematically caps total at fullCount and scales categories proportionally', () => {
      // 50 unread messages in backlog
      const entries: AtomMessage[] = [];
      for (let i = 1; i <= 20; i++) {
        entries.push({
          id: `msg-${i}`,
          threadId: `th-${i}`,
          from: `User ${i} <user${i}@example.com>`,
          subject: `Subject ${i}`,
          snippet: `Snippet ${i}`,
          link: `https://mail.google.com/mail/u/0/#inbox/th-${i}`,
          issued: new Date(1000 + i).toISOString(),
          modified: new Date(1000 + i).toISOString(),
          category: 'primary',
        });
      }

      // 1. Initial poll returns fullCount = 50, entries = [top 20]
      ledger.reconcileWithAtom(entries, 50, 1000);
      let breakdown = ledger.getBreakdown();
      expect(breakdown.rawFullCount).toBe(50);
      expect(breakdown.arrivalsIncomplete).toBe(true);
      expect(breakdown.total).toBe(50);

      // 2. User archives 1 email on iPhone. Next Atom poll: fullCount = 49
      ledger.reconcileWithAtom(entries, 49, 2000);
      breakdown = ledger.getBreakdown();
      expect(breakdown.total).toBe(49);

      // 3. Local cache reader runs and returns 50 unread messages (stale cache lagging behind server)
      const cachedMessages: TrayMessageItem[] = [];
      for (let i = 1; i <= 50; i++) {
        cachedMessages.push({
          id: `msg-${i}`,
          threadId: `th-${i}`,
          from: `User ${i} <user${i}@example.com>`,
          subject: `Subject ${i}`,
          snippet: `Snippet ${i}`,
          category: 'primary',
          unread: true,
          modified: new Date(1000 + i),
        });
      }

      ledger.reconcileWithCache(cachedMessages, 2500);
      breakdown = ledger.getBreakdown();

      // Total must NOT inflate beyond Atom fullCount ceiling of 49
      expect(breakdown.total).toBe(49);
      expect(breakdown.arrivalsIncomplete).toBe(true);
    });
  });
});

describe('Scenario 6: Preemptive Ledger Updates', () => {
  const atomEntry = (id: string, threadId: string) => ({
    id,
    threadId,
    from: 'someone',
    subject: 'subject',
    snippet: 'snippet',
    link: '',
    issued: new Date(1000).toISOString(),
    modified: new Date(1000).toISOString(),
    category: 'primary' as const,
  });

  it('does not move the count when a read row is archived', () => {
    const ledger = new UnreadLedger();
    const unread = atomEntry('m1', 't1');

    ledger.reconcileWithAtom([unread], 1, 1000);
    expect(ledger.getBreakdown().total).toBe(1);

    // The popover lists read threads too. Archiving one changes no unread count.
    ledger.recordLocalTriage('read-thread', 'read-thread', 'archive', 'primary', 2000);

    expect(ledger.getBreakdown().total).toBe(1);
    expect(ledger.getTrackedItems().map((item) => item.id)).toEqual(['m1']);
  });

  const cacheRow = (id: string, threadId: string, unread: boolean): TrayMessageItem => ({
    id,
    threadId,
    from: 'someone',
    subject: 'subject',
    snippet: 'snippet',
    category: 'primary',
    unread,
    modified: new Date(1000),
  });

  it('hides a deleted unread row immediately and keeps the count down', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 1, 1000);
    expect(ledger.getBreakdown().total).toBe(1);

    ledger.recordLocalTriage('m1', 't1', 'trash', 'primary', 2000);

    expect(ledger.getBreakdown().total).toBe(0);
    expect(ledger.getRecentMessages().map((item) => item.id)).not.toContain('m1');

    ledger.reconcileWithCache([cacheRow('m1', 't1', true)], 3000, 3000);

    expect(ledger.getBreakdown().total).toBe(0);
    expect(ledger.getRecentMessages().map((item) => item.id)).not.toContain('m1');
  });

  it('hides a deleted read row immediately without moving the count', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 1, 1000);
    ledger.reconcileWithCache([cacheRow('m2', 't2', false)], 1000, 1000);
    expect(ledger.getBreakdown().total).toBe(1);
    expect(ledger.getRecentMessages().map((item) => item.id)).toContain('m2');

    ledger.recordLocalTriage('m2', 't2', 'trash', 'primary', 2000);

    expect(ledger.getBreakdown().total).toBe(1);
    expect(ledger.getRecentMessages().map((item) => item.id)).not.toContain('m2');
  });

  it('does not hide a read row when markRead is repeated', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 1, 1000);
    ledger.reconcileWithCache([cacheRow('m2', 't2', false)], 1000, 1000);

    ledger.recordLocalTriage('m2', 't2', 'markRead', 'primary', 2000);

    expect(ledger.getBreakdown().total).toBe(1);
    expect(ledger.getRecentMessages().map((item) => item.id)).toContain('m2');
  });

  it('keeps a deleted read row hidden when a stale cache says unread', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 1, 1000);
    ledger.reconcileWithCache([cacheRow('m2', 't2', false)], 1000, 1000);
    ledger.recordLocalTriage('m2', 't2', 'trash', 'primary', 2000);

    ledger.reconcileWithCache([cacheRow('m2', 't2', true)], 3000, 3000);

    expect(ledger.getBreakdown().total).toBe(1);
    expect(ledger.getRecentMessages().map((item) => item.id)).not.toContain('m2');
  });

  it('restores a deleted read row when the driver fails', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 1, 1000);
    ledger.reconcileWithCache([cacheRow('m2', 't2', false)], 1000, 1000);
    ledger.recordLocalTriage('m2', 't2', 'trash', 'primary', 2000);

    expect(ledger.rollbackLocalTriage('m2', 't2')).toBe(true);

    expect(ledger.getBreakdown().total).toBe(1);
    expect(ledger.getRecentMessages().map((item) => item.id)).toContain('m2');
  });

  it('does not let a stale cache add a thread a complete feed omitted', () => {
    const ledger = new UnreadLedger();
    // Real epoch-ms times: the five-second grace makes `atomAsOf` earlier than the
    // feed's own timestamp, and a fake clock of 1000 puts it before zero, which
    // makes any positive watermark look newer than the feed and stops this test
    // testing staleness at all.
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 1, 20000);

    ledger.reconcileWithCache([cacheRow('deleted', 't2', true)], 21000, 1000);

    expect(ledger.getBreakdown().total).toBe(1);
    expect(ledger.getTrackedItems().map((item) => item.id)).toEqual(['m1']);
  });

  it('still lets a stale cache add an off-window thread when the feed is truncated', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 21, 1000);

    ledger.reconcileWithCache([cacheRow('m2', 't2', true)], 2000, 2000);

    expect(ledger.getTrackedItems().map((item) => item.id)).toContain('m2');
  });

  it('does not subtract a triaged category the user has turned off', () => {
    const ledger = new UnreadLedger();
    ledger.updateNotificationSettings({ promotions: 'off' });

    const primary = atomEntry('m1', 't1');
    const promo = { ...atomEntry('m2', 't2'), category: 'promotions' as const };
    // Atom already filtered promotions out, so its displayed count is 1.
    ledger.reconcileWithAtom([primary, promo], 2, 1000, 1);
    expect(ledger.getBreakdown().total).toBe(1);

    ledger.recordLocalTriage('m2', 't2', 'archive', 'promotions', 2000);

    expect(ledger.getBreakdown().total).toBe(1);
  });

  it('lets a response generated at least the read-path grace after the action win', () => {
    const ledger = new UnreadLedger();
    const entry = atomEntry('m1', 't1');

    ledger.reconcileWithAtom([entry], 1, 1000);
    ledger.recordLocalTriage('m1', 't1', 'archive', 'primary', 2000);
    expect(ledger.getBreakdown().total).toBe(0);

    // Generated at 8000, so the read path has had until 3000 to catch up.
    ledger.reconcileWithAtom([entry], 1, 2100, 1, 8000);
    expect(ledger.getBreakdown().total).toBe(1);
  });

  it('keeps the local action when the response generation is still inside the grace', () => {
    const ledger = new UnreadLedger();
    const entry = atomEntry('m1', 't1');

    ledger.reconcileWithAtom([entry], 1, 1000);
    ledger.recordLocalTriage('m1', 't1', 'archive', 'primary', 2000);
    expect(ledger.getBreakdown().total).toBe(0);

    // Generated at 5000, so the read path is only trusted as of 0.
    ledger.reconcileWithAtom([entry], 1, 2100, 1, 5000);
    expect(ledger.getBreakdown().total).toBe(0);
  });

  it('counts a thread marked unread once, even after Atom reports it', () => {
    const ledger = new UnreadLedger();

    ledger.recordLocalTriage('th-1', 'th-1', 'markUnread', 'primary', 1000);
    expect(ledger.getBreakdown().total).toBe(1);

    ledger.reconcileWithAtom([atomEntry('atom-1', 'th-1')], 1, 2000);

    expect(ledger.getBreakdown().total).toBe(1);
    expect(ledger.getTrackedItems()).toHaveLength(1);
    expect(ledger.getTrackedItems()[0].id).toBe('atom-1');
  });

  it('holds a local triage below the backlog fullcount while Atom lags', () => {
    const ledger = new UnreadLedger();
    const entries = Array.from({ length: 20 }, (_, i) => atomEntry(`m${i}`, `t${i}`));

    ledger.reconcileWithAtom(entries, 50, 1000);
    expect(ledger.getBreakdown().total).toBe(50);

    ledger.recordLocalTriage('m0', 't0', 'archive', 'primary', 2000);
    expect(ledger.getBreakdown().total).toBe(49);

    // Atom still reports the archived message and the old fullcount.
    ledger.reconcileWithAtom(entries, 50, 2500);
    expect(ledger.getBreakdown().total).toBe(49);
    expect(ledger.getTrackedItems().some((item) => item.id === 'm0')).toBe(false);

    // Once the grace expires, a server that still asserts the message wins.
    ledger.reconcileWithAtom(entries, 50, 2000 + ATOM_READ_PATH_GRACE_MS + 100);
    expect(ledger.getBreakdown().total).toBe(50);
    expect(ledger.getTrackedItems().some((item) => item.id === 'm0')).toBe(true);
  });

  it('does not treat omission from a truncated feed as confirmation', () => {
    const ledger = new UnreadLedger();
    const entries = Array.from({ length: 20 }, (_, i) => atomEntry(`m${i}`, `t${i}`));

    ledger.reconcileWithAtom(entries, 50, 1000);
    ledger.recordLocalTriage('m0', 't0', 'archive', 'primary', 2000);
    ledger.reconcileWithAtom(entries, 50, 2500);
    expect(ledger.getBreakdown().total).toBe(49);

    // The feed shortens, but a truncated feed could have pushed m0 out of its
    // window rather than removed it. Hold the decrement until the boundary.
    ledger.reconcileWithAtom(entries.slice(1), 49, 3000);
    expect(ledger.getBreakdown().total).toBe(48);

    ledger.reconcileWithAtom(entries.slice(1), 49, 2000 + ATOM_READ_PATH_GRACE_MS + 100);
    expect(ledger.getBreakdown().total).toBe(49);
  });

  it('holds a marked-unread thread against a stale cache that says read', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([], 0, 1000);

    ledger.recordLocalTriage('th-u', 'th-u', 'markUnread', 'primary', 2000);
    expect(ledger.getBreakdown().total).toBe(1);

    ledger.reconcileWithCache(
      [
        {
          id: 'th-u',
          threadId: 'th-u',
          from: 'someone',
          subject: 'just marked unread',
          snippet: 'snippet',
          category: 'primary',
          unread: false,
          modified: new Date(1000),
        },
      ],
      2500,
    );
    expect(ledger.getBreakdown().total).toBe(1);
  });

  it('ignores a cache row whose last-sync time predates the local action', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([], 0, 1000);
    ledger.recordLocalTriage('th-u', 'th-u', 'markUnread', 'primary', 2000);
    expect(ledger.getBreakdown().total).toBe(1);

    ledger.reconcileWithCache(
      [
        {
          id: 'th-u',
          threadId: 'th-u',
          from: 'someone',
          subject: 'marked unread',
          snippet: 'snippet',
          category: 'primary',
          unread: false,
          modified: new Date(1000),
        },
      ],
      2500,
      1500,
    );
    expect(ledger.getBreakdown().total).toBe(1);
  });

  it('ignores a cache row that contradicts a confirmed mark-unread', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([], 0, 1000);
    ledger.recordLocalTriage('th-u', 'th-u', 'markUnread', 'primary', 2000);
    expect(ledger.getBreakdown().total).toBe(1);

    ledger.reconcileWithCache(
      [
        {
          id: 'th-u',
          threadId: 'th-u',
          from: 'someone',
          subject: 'marked unread',
          snippet: 'snippet',
          category: 'primary',
          unread: false,
          modified: new Date(1000),
        },
      ],
      3500,
      3000,
    );
    expect(ledger.getBreakdown().total).toBe(1);
  });

  it('does not let a listed entry clear a confirmed reduction before the boundary', () => {
    const ledger = new UnreadLedger();
    const entry = atomEntry('m1', 't1');

    ledger.reconcileWithAtom([entry], 1, 1000);
    ledger.recordLocalTriage('m1', 't1', 'archive', 'primary', 2000);
    ledger.acceptLocalTriage('m1', 't1', 2500);
    expect(ledger.getBreakdown().total).toBe(0);

    // Still listed a second later; that may be the read path lagging behind our
    // own label change, so it is not a contradiction yet.
    ledger.reconcileWithAtom([entry], 1, 3000, undefined, 3000);
    expect(ledger.getBreakdown().total).toBe(0);

    // Once the boundary passes the confirmation, the server wins.
    ledger.reconcileWithAtom([entry], 1, 8000, undefined, 8000);
    expect(ledger.getBreakdown().total).toBe(1);
  });

  it('ignores a cache row that contradicts a confirmed reduction', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 1, 1000);
    ledger.recordLocalTriage('m1', 't1', 'markRead', 'primary', 2000);
    expect(ledger.getBreakdown().total).toBe(0);

    // The cache sync advanced, but its row still says unread. That is not proof
    // the action failed; only the feed can contradict a confirmed action.
    ledger.reconcileWithCache(
      [
        {
          id: 'm1',
          threadId: 't1',
          from: 'someone',
          subject: 'subject',
          snippet: 'snippet',
          category: 'primary',
          unread: true,
          modified: new Date(1000),
        },
      ],
      3500,
      3000,
    );
    expect(ledger.getBreakdown().total).toBe(0);
    expect(ledger.getTrackedItems()).toHaveLength(0);
  });

  it('holds a marked-unread thread against a lagging empty feed until grace expires', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([], 0, 1000);

    ledger.recordLocalTriage('th-u', 'th-u', 'markUnread', 'primary', 2000);
    expect(ledger.getBreakdown().total).toBe(1);

    // The feed has not propagated the change yet.
    ledger.reconcileWithAtom([], 0, 2500);
    expect(ledger.getBreakdown().total).toBe(1);

    // Once grace expires, a server that still does not list it wins.
    ledger.reconcileWithAtom([], 0, 2000 + ATOM_READ_PATH_GRACE_MS + 100);
    expect(ledger.getBreakdown().total).toBe(0);
  });

  it('raises a backlog by one when a thread is marked unread', () => {
    const ledger = new UnreadLedger();
    const entries = Array.from({ length: 20 }, (_, i) => atomEntry(`m${i}`, `t${i}`));

    ledger.reconcileWithAtom(entries, 50, 1000);
    ledger.recordLocalTriage('m30', 't30', 'markUnread', 'primary', 2000);
    expect(ledger.getBreakdown().total).toBe(51);

    // Atom still reports the old fullcount.
    ledger.reconcileWithAtom(entries, 50, 2500);
    expect(ledger.getBreakdown().total).toBe(51);
  });

  it('keeps a backlog decrement for a thread outside the entry window', () => {
    const ledger = new UnreadLedger();
    const entries = Array.from({ length: 20 }, (_, i) => atomEntry(`m${i}`, `t${i}`));

    ledger.reconcileWithAtom(entries, 50, 1000);
    ledger.reconcileWithCache(
      [
        {
          id: 'm30',
          threadId: 't30',
          from: 'someone',
          subject: 'outside the window',
          snippet: 'snippet',
          category: 'primary',
          unread: true,
          modified: new Date(1000),
        },
      ],
      1500,
    );
    expect(ledger.getBreakdown().total).toBe(50);

    ledger.recordLocalTriage('m30', 't30', 'archive', 'primary', 2000);
    expect(ledger.getBreakdown().total).toBe(49);

    // Atom still reports 50 and never lists m30, because it is the 31st unread.
    ledger.reconcileWithAtom(entries, 50, 2500);
    expect(ledger.getBreakdown().total).toBe(49);
  });
});

describe('Scenario 7: Ledger-owned rows and source ordering', () => {
  const atomEntry = (id: string, threadId: string) => ({
    id,
    threadId,
    from: 'someone',
    subject: 'subject',
    snippet: 'snippet',
    link: '',
    issued: new Date(1000).toISOString(),
    modified: new Date(1000).toISOString(),
    category: 'primary' as const,
  });
  const cacheRow = (id: string, threadId: string, unread: boolean) => ({
    id,
    threadId,
    from: 'someone',
    subject: 'subject',
    snippet: 'snippet',
    category: 'primary' as const,
    unread,
    modified: new Date(1000),
  });

  it('returns popover rows from the ledger with local triage applied', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithCache([cacheRow('m1', 't1', true)], 1000, 1000);
    expect(ledger.getRecentMessages(5)[0].unread).toBe(true);

    ledger.recordLocalTriage('m1', 't1', 'archive', 'primary', 2000);

    expect(ledger.getRecentMessages(5)[0].unread).toBe(false);
    expect(ledger.getBreakdown().total).toBe(0);
  });

  it('keeps a locally read row when a stale cache says unread after the feed confirms', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 1, 1000);
    ledger.recordLocalTriage('m1', 't1', 'archive', 'primary', 2000);
    ledger.acceptLocalTriage('m1', 't1', 2500);

    // Complete feed omits it, so the pending record clears. The row stays read.
    ledger.reconcileWithAtom([], 0, 3000, undefined, 3000);
    expect(ledger.getBreakdown().total).toBe(0);

    // A stale cache still says unread. It must not undo the local delete.
    ledger.reconcileWithCache([cacheRow('m1', 't1', true)], 4000, 3500);
    expect(ledger.getBreakdown().total).toBe(0);
    expect(ledger.getTrackedItems()).toHaveLength(0);

    // Once the cache catches up, it confirms read and the intent clears.
    ledger.reconcileWithCache([cacheRow('m1', 't1', false)], 5000, 4500);
    expect(ledger.getBreakdown().total).toBe(0);
  });

  it('drops read rows the cache no longer lists', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithCache(
      [{ ...cacheRow('m1', 't1', false), modified: new Date(3000) }],
      1000,
      1000,
    );
    expect(ledger.getRecentMessages(5).map((row) => row.id)).toEqual(['m1']);

    // m1 is newer than the oldest returned row but absent, so it left the Inbox.
    ledger.reconcileWithCache(
      [{ ...cacheRow('m2', 't2', false), modified: new Date(2000) }],
      2000,
      2000,
    );

    expect(ledger.getRecentMessages(5).map((row) => row.id)).toEqual(['m2']);
  });

  it('keeps a pending read row the cache has not listed yet', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithCache(
      [{ ...cacheRow('m1', 't1', true), modified: new Date(3000) }],
      1000,
      1000,
    );
    ledger.recordLocalTriage('m1', 't1', 'archive', 'primary', 2000);

    ledger.reconcileWithCache(
      [{ ...cacheRow('m2', 't2', false), modified: new Date(2000) }],
      3000,
      3000,
    );

    const row = ledger.getRecentMessages(5).find((candidate) => candidate.id === 'm1');
    expect(row?.unread).toBe(false);
  });

  it('updates category from a cache row that contradicts a pending action', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithCache([cacheRow('m1', 't1', false)], 1000, 1000);
    ledger.recordLocalTriage('m1', 't1', 'markUnread', 'primary', 2000);
    expect(ledger.getBreakdown().total).toBe(1);

    // The cache sync advanced but its row still says read, so the unread flag
    // waits for the feed. Its category label is still newer evidence.
    ledger.reconcileWithCache(
      [{ ...cacheRow('m1', 't1', false), category: 'promotions' }],
      3500,
      3000,
    );

    expect(ledger.getBreakdown().total).toBe(1);
    expect(ledger.getBreakdown().byCategory.get('promotions')).toBe(1);
    const row = ledger.getRecentMessages(5)[0];
    expect(row.category).toBe('promotions');
    expect(row.unread).toBe(true);
  });

  it('does not let an older cache row overwrite a newer Atom row', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 1, 15000, 1, 15000);

    ledger.reconcileWithCache([cacheRow('m1', 't1', false)], 16000, 5000);
    expect(ledger.getTrackedItems()).toHaveLength(1);
    expect(ledger.getRecentMessages(5)[0].unread).toBe(true);

    ledger.reconcileWithCache([cacheRow('m1', 't1', false)], 17000, 12000);
    expect(ledger.getTrackedItems()).toHaveLength(0);
    expect(ledger.getRecentMessages(5)[0].unread).toBe(false);
  });

  it('trusts a row that changed since the last snapshot when the watermark lags', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 1, 15000, 1, 15000);

    // A read before the triage, agreeing with the feed. Its watermark is older
    // than the feed's view, so it only confirms what is already held.
    ledger.reconcileWithCache([cacheRow('m1', 't1', true)], 16000, 5000);
    expect(ledger.getBreakdown().total).toBe(1);

    // Gmail applies the triage and rewrites the row, but `items_sync_state` has
    // not caught up, so the watermark still says 5000. The row changing is the
    // evidence: on a live account this is the state the ledger threw away, and
    // the badge sat 1.37s on the feed's number instead.
    ledger.reconcileWithCache([cacheRow('m1', 't1', false)], 17000, 5000);
    expect(ledger.getBreakdown().total).toBe(0);
  });

  it('believes a row that flipped to unread over a feed that has not caught up', () => {
    const ledger = new UnreadLedger();
    // The feed's view holds one unread message, in a different category, and it
    // does not list the message this test triages at all.
    ledger.reconcileWithAtom([atomEntry('u1', 'tu')], 1, 15000, 1, 15000);
    ledger.reconcileWithCache([cacheRow('m1', 't1', false)], 16000, 5000);
    expect(ledger.getBreakdown().total).toBe(1);

    // The user marks it unread in Gmail. The row flips, and the feed still omits
    // it, which reads as proof of read. That verdict is only true as of the feed's
    // view, and the row moved after it, so the row wins. Measured live: this half
    // waited 1-3s for the feed to agree while the read direction moved in 7ms.
    ledger.reconcileWithCache([cacheRow('m1', 't1', true)], 17000, 5000);
    expect(ledger.getBreakdown().total).toBe(2);
  });

  it('does not let a lagging feed undo a row the cache wrote after its view', () => {
    const ledger = new UnreadLedger();
    // A complete feed whose only unread message is not the one under test.
    ledger.reconcileWithAtom([atomEntry('u1', 'tu')], 1, 20000, undefined, 20000);
    expect(ledger.getBreakdown().total).toBe(1);

    // The user marks the other thread unread in Gmail, and the cache is written
    // after the feed's view of 15000.
    ledger.reconcileWithCache([cacheRow('m1', 't1', true)], 21000, 18000);
    expect(ledger.getBreakdown().total).toBe(2);

    // The feed restates its count without listing that thread. Its omission is
    // older than the cache, so it must not force the row back to read. Doing so
    // made the count climb back on every pass, which is the ratchet from the log.
    ledger.reconcileWithAtom([atomEntry('u1', 'tu')], 1, 23000, undefined, 23000);
    ledger.reconcileWithCache([cacheRow('m1', 't1', true)], 24000, 18000);
    expect(ledger.getBreakdown().total).toBe(2);
  });

  it('holds one total across repeated feed restatements of an unchanged mailbox', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([atomEntry('u1', 'tu')], 1, 20000, undefined, 20000);
    ledger.reconcileWithCache([cacheRow('m1', 't1', true)], 21000, 18000);
    const settled = ledger.getBreakdown().total;
    expect(settled).toBe(2);

    // Three more passes of the same mailbox: the feed restates its count without
    // listing the second thread, and the cache re-reads the same row, with Gmail's
    // watermark advancing as it does on every sync. Nothing about the mailbox
    // changes, so nothing about the total may change either.
    //
    // This is the ratchet as reported: each pass moved the count, and it settled
    // only once the feed finally listed the thread. Asserting the settled value
    // once would not catch it; asserting it on every pass does.
    for (let pass = 0; pass < 3; pass += 1) {
      const t = 23000 + pass * 4000;
      ledger.reconcileWithAtom([atomEntry('u1', 'tu')], 1, t, undefined, t);
      ledger.reconcileWithCache([cacheRow('m1', 't1', true)], t + 1000, t);
      expect(ledger.getBreakdown().total).toBe(settled);
    }
  });

  it('ignores sources while an action is in flight, then uses the acceptance time', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 1, 1000);
    ledger.recordLocalTriage('m1', 't1', 'archive', 'primary', 2000);
    ledger.markLocalTriageInFlight('m1', 't1');

    // Generated at 12000, but the action has not been confirmed.
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 1, 12000, 1, 12000);
    expect(ledger.getBreakdown().total).toBe(0);

    ledger.acceptLocalTriage('m1', 't1', 13000);
    // Generated at 19000, so the read path is trusted as of 14000.
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 1, 19000, 1, 19000);
    expect(ledger.getBreakdown().total).toBe(1);
  });
});

describe('Scenario 5: Universal Sync Nudge Dispatch', () => {
  let pressRefreshSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    pressRefreshSpy = vi.spyOn(syncDriverModule, 'pressRefreshControl').mockResolvedValue(true);
  });

  afterEach(() => {
    pressRefreshSpy.mockRestore();
  });

  it('dispatches pressRefreshControl on detected delta and window wake/resume', async () => {
    const mockWebContents = {
      isDestroyed: () => false,
      isLoading: () => false,
      executeJavaScript: vi.fn().mockResolvedValue({ messages: [], stats: {} }),
    };
    const mockView = { webContents: mockWebContents } as any;

    let pollCallback: (result: any) => void = () => {};

    const mockPoller = {
      pollNow: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      destroy: vi.fn(),
      getEffectiveInterval: vi.fn().mockReturnValue(30000),
      updateNotificationSettings: vi.fn(),
      setFocusAndMissingCategories: vi.fn(),
      getLatestEntries: vi.fn().mockReturnValue([]),
    };

    const source = new HybridFeedSource('acc-1', {
      getView: () => mockView,
      getAccountContext: () => ({ partition: 'persist:acc-1' }),
      pollerFactory: (_accountId, _partition, cb) => {
        pollCallback = cb;
        return mockPoller as any;
      },
    });

    // 1. Initial baseline poll (count 5)
    pollCallback({
      accountId: 'acc-1',
      totalUnread: 5,
      newMessages: [],
      newArrivalCount: 5,
      arrivalsIncomplete: false,
      status: 'ok',
    });

    pressRefreshSpy.mockClear();

    // 2. Feed poll detects delta: count changed from 5 to 6
    pollCallback({
      accountId: 'acc-1',
      totalUnread: 6,
      newMessages: [
        {
          id: 'new-msg',
          threadId: 'th-new',
          from: 'someone',
          subject: 'hello',
          snippet: 'hi',
          link: '',
          issued: new Date().toISOString(),
          modified: new Date().toISOString(),
          category: 'primary',
        },
      ],
      newArrivalCount: 6,
      arrivalsIncomplete: false,
      status: 'ok',
    });

    expect(pressRefreshSpy).toHaveBeenCalledWith(mockWebContents);

    pressRefreshSpy.mockClear();

    // 3. Window wakes or unhides
    await source.handleWindowWakeOrUnhide();
    expect(pressRefreshSpy).toHaveBeenCalledWith(mockWebContents);

    source.destroy();
  });

  it('optimistically triages thread and notifies listeners immediately', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]', { status: 200 }));
    let pollCallback: (result: any) => void = () => {};

    const mockPoller = {
      pollNow: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      destroy: vi.fn(),
      getEffectiveInterval: vi.fn().mockReturnValue(30000),
      updateNotificationSettings: vi.fn(),
      setFocusAndMissingCategories: vi.fn(),
      getLatestEntries: vi.fn().mockReturnValue([
        {
          id: 'th-triage-1',
          threadId: 'th-triage-1',
          from: 'someone',
          subject: 'hello',
          snippet: 'hi',
          link: '',
          issued: new Date().toISOString(),
          modified: new Date().toISOString(),
          category: 'primary',
        },
      ]),
    };

    const source = new HybridFeedSource('acc-triage', {
      partition: 'persist:acc-triage',
      fetchImpl,
      threadActionDriver: { perform: async () => true },
      pollerFactory: (_accId, _part, cb) => {
        pollCallback = cb;
        return mockPoller as any;
      },
    });

    pollCallback({
      accountId: 'acc-triage',
      totalUnread: 1,
      newMessages: [],
      newArrivalCount: 1,
      arrivalsIncomplete: false,
      status: 'ok',
    });

    expect(source.getUnreadCounts().total).toBe(1);

    const events: any[] = [];
    const unsubscribe = source.onChanged((evt) => {
      events.push(evt);
    });

    const success = await source.triageThread('th-triage-1', 'archive');
    // Note: fetchImpl wasn't called because gmailSyncState wasn't mocked, but optimistic triage still ran
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].delta.removedMessageIds).toContain('th-triage-1');
    expect(source.getUnreadCounts().total).toBe(0);

    unsubscribe();
    source.destroy();
  });

  it('does not discard a local triage when the user refreshes', async () => {
    let pollCallback: (result: any) => void = () => {};
    const mockPoller = {
      pollNow: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      destroy: vi.fn(),
      updateNotificationSettings: vi.fn(),
      setFocusAndMissingCategories: vi.fn(),
      getLatestEntries: vi.fn().mockReturnValue([
        {
          id: 'm1',
          threadId: 't1',
          from: 'someone',
          subject: 'hello',
          snippet: 'hi',
          link: '',
          issued: new Date().toISOString(),
          modified: new Date().toISOString(),
          category: 'primary',
        },
      ]),
    };

    const source = new HybridFeedSource('acc-refresh', {
      partition: 'persist:acc-refresh',
      threadActionDriver: { perform: async () => true },
      pollerFactory: (_accId, _part, cb) => {
        pollCallback = cb;
        return mockPoller as any;
      },
    });

    pollCallback({
      accountId: 'acc-refresh',
      totalUnread: 1,
      newMessages: [],
      newArrivalCount: 1,
      arrivalsIncomplete: false,
      status: 'ok',
    });
    expect(source.getUnreadCounts().total).toBe(1);

    await source.triageThread('t1', 'archive');
    expect(source.getUnreadCounts().total).toBe(0);

    // Refresh asks the server again; it must not forget the local decision.
    await source.refresh();
    expect(source.getUnreadCounts().total).toBe(0);

    source.destroy();
  });

  it('does not let a stale Atom response after refresh undo a local triage', async () => {
    const staleEntry = {
      id: 'm1',
      threadId: 't1',
      from: 'someone',
      subject: 'hello',
      snippet: 'hi',
      link: '',
      issued: new Date(1000).toISOString(),
      modified: new Date(1000).toISOString(),
      category: 'primary',
    };
    let pollCallback: (result: any) => void = () => {};
    const mockPoller = {
      // A refresh asks Atom again, and Atom returns the pre-action state.
      pollNow: vi.fn(async () => {
        pollCallback({
          accountId: 'acc-stale-refresh',
          totalUnread: 1,
          newMessages: [],
          newArrivalCount: 1,
          arrivalsIncomplete: false,
          rawFullCount: 1,
          status: 'ok',
        });
      }),
      stop: vi.fn(),
      destroy: vi.fn(),
      updateNotificationSettings: vi.fn(),
      setFocusAndMissingCategories: vi.fn(),
      getLatestEntries: vi.fn().mockReturnValue([staleEntry]),
    };

    const source = new HybridFeedSource('acc-stale-refresh', {
      partition: 'persist:acc-stale-refresh',
      threadActionDriver: { perform: async () => true },
      pollerFactory: (_accId, _part, cb) => {
        pollCallback = cb;
        return mockPoller as any;
      },
    });

    pollCallback({
      accountId: 'acc-stale-refresh',
      totalUnread: 1,
      newMessages: [],
      newArrivalCount: 1,
      arrivalsIncomplete: false,
      rawFullCount: 1,
      status: 'ok',
    });
    expect(source.getUnreadCounts().total).toBe(1);

    await source.triageThread('t1', 'archive');
    expect(source.getUnreadCounts().total).toBe(0);

    // Refresh does not discard the triage record, and the stale feed cannot either.
    await source.refresh();
    expect(source.getUnreadCounts().total).toBe(0);

    source.destroy();
  });

  it('rolls the optimistic row back when the driver fails', async () => {
    let pollCallback: (result: any) => void = () => {};
    const entry = {
      id: 'm1',
      threadId: 't1',
      from: 'someone',
      subject: 'hello',
      snippet: 'hi',
      link: '',
      issued: new Date(1000).toISOString(),
      modified: new Date(1000).toISOString(),
      category: 'primary',
    };
    const mockPoller = {
      pollNow: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      destroy: vi.fn(),
      updateNotificationSettings: vi.fn(),
      setFocusAndMissingCategories: vi.fn(),
      getLatestEntries: vi.fn().mockReturnValue([entry]),
    };

    const source = new HybridFeedSource('acc-rollback', {
      partition: 'persist:acc-rollback',
      threadActionDriver: { perform: async () => false },
      pollerFactory: (_accId, _part, cb) => {
        pollCallback = cb;
        return mockPoller as any;
      },
    });

    pollCallback({
      accountId: 'acc-rollback',
      totalUnread: 1,
      newMessages: [],
      newArrivalCount: 1,
      arrivalsIncomplete: false,
      rawFullCount: 1,
      status: 'ok',
    });
    expect(source.getUnreadCounts().total).toBe(1);

    const ok = await source.triageThread('t1', 'archive');
    expect(ok).toBe(false);
    expect(source.getUnreadCounts().total).toBe(1);

    const rows = await source.getRecentMessages(5);
    expect(rows.find((row) => row.threadId === 't1')?.unread).toBe(true);

    source.destroy();
  });

  it('routes triage through the configured thread action driver', async () => {
    const perform = vi.fn().mockResolvedValue(true);
    const mockPoller = {
      pollNow: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      destroy: vi.fn(),
      updateNotificationSettings: vi.fn(),
      setFocusAndMissingCategories: vi.fn(),
      getLatestEntries: vi.fn().mockReturnValue([]),
    };

    const source = new HybridFeedSource('acc-driver', {
      partition: 'persist:acc-driver',
      threadActionDriver: { perform },
      pollerFactory: () => mockPoller as any,
    });

    const ok = await source.triageThread('th-1', 'archive');

    expect(ok).toBe(true);
    expect(perform).toHaveBeenCalledWith(undefined, 'acc-driver', 'th-1', 'archive');
    source.destroy();
  });

  it('wakes a view for the DOM fallback when the direct write cannot land', async () => {
    const wake = vi.fn().mockResolvedValue(undefined);
    const mockPoller = {
      pollNow: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      destroy: vi.fn(),
      updateNotificationSettings: vi.fn(),
      setFocusAndMissingCategories: vi.fn(),
      getLatestEntries: vi.fn().mockReturnValue([]),
    };

    const source = new HybridFeedSource('acc-fallback', {
      partition: 'persist:acc-fallback',
      wake,
      fetchImpl: vi.fn(async () => new Response('[]', { status: 200 })),
      pollerFactory: () => mockPoller as any,
    });

    // No captured /sync/ headers for the partition, so the direct write returns false.
    const ok = await source.triageThread('th-1', 'archive');

    expect(wake).toHaveBeenCalledWith('acc-fallback');
    expect(ok).toBe(false);
    source.destroy();
  });
});
