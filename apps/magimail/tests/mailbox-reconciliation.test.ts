import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnreadLedger, ATOM_READ_PATH_GRACE_MS } from '../src/mailbox/unread-ledger.js';
import type { AtomMessage, MailboxChangeEvent, TrayMessageItem } from '../src/mailbox/types.js';
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
      // Two numbers, asked for separately: the menu bar shows everything the
      // mailbox holds, the badge counts only the categories not silenced. The
      // source reports facts; the caller decides which categories it wants.
      expect(breakdown1.total).toBe(2);
      expect(ledger.getUnreadCountFor(new Set(['primary', 'updates', 'social', 'forums']))).toBe(1);

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
    // Both messages are unread; only the primary is in a counted category.
    ledger.reconcileWithAtom([primary, promo], 2, 1000, 1);
    const withoutPromotions = new Set(['primary', 'updates', 'social', 'forums'] as const);
    expect(ledger.getBreakdown().total).toBe(2);
    expect(ledger.getUnreadCountFor(withoutPromotions)).toBe(1);

    // Archiving the silenced promotion lowers what is unread but must not touch
    // the badge, which never counted it in the first place.
    ledger.recordLocalTriage('m2', 't2', 'archive', 'promotions', 2000);

    expect(ledger.getBreakdown().total).toBe(1);
    expect(ledger.getUnreadCountFor(withoutPromotions)).toBe(1);
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

  it('does not let a lagging feed undo a row the cache has just rewritten', () => {
    const ledger = new UnreadLedger();
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 1, 20000, undefined, 20000);
    expect(ledger.getBreakdown().total).toBe(1);

    // A read before the triage, agreeing with the feed, so the flip below is seen
    // as a change rather than as the first sight of this row.
    ledger.reconcileWithCache([cacheRow('m1', 't1', true)], 20500, 16000);
    expect(ledger.getBreakdown().total).toBe(1);

    // The user reads it. The watermark does not advance with the row.
    ledger.reconcileWithCache([cacheRow('m1', 't1', false)], 21000, 16000);
    expect(ledger.getBreakdown().total).toBe(0);

    // The poll 200ms later still lists the thread as unread, because the feed has
    // not caught up. Measured live: the badge went 3, back to 4, then to 3 again,
    // a visible bounce on every read whose cache write landed before the feed's
    // view of it.
    ledger.reconcileWithAtom([atomEntry('m1', 't1')], 1, 21200, undefined, 21200);
    expect(ledger.getBreakdown().total).toBe(0);
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

  it('emits change when getRecentMessages reconciles cache and moves unread count', async () => {
    let changedEvent: any = null;
    const mockWebContents = {
      isDestroyed: () => false,
      isLoading: () => false,
      executeJavaScript: vi.fn().mockResolvedValue({
        messages: [
          {
            id: 'm1',
            threadId: 't1',
            unread: false,
            category: 'promotions',
            modified: new Date(1000).toISOString(),
          },
        ],
        categoryCounts: {},
      }),
    };
    const mockView = { webContents: mockWebContents } as any;

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
          from: 'Promo',
          subject: 'Offer',
          category: 'promotions',
          modified: new Date(1000).toISOString(),
        },
      ]),
    };

    const source = new HybridFeedSource('acc-cache-emit', {
      getView: () => mockView,
      pollerFactory: (_accId, _part, cb) => {
        pollCallback = cb;
        return mockPoller as any;
      },
    });

    source.onChanged((event) => {
      changedEvent = event;
    });

    // 1. Initial poll establishes 1 unread message
    pollCallback({
      accountId: 'acc-cache-emit',
      totalUnread: 1,
      newMessages: [],
      newArrivalCount: 1,
      arrivalsIncomplete: false,
      rawFullCount: 1,
      status: 'ok',
    });
    expect(source.getUnreadCounts().total).toBe(1);
    expect(changedEvent?.unread.total).toBe(1);

    changedEvent = null;

    // 2. getRecentMessages reads cache where m1 is read (total moves 1 -> 0)
    const messages = await source.getRecentMessages(5);
    expect(messages.length).toBe(1);
    expect(messages[0].unread).toBe(false);
    expect(source.getUnreadCounts().total).toBe(0);

    // HybridFeedSource must manage its own change event when getRecentMessages moves count
    expect(changedEvent).not.toBeNull();
    expect(changedEvent.unread.total).toBe(0);

    source.destroy();
  });

  it('emits initial change event on first poll establishing state even with 0 unread', async () => {
    let changedEvent: any = null;
    let pollCallback: (result: any) => void = () => {};
    const mockPoller = {
      pollNow: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      destroy: vi.fn(),
      updateNotificationSettings: vi.fn(),
      setFocusAndMissingCategories: vi.fn(),
      getLatestEntries: vi.fn().mockReturnValue([]),
    };

    const source = new HybridFeedSource('acc-zero-poll', {
      pollerFactory: (_accId, _part, cb) => {
        pollCallback = cb;
        return mockPoller as any;
      },
    });

    source.onChanged((event) => {
      changedEvent = event;
    });

    // Initial poll with 0 unread
    pollCallback({
      accountId: 'acc-zero-poll',
      totalUnread: 0,
      newMessages: [],
      newArrivalCount: 0,
      arrivalsIncomplete: false,
      rawFullCount: 0,
      status: 'ok',
    });

    expect(source.getUnreadCounts().total).toBe(0);
    expect(changedEvent).not.toBeNull();
    expect(changedEvent.unread.total).toBe(0);

    source.destroy();
  });
});

describe('Local and Remote Read State Changes under Edge-Cache Lag (Primary & Promotions)', () => {
  let pressRefreshSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    pressRefreshSpy = vi.spyOn(syncDriverModule, 'pressRefreshControl').mockResolvedValue(true);
  });

  afterEach(() => {
    pressRefreshSpy.mockRestore();
  });

  function createHarness(
    accountId: string,
    options: {
      threadDriverPerform?: (
        webContents: any,
        accountId: string,
        threadId: string,
        action: any,
      ) => Promise<boolean>;
      notificationSettings?: Record<string, string>;
    } = {},
  ) {
    let currentCachePayload: {
      messages: any[];
      categoryCounts: Record<string, number>;
      stats?: { scanned?: number; inbox?: number };
      cacheUpdatedAt?: number;
    } = {
      messages: [],
      categoryCounts: {},
      stats: { scanned: 0, inbox: 0 },
    };
    let currentPollerEntries: AtomMessage[] = [];
    let currentFullCount = 0;
    let pollCallback: (result: any) => void = () => {};

    const mockWebContents = {
      isDestroyed: () => false,
      isLoading: () => false,
      executeJavaScript: vi.fn(async () => currentCachePayload),
    };
    const mockView = { webContents: mockWebContents } as any;

    const mockPoller = {
      pollNow: vi.fn(async () => {
        pollCallback({
          accountId,
          totalUnread: currentFullCount,
          newMessages: currentPollerEntries,
          newArrivalCount: currentFullCount,
          rawFullCount: currentFullCount,
          arrivalsIncomplete: currentFullCount > 20,
          status: 'ok',
        });
      }),
      stop: vi.fn(),
      destroy: vi.fn(),
      updateNotificationSettings: vi.fn(),
      setFocusAndMissingCategories: vi.fn(),
      getLatestEntries: vi.fn(() => currentPollerEntries),
      getLastFullCount: vi.fn(() => currentFullCount),
    };

    const source = new HybridFeedSource(accountId, {
      partition: `persist:${accountId}`,
      notificationSettings: options.notificationSettings,
      getView: () => mockView,
      threadActionDriver: {
        perform: options.threadDriverPerform ?? (async () => true),
      },
      pollerFactory: (_accId, _part, cb) => {
        pollCallback = cb;
        return mockPoller as any;
      },
    });

    const events: MailboxChangeEvent[] = [];
    const unsubscribe = source.onChanged((evt) => {
      events.push(evt);
    });

    const triggerPoll = (
      entries?: AtomMessage[],
      fullCount?: number,
      sourceAsOf?: number,
      categoryCounts?: Map<NotificationCategory, number>,
      arrivalsIncomplete?: boolean,
    ) => {
      if (entries !== undefined) currentPollerEntries = entries;
      if (fullCount !== undefined) currentFullCount = fullCount;
      pollCallback({
        accountId,
        totalUnread: currentFullCount,
        newMessages: currentPollerEntries,
        newArrivalCount: currentFullCount,
        rawFullCount: currentFullCount,
        arrivalsIncomplete:
          arrivalsIncomplete !== undefined ? arrivalsIncomplete : currentFullCount > 20,
        sourceAsOf,
        categoryCounts,
        status: 'ok',
      });
    };

    const setCache = (
      messages: any[],
      categoryCounts: Record<string, number> = {},
      cacheUpdatedAt: number = Date.now(),
    ) => {
      currentCachePayload = {
        messages,
        categoryCounts,
        stats: { scanned: messages.length, inbox: messages.length },
        cacheUpdatedAt,
      };
    };

    return {
      source,
      events,
      triggerPoll,
      setCache,
      setPollerState: (entries: AtomMessage[], fullCount: number) => {
        currentPollerEntries = entries;
        currentFullCount = fullCount;
      },
      cleanup: () => {
        unsubscribe();
        source.destroy();
      },
    };
  }

  const primaryMsg = (id = 'p-1', threadId = 'th-p-1', unread = true): AtomMessage => ({
    id,
    threadId,
    from: 'Alice <alice@example.com>',
    subject: 'Primary Subject',
    snippet: 'Primary snippet',
    link: `https://mail.google.com/mail/u/0/#inbox/${threadId}`,
    issued: new Date().toISOString(),
    modified: new Date().toISOString(),
    category: 'primary',
  });

  const promoMsg = (id = 'pr-1', threadId = 'th-pr-1', unread = true): AtomMessage => ({
    id,
    threadId,
    from: 'Store <store@example.com>',
    subject: 'Promo Offer',
    snippet: 'Promo snippet',
    link: `https://mail.google.com/mail/u/0/#inbox/${threadId}`,
    issued: new Date().toISOString(),
    modified: new Date().toISOString(),
    category: 'promotions',
  });

  const cacheRow = (
    id: string,
    threadId: string,
    category: 'primary' | 'promotions',
    unread: boolean,
    timestampMs = Date.now(),
  ) => ({
    id,
    threadId,
    from: category === 'primary' ? 'Alice <alice@example.com>' : 'Store <store@example.com>',
    subject: category === 'primary' ? 'Primary Subject' : 'Promo Offer',
    snippet: 'Snippet...',
    timestampMs,
    category,
    unread,
  });

  const createCategoryAtomMsg = (
    id: string,
    category: NotificationCategory = 'primary',
    subject = `${category} Subject`,
    threadId = `th-${id}`,
    modified: Date = new Date(),
    snippet = `${category} Snippet`,
  ): AtomMessage => ({
    id,
    threadId,
    from: `${category} Sender <sender@example.com>`,
    subject,
    snippet,
    link: `https://mail.google.com/mail/u/0/#inbox/${threadId}`,
    issued: modified.toISOString(),
    modified: modified.toISOString(),
    category,
  });

  const createCategoryCacheRow = (
    id: string,
    category: NotificationCategory = 'primary',
    unread = true,
    subject = `${category} Subject`,
    threadId = `th-${id}`,
    timestampMs = Date.now(),
    snippet = `${category} Snippet`,
  ) => ({
    id,
    threadId,
    from: `${category} Sender <sender@example.com>`,
    subject,
    snippet,
    timestampMs,
    category,
    unread,
    modified: new Date(timestampMs),
  });

  const countedCategoriesSet = (settings: Record<string, string>): Set<NotificationCategory> => {
    const all: NotificationCategory[] = ['primary', 'updates', 'promotions', 'social', 'forums'];
    return new Set(all.filter((cat) => settings[cat] !== 'off'));
  };

  describe('Scenario 1: Local triage with edge server / cache lag (anti-bounce)', () => {
    it('Primary: local markRead and archive reflect immediately and resist lagging cache and Atom edge responses', async () => {
      const h = createHarness('acc-p1-local');
      const p1 = primaryMsg();

      // 1. Initial poll establishes 1 unread message in Primary
      h.setPollerState([p1], 1);
      h.setCache([cacheRow('p-1', 'th-p-1', 'primary', true)]);
      h.triggerPoll([p1], 1);
      await h.source.getRecentMessages(5);

      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      h.events.length = 0;

      // 2. Local markRead: immediate count update (0ms UI latency)
      const ok = await h.source.triageThread('th-p-1', 'markRead');
      expect(ok).toBe(true);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(0);
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(0);
      expect(h.events[0].delta.removedMessageIds).toContain('th-p-1');
      h.events.length = 0;

      // 3. Stale cache read: subsequent getRecentMessages reads lagging cache returning unread: true
      const recent = await h.source.getRecentMessages(5);
      const row = recent.find((m) => m.id === 'p-1' || m.threadId === 'th-p-1');
      expect(row?.unread).toBe(false);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(0);
      // Anti-bounce: stale cache read must NOT bounce count or emit event
      expect(h.events.length).toBe(0);

      // 4. Lagging Atom poll within grace window (< ATOM_READ_PATH_GRACE_MS):
      // Edge server still returns p1 and fullCount = 1
      h.triggerPoll([p1], 1);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(0);
      expect(h.events.length).toBe(0);

      // 5. Subsequent getRecentMessages calls continue to suppress resurrection
      const recent2 = await h.source.getRecentMessages(5);
      expect(recent2.find((m) => m.id === 'p-1')?.unread).toBe(false);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.events.length).toBe(0);

      // 6. Clean poll after edge catch-up: fullCount = 0, entries = []
      h.triggerPoll([], 0);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.events.length).toBe(0);

      h.cleanup();
    });

    it('Primary: local archive reflects immediately and suppresses resurrection under lagging cache and Atom edge responses', async () => {
      const h = createHarness('acc-p1-archive');
      const p1 = primaryMsg();

      h.setPollerState([p1], 1);
      h.setCache([cacheRow('p-1', 'th-p-1', 'primary', true)]);
      h.triggerPoll([p1], 1);
      await h.source.getRecentMessages(5);
      expect(h.source.getUnreadCounts().total).toBe(1);
      h.events.length = 0;

      // User archives locally
      await h.source.triageThread('th-p-1', 'archive');
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(0);
      expect(h.events.length).toBe(1);
      h.events.length = 0;

      // Stale cache read
      await h.source.getRecentMessages(5);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.events.length).toBe(0);

      // Lagging Atom poll
      h.triggerPoll([p1], 1);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.events.length).toBe(0);

      h.cleanup();
    });

    it('Primary: local markUnread reflects immediately and resists lagging cache and Atom edge responses', async () => {
      const h = createHarness('acc-p1-unread');
      const p1 = primaryMsg('p-1', 'th-p-1', false);

      // Starts read (0 unread)
      h.setPollerState([], 0);
      h.setCache([cacheRow('p-1', 'th-p-1', 'primary', false)]);
      h.triggerPoll([], 0);
      await h.source.getRecentMessages(5);
      expect(h.source.getUnreadCounts().total).toBe(0);
      h.events.length = 0;

      // Local markUnread
      await h.source.triageThread('th-p-1', 'markUnread');
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(1);
      h.events.length = 0;

      // Lagging cache still says unread: false
      const recent = await h.source.getRecentMessages(5);
      expect(recent.find((m) => m.id === 'p-1' || m.threadId === 'th-p-1')?.unread).toBe(true);
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.events.length).toBe(0);

      // Lagging Atom poll still says fullCount: 0 and omits p1
      h.triggerPoll([], 0);
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      expect(h.events.length).toBe(0);

      h.cleanup();
    });

    it('Promotions: local markRead reflects immediately and resists lagging cache and Atom edge responses', async () => {
      const h = createHarness('acc-pr1-local');
      const pr1 = promoMsg();

      // 1. Initial poll establishes 1 unread message in Promotions
      h.setPollerState([pr1], 1);
      h.setCache([cacheRow('pr-1', 'th-pr-1', 'promotions', true)], { promotions: 1 });
      h.triggerPoll([pr1], 1);
      await h.source.getRecentMessages(5);

      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(0);
      h.events.length = 0;

      // 2. Local markRead: immediate count update (0ms UI latency)
      const ok = await h.source.triageThread('th-pr-1', 'markRead');
      expect(ok).toBe(true);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(0);
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(0);
      expect(h.events[0].unread.byCategory.get('promotions')).toBe(0);
      expect(h.events[0].delta.removedMessageIds).toContain('th-pr-1');
      h.events.length = 0;

      // 3. Stale cache read: subsequent getRecentMessages reads lagging cache returning unread: true
      const recent = await h.source.getRecentMessages(5);
      const row = recent.find((m) => m.id === 'pr-1' || m.threadId === 'th-pr-1');
      expect(row?.unread).toBe(false);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(0);
      expect(h.events.length).toBe(0);

      // 4. Lagging Atom poll within grace window (< ATOM_READ_PATH_GRACE_MS)
      h.triggerPoll([pr1], 1);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(0);
      expect(h.events.length).toBe(0);

      // 5. Subsequent getRecentMessages calls continue to suppress resurrection
      const recent2 = await h.source.getRecentMessages(5);
      expect(recent2.find((m) => m.id === 'pr-1')?.unread).toBe(false);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.events.length).toBe(0);

      h.cleanup();
    });

    it('Promotions: local archive reflects immediately and resists lagging cache and Atom edge responses', async () => {
      const h = createHarness('acc-pr1-archive');
      const pr1 = promoMsg();

      h.setPollerState([pr1], 1);
      h.setCache([cacheRow('pr-1', 'th-pr-1', 'promotions', true)], { promotions: 1 });
      h.triggerPoll([pr1], 1);
      await h.source.getRecentMessages(5);
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(1);
      h.events.length = 0;

      await h.source.triageThread('th-pr-1', 'archive');
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(0);
      expect(h.events.length).toBe(1);
      h.events.length = 0;

      // Stale cache read
      await h.source.getRecentMessages(5);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.events.length).toBe(0);

      // Lagging Atom poll
      h.triggerPoll([pr1], 1);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.events.length).toBe(0);

      h.cleanup();
    });

    it('Promotions: local markUnread reflects immediately and resists lagging cache and Atom edge responses', async () => {
      const h = createHarness('acc-pr1-unread');
      const pr1 = promoMsg('pr-1', 'th-pr-1', false);

      h.setPollerState([], 0);
      h.setCache([cacheRow('pr-1', 'th-pr-1', 'promotions', false)]);
      h.triggerPoll([], 0);
      await h.source.getRecentMessages(5);
      expect(h.source.getUnreadCounts().total).toBe(0);
      h.events.length = 0;

      await h.source.triageThread('th-pr-1', 'markUnread');
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(1);
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(1);
      h.events.length = 0;

      // Lagging cache says unread: false
      const recent = await h.source.getRecentMessages(5);
      expect(recent.find((m) => m.id === 'pr-1' || m.threadId === 'th-pr-1')?.unread).toBe(true);
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.events.length).toBe(0);

      // Lagging Atom poll omits pr1
      h.triggerPoll([], 0);
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(1);
      expect(h.events.length).toBe(0);

      h.cleanup();
    });

    it('Combined Primary & Promotions: interleaved local triage preserves category counts and anti-bounce protection', async () => {
      const h = createHarness('acc-both-local');
      const p1 = primaryMsg();
      const pr1 = promoMsg();

      // Initial: 1 in primary, 1 in promotions (total = 2)
      h.setPollerState([p1, pr1], 2);
      h.setCache(
        [
          cacheRow('p-1', 'th-p-1', 'primary', true),
          cacheRow('pr-1', 'th-pr-1', 'promotions', true),
        ],
        { primary: 1, promotions: 1 },
      );
      h.triggerPoll([p1, pr1], 2);
      await h.source.getRecentMessages(5);

      expect(h.source.getUnreadCounts().total).toBe(2);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(1);
      h.events.length = 0;

      // Triage Primary thread locally
      await h.source.triageThread('th-p-1', 'archive');
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(1);
      expect(h.events.length).toBe(1);
      h.events.length = 0;

      // Lagging cache + Atom poll for Primary
      await h.source.getRecentMessages(5);
      h.triggerPoll([p1, pr1], 2);
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(1);
      expect(h.events.length).toBe(0);

      // Triage Promotions thread locally
      await h.source.triageThread('th-pr-1', 'markRead');
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(0);
      expect(h.events.length).toBe(1);
      h.events.length = 0;

      // Lagging cache + Atom poll for Promotions
      await h.source.getRecentMessages(5);
      h.triggerPoll([p1, pr1], 2);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.events.length).toBe(0);

      h.cleanup();
    });
  });

  describe('Scenario 2: Remote read state changes via cache read (clean move & anti-oscillation)', () => {
    it('Primary: remote markRead discovered via getRecentMessages emits single change event and does not oscillate under lagging Atom responses', async () => {
      const h = createHarness('acc-p1-remote');
      const p1 = primaryMsg();

      // 1. Initial poll establishes 1 unread message in Primary, and initial cache read records baseline
      h.setPollerState([p1], 1);
      h.setCache([cacheRow('p-1', 'th-p-1', 'primary', true)]);
      h.triggerPoll([p1], 1);
      await h.source.getRecentMessages(5);
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      h.events.length = 0;

      // 2. Remote action: user marks p1 read on web/mobile
      // Local cache is updated with unread: false
      h.setCache([cacheRow('p-1', 'th-p-1', 'primary', false)], { primary: 0 });

      // 3. getRecentMessages reconciles cache and discovers the remote read flip
      const messages = await h.source.getRecentMessages(5);
      const row = messages.find((m) => m.id === 'p-1' || m.threadId === 'th-p-1');
      expect(row?.unread).toBe(false);

      // Count moves cleanly 1 -> 0
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(0);

      // Exactly ONE change event emitted
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(0);
      expect(h.events[0].unread.byCategory.get('primary')).toBe(0);
      h.events.length = 0;

      // 4. Subsequent lagging Atom response (still returning p1, fullCount = 1)
      h.triggerPoll([p1], 1);

      // Count must NOT oscillate back to 1!
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(0);
      expect(h.events.length).toBe(0);

      // 5. Subsequent getRecentMessages calls must NOT oscillate or re-emit
      const messages2 = await h.source.getRecentMessages(5);
      expect(messages2.find((m) => m.id === 'p-1' || m.threadId === 'th-p-1')?.unread).toBe(false);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.events.length).toBe(0);

      h.cleanup();
    });

    it('Promotions: remote markRead discovered via getRecentMessages emits single change event and does not oscillate under lagging Atom responses', async () => {
      const h = createHarness('acc-pr1-remote');
      const pr1 = promoMsg();

      // 1. Initial poll establishes 1 unread message in Promotions, and initial cache baseline is established
      h.setPollerState([pr1], 1);
      h.setCache([cacheRow('pr-1', 'th-pr-1', 'promotions', true)], { promotions: 1 });
      h.triggerPoll([pr1], 1);
      await h.source.getRecentMessages(5);
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(1);
      h.events.length = 0;

      // 2. Remote action: user marks pr1 read on web/mobile
      h.setCache([cacheRow('pr-1', 'th-pr-1', 'promotions', false)], { promotions: 0 });

      // 3. getRecentMessages reconciles cache and discovers the remote read flip
      const messages = await h.source.getRecentMessages(5);
      const row = messages.find((m) => m.id === 'pr-1' || m.threadId === 'th-pr-1');
      expect(row?.unread).toBe(false);

      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(0);

      // Exactly ONE change event emitted
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(0);
      expect(h.events[0].unread.byCategory.get('promotions')).toBe(0);
      h.events.length = 0;

      // 4. Subsequent lagging Atom response (still returning pr1, fullCount = 1)
      h.triggerPoll([pr1], 1);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(0);
      expect(h.events.length).toBe(0);

      // 5. Subsequent getRecentMessages calls must NOT oscillate
      const messages2 = await h.source.getRecentMessages(5);
      expect(messages2.find((m) => m.id === 'pr-1' || m.threadId === 'th-pr-1')?.unread).toBe(
        false,
      );
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.events.length).toBe(0);

      h.cleanup();
    });

    it('Primary & Promotions: remote read changes discovered via refresh() update breakdown cleanly without flapping', async () => {
      const h = createHarness('acc-refresh-remote');
      const p1 = primaryMsg();
      const pr1 = promoMsg();

      // Initial: 1 in primary, 1 in promotions (total = 2)
      h.setPollerState([p1, pr1], 2);
      h.setCache(
        [
          cacheRow('p-1', 'th-p-1', 'primary', true),
          cacheRow('pr-1', 'th-pr-1', 'promotions', true),
        ],
        { primary: 1, promotions: 1 },
      );
      h.triggerPoll([p1, pr1], 2);
      await h.source.getRecentMessages(5);
      expect(h.source.getUnreadCounts().total).toBe(2);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(1);
      h.events.length = 0;

      // Remote read for both p1 and pr1
      h.setCache(
        [
          cacheRow('p-1', 'th-p-1', 'primary', false),
          cacheRow('pr-1', 'th-pr-1', 'promotions', false),
        ],
        { primary: 0, promotions: 0 },
      );

      // refresh() polls Atom (which is lagging, returning [p1, pr1]) and then reconciles cache
      await h.source.refresh();

      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(0);

      // Exactly ONE change event emitted during refresh
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(0);
      expect(h.events[0].unread.byCategory.get('primary')).toBe(0);
      expect(h.events[0].unread.byCategory.get('promotions')).toBe(0);
      h.events.length = 0;

      // Subsequent lagging Atom poll does not bounce
      h.triggerPoll([p1, pr1], 2);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.events.length).toBe(0);

      // Subsequent getRecentMessages does not oscillate
      const messages = await h.source.getRecentMessages(5);
      expect(messages.find((m) => m.id === 'p-1' || m.threadId === 'th-p-1')?.unread).toBe(false);
      expect(messages.find((m) => m.id === 'pr-1' || m.threadId === 'th-pr-1')?.unread).toBe(false);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.events.length).toBe(0);

      h.cleanup();
    });

    it('Remote markUnread flip in Primary and Promotions discovered via getRecentMessages moves count and resists lagging Atom omission', async () => {
      const h = createHarness('acc-remote-unread');
      const p1 = primaryMsg('p-1', 'th-p-1', false);
      const pr1 = promoMsg('pr-1', 'th-pr-1', false);

      // Both start read (total = 0)
      h.setPollerState([], 0);
      h.setCache([
        cacheRow('p-1', 'th-p-1', 'primary', false),
        cacheRow('pr-1', 'th-pr-1', 'promotions', false),
      ]);
      h.triggerPoll([], 0);
      await h.source.getRecentMessages(5);
      expect(h.source.getUnreadCounts().total).toBe(0);
      h.events.length = 0;

      // Remote flip: p1 marked unread on web/mobile
      h.setCache(
        [
          cacheRow('p-1', 'th-p-1', 'primary', true),
          cacheRow('pr-1', 'th-pr-1', 'promotions', false),
        ],
        { primary: 1, promotions: 0 },
      );

      const messages = await h.source.getRecentMessages(5);
      expect(messages.find((m) => m.id === 'p-1' || m.threadId === 'th-p-1')?.unread).toBe(true);
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(0);
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(1);
      h.events.length = 0;

      // Lagging Atom poll still reports fullCount = 0 and omits p1
      h.triggerPoll([], 0);
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      expect(h.events.length).toBe(0);

      // Remote flip: pr1 marked unread on web/mobile
      h.setCache(
        [
          cacheRow('p-1', 'th-p-1', 'primary', true),
          cacheRow('pr-1', 'th-pr-1', 'promotions', true),
        ],
        { primary: 1, promotions: 1 },
      );

      const messages2 = await h.source.getRecentMessages(5);
      expect(messages2.find((m) => m.id === 'pr-1' || m.threadId === 'th-pr-1')?.unread).toBe(true);
      expect(h.source.getUnreadCounts().total).toBe(2);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(1);
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(2);
      h.events.length = 0;

      // Lagging Atom poll still reports 0 unread
      h.triggerPoll([], 0);
      expect(h.source.getUnreadCounts().total).toBe(2);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(1);
      expect(h.events.length).toBe(0);

      h.cleanup();
    });

    it('Concurrent multi-category remote read/unread flips accurately update breakdown and total in single event', async () => {
      const h = createHarness('acc-multi-flip');
      const p1 = primaryMsg('p-1', 'th-p-1', true);
      const p2 = primaryMsg('p-2', 'th-p-2', false);
      const pr1 = promoMsg('pr-1', 'th-pr-1', true);
      const pr2 = promoMsg('pr-2', 'th-pr-2', false);

      // Initial state: p1 unread, p2 read, pr1 unread, pr2 read (total = 2)
      h.setPollerState([p1, pr1], 2);
      h.setCache(
        [
          cacheRow('p-1', 'th-p-1', 'primary', true),
          cacheRow('p-2', 'th-p-2', 'primary', false),
          cacheRow('pr-1', 'th-pr-1', 'promotions', true),
          cacheRow('pr-2', 'th-pr-2', 'promotions', false),
        ],
        { primary: 1, promotions: 1 },
      );
      h.triggerPoll([p1, pr1], 2);
      await h.source.getRecentMessages(10);

      expect(h.source.getUnreadCounts().total).toBe(2);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(1);
      h.events.length = 0;

      // Multi-category concurrent flip:
      // p1 -> read (was unread)
      // p2 -> unread (was read)
      // pr1 -> read (was unread)
      // pr2 -> read (unchanged)
      // Net: primary = 1, promotions = 0, total = 1
      h.setCache(
        [
          cacheRow('p-1', 'th-p-1', 'primary', false),
          cacheRow('p-2', 'th-p-2', 'primary', true),
          cacheRow('pr-1', 'th-pr-1', 'promotions', false),
          cacheRow('pr-2', 'th-pr-2', 'promotions', false),
        ],
        { primary: 1, promotions: 0 },
      );

      const messages = await h.source.getRecentMessages(10);
      expect(messages.find((m) => m.id === 'p-1' || m.threadId === 'th-p-1')?.unread).toBe(false);
      expect(messages.find((m) => m.id === 'p-2' || m.threadId === 'th-p-2')?.unread).toBe(true);
      expect(messages.find((m) => m.id === 'pr-1' || m.threadId === 'th-pr-1')?.unread).toBe(false);
      expect(messages.find((m) => m.id === 'pr-2' || m.threadId === 'th-pr-2')?.unread).toBe(false);

      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(0);

      // Exactly ONE change event emitted
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(1);
      expect(h.events[0].unread.byCategory.get('primary')).toBe(1);
      expect(h.events[0].unread.byCategory.get('promotions')).toBe(0);
      h.events.length = 0;

      // Lagging Atom poll (still with old state [p1, pr1], fullCount = 2) does not oscillate
      h.triggerPoll([p1, pr1], 2);
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(0);
      expect(h.events.length).toBe(0);

      h.cleanup();
    });
  });

  describe('Scenario 3: Ledger State Revision & Zero-Sum Mutations', () => {
    it('advances revision and emits change event when one message is marked read and another arrives (zero-sum total)', async () => {
      const h = createHarness('acc-zero-sum');
      const msgA: AtomMessage = {
        id: 'msg-a',
        threadId: 'th-a',
        from: 'Alice <alice@example.com>',
        subject: 'Email A',
        snippet: 'Snippet A',
        modified: new Date(1000),
        category: 'primary',
      };
      const msgB: AtomMessage = {
        id: 'msg-b',
        threadId: 'th-b',
        from: 'Bob <bob@example.com>',
        subject: 'Email B',
        snippet: 'Snippet B',
        modified: new Date(2000),
        category: 'primary',
      };

      // 1. Initial poll establishes msgA unread (total = 1)
      h.setPollerState([msgA], 1);
      h.triggerPoll([msgA], 1);
      expect(h.source.getUnreadCounts().total).toBe(1);
      const initialRev = h.source.getRevision();
      expect(initialRev).toBeGreaterThan(0);
      expect(h.events.length).toBe(1);
      h.events.length = 0;

      // 2. Poll: msgA is no longer unread, new msgB arrives unread (total remains 1)
      h.setPollerState([msgB], 1);
      h.triggerPoll([msgB], 1);

      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getRevision()).toBeGreaterThan(initialRev);
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(1);
      expect(h.events[0].recentMessages.some((m) => m.id === 'msg-b' && m.unread)).toBe(true);

      h.cleanup();
    });

    it('advances revision and emits change event when category changes with total unchanged', async () => {
      const h = createHarness('acc-cat-shift');
      const now = Date.now();
      h.setCache([
        {
          id: 'msg-1',
          threadId: 'th-1',
          from: 'Sender <s@example.com>',
          subject: 'Newsletter',
          snippet: 'Updates',
          unread: true,
          category: 'primary',
          modified: new Date(now),
        },
      ]);
      await h.source.getRecentMessages(5);
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('promotions') ?? 0).toBe(0);
      const rev1 = h.source.getRevision();
      h.events.length = 0;

      // Update cache: msg-1 category reassigned to promotions, total is still 1
      h.setCache([
        {
          id: 'msg-1',
          threadId: 'th-1',
          from: 'Sender <s@example.com>',
          subject: 'Newsletter',
          snippet: 'Updates',
          unread: true,
          category: 'promotions',
          modified: new Date(now),
        },
      ]);
      await h.source.getRecentMessages(5);

      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary') ?? 0).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(1);
      expect(h.source.getRevision()).toBeGreaterThan(rev1);
      expect(h.events.length).toBe(1);

      h.cleanup();
    });

    it('advances revision and emits change event when message snippet or subject updates in cache', async () => {
      const h = createHarness('acc-enrich');
      const now = Date.now();
      h.setCache([
        {
          id: 'msg-1',
          threadId: 'th-1',
          from: 'Sender <s@example.com>',
          subject: 'Original Subject',
          snippet: '',
          unread: true,
          category: 'primary',
          modified: new Date(now),
        },
      ]);
      await h.source.getRecentMessages(5);
      const rev1 = h.source.getRevision();
      h.events.length = 0;

      // Cache enriches subject and snippet
      h.setCache([
        {
          id: 'msg-1',
          threadId: 'th-1',
          from: 'Sender <s@example.com>',
          subject: 'Updated Subject with Code',
          snippet: 'Here is your OTP: 123456',
          unread: true,
          category: 'primary',
          modified: new Date(now),
        },
      ]);
      await h.source.getRecentMessages(5);

      expect(h.source.getRevision()).toBeGreaterThan(rev1);
      expect(h.events.length).toBe(1);
      expect(h.events[0].recentMessages[0].subject).toBe('Updated Subject with Code');

      h.cleanup();
    });

    it('does not advance revision or emit spurious event when identical data is reread', async () => {
      const h = createHarness('acc-idempotent');
      const now = Date.now();
      h.setCache([
        {
          id: 'msg-1',
          threadId: 'th-1',
          from: 'Sender <s@example.com>',
          subject: 'Stable Message',
          snippet: 'Stable Snippet',
          unread: true,
          category: 'primary',
          modified: new Date(now),
        },
      ]);
      await h.source.getRecentMessages(5);
      const rev1 = h.source.getRevision();
      expect(h.events.length).toBe(1);
      h.events.length = 0;

      // Subsequent identical cache reads
      await h.source.getRecentMessages(5);
      await h.source.getRecentMessages(5);

      expect(h.source.getRevision()).toBe(rev1);
      expect(h.events.length).toBe(0);

      h.cleanup();
    });
  });

  describe('Scenario 4: Zero-Sum Turnover Across All Categories', () => {
    const nonPrimaryCategories = ['updates', 'promotions', 'social', 'forums'] as const;

    for (const category of nonPrimaryCategories) {
      it(`within ${category} (unsilenced): advances revision, emits change event, preserves total and updates dock badge`, async () => {
        const settings = {
          primary: 'loud',
          updates: 'badge',
          promotions: 'badge',
          social: 'badge',
          forums: 'badge',
        };
        const h = createHarness(`acc-zero-${category}-on`, { notificationSettings: settings });
        const now = Date.now();
        const msgA = createCategoryAtomMsg(
          `msg-${category}-a`,
          category,
          `${category} A`,
          `th-${category}-a`,
          new Date(now - 10_000),
        );
        const msgB = createCategoryAtomMsg(
          `msg-${category}-b`,
          category,
          `${category} B`,
          `th-${category}-b`,
          new Date(now - 5_000),
        );

        // 1. Initial poll establishes msgA unread
        h.setPollerState([msgA], 1);
        h.triggerPoll([msgA], 1);
        expect(h.source.getUnreadCounts().total).toBe(1);
        expect(h.source.getUnreadCounts().byCategory.get(category)).toBe(1);
        expect(h.source.getUnreadCountFor(countedCategoriesSet(settings))).toBe(1);
        const rev1 = h.source.getRevision();
        expect(rev1).toBeGreaterThan(0);
        expect(h.events.length).toBe(1);
        h.events.length = 0;

        // 2. Poll: msgA is marked read, msgB arrives unread (zero-sum)
        h.setPollerState([msgB], 1);
        h.triggerPoll([msgB], 1);

        expect(h.source.getUnreadCounts().total).toBe(1);
        expect(h.source.getUnreadCounts().byCategory.get(category)).toBe(1);
        expect(h.source.getUnreadCountFor(countedCategoriesSet(settings))).toBe(1);
        expect(h.source.getRevision()).toBeGreaterThan(rev1);
        expect(h.events.length).toBe(1);
        expect(h.events[0].unread.total).toBe(1);
        expect(
          h.events[0].recentMessages.some((m) => m.id === `msg-${category}-b` && m.unread),
        ).toBe(true);

        h.cleanup();
      });

      it(`within ${category} (silenced): advances revision and emits change event while Dock badge remains 0`, async () => {
        const settings = {
          primary: 'loud',
          updates: 'badge',
          promotions: 'badge',
          social: 'badge',
          forums: 'badge',
          [category]: 'off',
        };
        const h = createHarness(`acc-zero-${category}-off`, { notificationSettings: settings });
        const now = Date.now();
        const msgA = createCategoryAtomMsg(
          `msg-sil-${category}-a`,
          category,
          `${category} A`,
          `th-sil-${category}-a`,
          new Date(now - 10_000),
        );
        const msgB = createCategoryAtomMsg(
          `msg-sil-${category}-b`,
          category,
          `${category} B`,
          `th-sil-${category}-b`,
          new Date(now - 5_000),
        );

        // 1. Initial poll establishes msgA unread
        h.setPollerState([msgA], 1);
        h.triggerPoll([msgA], 1);
        expect(h.source.getUnreadCounts().total).toBe(1);
        expect(h.source.getUnreadCounts().byCategory.get(category)).toBe(1);
        // Silenced category excluded from Dock badge
        expect(h.source.getUnreadCountFor(countedCategoriesSet(settings))).toBe(0);
        const rev1 = h.source.getRevision();
        h.events.length = 0;

        // 2. Zero-sum turnover within silenced category
        h.setPollerState([msgB], 1);
        h.triggerPoll([msgB], 1);

        expect(h.source.getUnreadCounts().total).toBe(1);
        expect(h.source.getUnreadCounts().byCategory.get(category)).toBe(1);
        expect(h.source.getUnreadCountFor(countedCategoriesSet(settings))).toBe(0);
        expect(h.source.getRevision()).toBeGreaterThan(rev1);
        expect(h.events.length).toBe(1);

        h.cleanup();
      });
    }

    it('cross-category: 1 Primary read while 1 Social arrives (Social silenced) emits change and decreases Dock badge', async () => {
      const settings = {
        primary: 'loud',
        updates: 'badge',
        promotions: 'badge',
        social: 'off',
        forums: 'badge',
      };
      const h = createHarness('acc-cross-p-to-s', { notificationSettings: settings });
      const now = Date.now();
      const p1 = createCategoryAtomMsg(
        'p1',
        'primary',
        'Primary Subject',
        'th-p1',
        new Date(now - 10_000),
      );
      const s1 = createCategoryAtomMsg(
        's1',
        'social',
        'Social Subject',
        'th-s1',
        new Date(now - 5_000),
      );

      // 1. Initial state: 1 Primary message unread
      h.setPollerState([p1], 1);
      h.triggerPoll([p1], 1);
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('social') ?? 0).toBe(0);
      expect(h.source.getUnreadCountFor(countedCategoriesSet(settings))).toBe(1);
      const rev1 = h.source.getRevision();
      h.events.length = 0;

      // 2. Turnover: p1 read, s1 arrives unread (total remains 1)
      h.setPollerState([s1], 1);
      h.triggerPoll([s1], 1);

      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary') ?? 0).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('social')).toBe(1);
      // Dock badge drops to 0 because Social is silenced!
      expect(h.source.getUnreadCountFor(countedCategoriesSet(settings))).toBe(0);
      expect(h.source.getRevision()).toBeGreaterThan(rev1);
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(1);
      expect(h.events[0].unread.byCategory.get('social')).toBe(1);

      h.cleanup();
    });

    it('cross-category: 1 Social read while 1 Primary arrives (Social silenced) emits change and increases Dock badge', async () => {
      const settings = {
        primary: 'loud',
        updates: 'badge',
        promotions: 'badge',
        social: 'off',
        forums: 'badge',
      };
      const h = createHarness('acc-cross-s-to-p', { notificationSettings: settings });
      const now = Date.now();
      const s1 = createCategoryAtomMsg(
        's1',
        'social',
        'Social Subject',
        'th-s1',
        new Date(now - 10_000),
      );
      const p1 = createCategoryAtomMsg(
        'p1',
        'primary',
        'Primary Subject',
        'th-p1',
        new Date(now - 5_000),
      );

      // 1. Initial state: 1 Social message unread
      h.setPollerState([s1], 1);
      h.triggerPoll([s1], 1);
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('social')).toBe(1);
      expect(h.source.getUnreadCountFor(countedCategoriesSet(settings))).toBe(0);
      const rev1 = h.source.getRevision();
      h.events.length = 0;

      // 2. Turnover: s1 read, p1 arrives unread
      h.setPollerState([p1], 1);
      h.triggerPoll([p1], 1);

      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('primary')).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('social') ?? 0).toBe(0);
      // Dock badge rises to 1 because Primary is counted!
      expect(h.source.getUnreadCountFor(countedCategoriesSet(settings))).toBe(1);
      expect(h.source.getRevision()).toBeGreaterThan(rev1);
      expect(h.events.length).toBe(1);

      h.cleanup();
    });

    it('cross-category: non-primary to non-primary turnover (Updates silenced, Forums counted)', async () => {
      const settings = {
        primary: 'loud',
        updates: 'off',
        promotions: 'badge',
        social: 'badge',
        forums: 'badge',
      };
      const h = createHarness('acc-cross-u-to-f', { notificationSettings: settings });
      const now = Date.now();
      const u1 = createCategoryAtomMsg(
        'u1',
        'updates',
        'Updates Subject',
        'th-u1',
        new Date(now - 10_000),
      );
      const f1 = createCategoryAtomMsg(
        'f1',
        'forums',
        'Forums Subject',
        'th-f1',
        new Date(now - 5_000),
      );

      // 1. Initial state: 1 Updates message unread
      h.setPollerState([u1], 1);
      h.triggerPoll([u1], 1);
      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCountFor(countedCategoriesSet(settings))).toBe(0);
      const rev1 = h.source.getRevision();
      h.events.length = 0;

      // 2. Turnover: u1 read, f1 arrives unread
      h.setPollerState([f1], 1);
      h.triggerPoll([f1], 1);

      expect(h.source.getUnreadCounts().total).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('updates') ?? 0).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('forums')).toBe(1);
      expect(h.source.getUnreadCountFor(countedCategoriesSet(settings))).toBe(1);
      expect(h.source.getRevision()).toBeGreaterThan(rev1);
      expect(h.events.length).toBe(1);

      h.cleanup();
    });

    it('multi-category zero-sum churn: multiple reads and arrivals preserve total while updating counts and badge', async () => {
      const settings = {
        primary: 'loud',
        updates: 'badge',
        promotions: 'off',
        social: 'off',
        forums: 'badge',
      };
      const h = createHarness('acc-multi-churn', { notificationSettings: settings });
      const now = Date.now();
      const p1 = createCategoryAtomMsg(
        'p1',
        'primary',
        'Primary 1',
        'th-p1',
        new Date(now - 10_000),
      );
      const u1 = createCategoryAtomMsg(
        'u1',
        'updates',
        'Updates 1',
        'th-u1',
        new Date(now - 9_000),
      );
      const pr1 = createCategoryAtomMsg(
        'pr1',
        'promotions',
        'Promo 1',
        'th-pr1',
        new Date(now - 4_000),
      );
      const s1 = createCategoryAtomMsg('s1', 'social', 'Social 1', 'th-s1', new Date(now - 3_000));

      // Initial state: p1 and u1 unread (total = 2, dock badge = 2)
      h.setPollerState([p1, u1], 2);
      h.triggerPoll([p1, u1], 2);
      expect(h.source.getUnreadCounts().total).toBe(2);
      expect(h.source.getUnreadCountFor(countedCategoriesSet(settings))).toBe(2);
      const rev1 = h.source.getRevision();
      h.events.length = 0;

      // Turnover: p1 and u1 are read; pr1 and s1 arrive unread (total remains 2)
      h.setPollerState([pr1, s1], 2);
      h.triggerPoll([pr1, s1], 2);

      expect(h.source.getUnreadCounts().total).toBe(2);
      expect(h.source.getUnreadCounts().byCategory.get('primary') ?? 0).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('updates') ?? 0).toBe(0);
      expect(h.source.getUnreadCounts().byCategory.get('promotions')).toBe(1);
      expect(h.source.getUnreadCounts().byCategory.get('social')).toBe(1);
      // Both promotions and social are silenced, so Dock badge is 0!
      expect(h.source.getUnreadCountFor(countedCategoriesSet(settings))).toBe(0);
      expect(h.source.getRevision()).toBeGreaterThan(rev1);
      expect(h.events.length).toBe(1);

      h.cleanup();
    });
  });

  describe('Scenario 5: Backlog Window Turnover (>20 emails)', () => {
    it('advances revision, preserves ceiling, keeps arrivalsIncomplete true when item is read in cache and new unread shifts in', async () => {
      const h = createHarness('acc-backlog-turnover');
      const now = Date.now();

      // Create 20 atom entries for a backlog of 45 items
      const initialEntries: AtomMessage[] = [];
      for (let i = 1; i <= 20; i++) {
        const id = `item-${String(i).padStart(2, '0')}`;
        initialEntries.push(
          createCategoryAtomMsg(
            id,
            'primary',
            `Subject ${id}`,
            `th-${id}`,
            new Date(now - i * 1000),
          ),
        );
      }

      // 1. Initial poll establishes backlog (45 unread, 20 items in truncated feed)
      h.setPollerState(initialEntries, 45);
      h.triggerPoll(initialEntries, 45, now, undefined, true);

      expect(h.source.getUnreadCounts().total).toBe(45);
      expect(h.source.isArrivalsIncomplete()).toBe(true);
      const rev1 = h.source.getRevision();
      expect(rev1).toBeGreaterThan(0);
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(45);
      h.events.length = 0;

      // 2. Cache read: item-01 is marked read; item-21 shifts into window as unread
      // Cache snapshot contains item-01 (read), item-02..20 (unread), item-21 (unread)
      const cacheRows: any[] = [
        createCategoryCacheRow(
          'item-01',
          'primary',
          false,
          'Subject item-01',
          'th-item-01',
          now - 1000,
        ),
      ];
      for (let i = 2; i <= 21; i++) {
        const id = `item-${String(i).padStart(2, '0')}`;
        cacheRows.push(
          createCategoryCacheRow(id, 'primary', true, `Subject ${id}`, `th-${id}`, now - i * 1000),
        );
      }
      h.setCache(cacheRows, {}, now);
      await h.source.getRecentMessages(20);

      // Verify revision advances, total does not oscillate or exceed ceiling (stays 45), arrivalsIncomplete remains true
      const rev2 = h.source.getRevision();
      expect(rev2).toBeGreaterThan(rev1);
      expect(h.source.getUnreadCounts().total).toBe(45);
      expect(h.source.isArrivalsIncomplete()).toBe(true);
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(45);
      // Item 21 is now present in recent messages
      const recent = await h.source.getRecentMessages(25);
      expect(recent.some((m) => m.id === 'item-21' && m.unread)).toBe(true);
      expect(recent.some((m) => m.id === 'item-01' && !m.unread)).toBe(true);
      h.events.length = 0;

      // 3. Second turnover: item-02 marked read, item-22 shifts in
      cacheRows[0] = createCategoryCacheRow(
        'item-01',
        'primary',
        false,
        'Subject item-01',
        'th-item-01',
        now - 1000,
      );
      cacheRows[1] = createCategoryCacheRow(
        'item-02',
        'primary',
        false,
        'Subject item-02',
        'th-item-02',
        now - 2000,
      );
      cacheRows.push(
        createCategoryCacheRow(
          'item-22',
          'primary',
          true,
          'Subject item-22',
          `th-item-22`,
          now - 22 * 1000,
        ),
      );
      h.setCache(cacheRows, {}, now + 1000);
      await h.source.getRecentMessages(20);

      const rev3 = h.source.getRevision();
      expect(rev3).toBeGreaterThan(rev2);
      expect(h.source.getUnreadCounts().total).toBe(45);
      expect(h.source.isArrivalsIncomplete()).toBe(true);
      expect(h.events.length).toBe(1);
      h.events.length = 0;

      // 4. Remote Atom poll catches up and reduces fullCount to 43 (backlog reduction)
      const updatedEntries = initialEntries.slice(2);
      updatedEntries.push(
        createCategoryAtomMsg(
          'item-21',
          'primary',
          'Subject item-21',
          'th-item-21',
          new Date(now - 21 * 1000),
        ),
        createCategoryAtomMsg(
          'item-22',
          'primary',
          'Subject item-22',
          'th-item-22',
          new Date(now - 22 * 1000),
        ),
      );
      h.setPollerState(updatedEntries, 43);
      h.triggerPoll(updatedEntries, 43, now + 5000, undefined, true);

      const rev4 = h.source.getRevision();
      expect(rev4).toBeGreaterThan(rev3);
      expect(h.source.getUnreadCounts().total).toBe(43);
      expect(h.source.isArrivalsIncomplete()).toBe(true);
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(43);

      h.cleanup();
    });
  });

  describe('Scenario 6: In-Flight & Rollback Triage Under Revision Tracking', () => {
    it('advances revision and emits immediately on local triage; when driver succeeds, accepts without redundant bounce', async () => {
      const h = createHarness('acc-triage-success', {
        threadDriverPerform: async () => true,
      });
      const now = Date.now();
      const msg = createCategoryAtomMsg('msg-ok', 'primary', 'Triage Me', 'th-ok', new Date(now));

      h.setPollerState([msg], 1);
      h.triggerPoll([msg], 1);
      expect(h.source.getUnreadCounts().total).toBe(1);
      const rev0 = h.source.getRevision();
      h.events.length = 0;

      // 1. Triage thread: immediately marks optimistic in ledger and emits
      const triagePromise = h.source.triageThread('th-ok', 'archive');

      // Check immediate optimistic state
      expect(h.source.getUnreadCounts().total).toBe(0);
      const rev1 = h.source.getRevision();
      expect(rev1).toBeGreaterThan(rev0);
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(0);
      expect(h.events[0].delta.removedMessageIds).toContain('th-ok');

      // 2. Await driver success
      const success = await triagePromise;
      expect(success).toBe(true);

      // Acceptance does not alter observable state signature, so revision does not bounce and no extra event fires
      expect(h.source.getRevision()).toBe(rev1);
      expect(h.events.length).toBe(1);

      // 3. Stale lagging edge poll arrives restating msg-ok as unread within grace window
      h.triggerPoll([msg], 1, now);
      expect(h.source.getUnreadCounts().total).toBe(0);
      expect(h.source.getRevision()).toBe(rev1);
      expect(h.events.length).toBe(1);

      h.cleanup();
    });

    it('advances revision on local triage, and when driver fails, advances revision again and emits restored state', async () => {
      const h = createHarness('acc-triage-rollback', {
        threadDriverPerform: async () => false,
      });
      const now = Date.now();
      const msg = createCategoryAtomMsg(
        'msg-fail',
        'primary',
        'Fail Triage',
        'th-fail',
        new Date(now),
      );

      h.setPollerState([msg], 1);
      h.triggerPoll([msg], 1);
      expect(h.source.getUnreadCounts().total).toBe(1);
      const rev0 = h.source.getRevision();
      h.events.length = 0;

      // 1. Perform triage which will fail
      const success = await h.source.triageThread('th-fail', 'archive');
      expect(success).toBe(false);

      // Verification:
      // Revision bumped twice:
      // - First for the optimistic action (total 1 -> 0)
      // - Second for the rollback (total 0 -> 1)
      const rev2 = h.source.getRevision();
      expect(rev2).toBeGreaterThan(rev0 + 1);

      // Two events emitted: optimistic hide, then rollback restore
      expect(h.events.length).toBe(2);
      expect(h.events[0].unread.total).toBe(0);
      expect(h.events[0].delta.removedMessageIds).toContain('th-fail');
      expect(h.events[1].unread.total).toBe(1);

      // Final unread count and recent items are restored
      expect(h.source.getUnreadCounts().total).toBe(1);
      const recent = await h.source.getRecentMessages(5);
      expect(recent.some((m) => m.id === 'msg-fail' && m.unread)).toBe(true);

      h.cleanup();
    });

    it('rolls back local markUnread when driver fails: advances revision twice and restores read state', async () => {
      const h = createHarness('acc-mark-unread-fail', {
        threadDriverPerform: async () => false,
      });
      const now = Date.now();
      // Start with message already in ledger as read
      h.setCache([
        createCategoryCacheRow('msg-read', 'primary', false, 'Read Message', 'th-read', now),
      ]);
      await h.source.getRecentMessages(5);
      expect(h.source.getUnreadCounts().total).toBe(0);
      const rev0 = h.source.getRevision();
      h.events.length = 0;

      // 1. Trigger markUnread triage which will fail
      const success = await h.source.triageThread('th-read', 'markUnread');
      expect(success).toBe(false);

      // Revision bumped twice: once on optimistic markUnread, once on rollback
      const rev2 = h.source.getRevision();
      expect(rev2).toBeGreaterThan(rev0 + 1);

      // Two events emitted: total 0 -> 1, then rollback total 1 -> 0
      expect(h.events.length).toBe(2);
      expect(h.events[0].unread.total).toBe(1);
      expect(h.events[1].unread.total).toBe(0);
      expect(h.source.getUnreadCounts().total).toBe(0);

      h.cleanup();
    });
  });

  describe('Scenario 7: Stress & Rapid Interleaving under Edge-Server Lag', () => {
    it('maintains zero count flapping and zero duplicate events under rapid alternating cache reads and stale Atom polls', async () => {
      const h = createHarness('acc-stress-lag');
      const t0 = 10_000;
      const m1 = createCategoryAtomMsg('m1', 'primary', 'Subject 1', 'th-1', new Date(t0));
      const m2 = createCategoryAtomMsg('m2', 'primary', 'Subject 2', 'th-2', new Date(t0));
      const m3 = createCategoryAtomMsg('m3', 'primary', 'Subject 3', 'th-3', new Date(t0));

      // 1. Initial poll establishes 3 unread messages
      h.setPollerState([m1, m2, m3], 3);
      h.triggerPoll([m1, m2, m3], 3, t0);
      expect(h.source.getUnreadCounts().total).toBe(3);
      const rev0 = h.source.getRevision();
      h.events.length = 0;

      // 2. User marks m1 read remotely; cache sees m1 read at t0 + 1000
      h.setCache(
        [
          createCategoryCacheRow('m1', 'primary', false, 'Subject 1', 'th-1', t0 + 1000),
          createCategoryCacheRow('m2', 'primary', true, 'Subject 2', 'th-2', t0),
          createCategoryCacheRow('m3', 'primary', true, 'Subject 3', 'th-3', t0),
        ],
        {},
        t0 + 1000,
      );
      await h.source.getRecentMessages(5);

      expect(h.source.getUnreadCounts().total).toBe(2);
      const rev1 = h.source.getRevision();
      expect(rev1).toBeGreaterThan(rev0);
      expect(h.events.length).toBe(1);
      expect(h.events[0].unread.total).toBe(2);

      // 3. Stress test: 10 rapid alternating cycles of lagging Atom polls and cache reads
      // Simulating edge server lagging by 1-2s (Atom response generated at t0 + 1200 still claims m1 is unread)
      for (let i = 0; i < 10; i++) {
        // Lagging Atom poll restating stale [m1, m2, m3]
        h.triggerPoll([m1, m2, m3], 3, t0 + 1200 + i * 50);
        expect(h.source.getUnreadCounts().total).toBe(2);
        expect(h.source.getRevision()).toBe(rev1);

        // Cache re-read
        await h.source.getRecentMessages(5);
        expect(h.source.getUnreadCounts().total).toBe(2);
        expect(h.source.getRevision()).toBe(rev1);
      }

      // Across all 10 cycles, total never flapped and no extra change events were emitted
      expect(h.source.getUnreadCounts().total).toBe(2);
      expect(h.events.length).toBe(1);

      // 4. Edge server catches up after 6s: Atom returns [m2, m3]
      h.setPollerState([m2, m3], 2);
      h.triggerPoll([m2, m3], 2, t0 + 6000);
      expect(h.source.getUnreadCounts().total).toBe(2);
      expect(h.events.length).toBe(1);

      // 5. Fresh message m4 arrives
      const m4 = createCategoryAtomMsg('m4', 'primary', 'Subject 4', 'th-4', new Date(t0 + 7000));
      h.setPollerState([m2, m3, m4], 3);
      h.triggerPoll([m2, m3, m4], 3, t0 + 7000);

      expect(h.source.getUnreadCounts().total).toBe(3);
      const rev2 = h.source.getRevision();
      expect(rev2).toBeGreaterThan(rev1);
      expect(h.events.length).toBe(2);
      expect(h.events[1].unread.total).toBe(3);

      // Cache briefly lags (still has older [m1, m2, m3] rows)
      await h.source.getRecentMessages(5);
      expect(h.source.getUnreadCounts().total).toBe(3);

      h.cleanup();
    });
  });

  describe('Scenario 8: OTP Verification Code Lifecycle under Revision Tracking', () => {
    it('tracks OTP lifecycle: arrival increments revision, updates to newer code, and clears on triage', async () => {
      const h = createHarness('acc-otp-lifecycle');
      const now = Date.now();

      // 1. Initial state: mailbox empty
      expect(await h.source.getLatestVerificationCode()).toBeNull();
      const rev0 = h.source.getRevision();

      // 2. Arriving OTP email (GitHub)
      const ghOtp: AtomMessage = {
        id: 'msg-otp-gh',
        threadId: 'th-otp-gh',
        from: 'GitHub <noreply@github.com>',
        subject: '849201 is your GitHub verification code',
        snippet: 'Enter this verification code to access your account.',
        link: 'https://mail.google.com/mail/u/0/#inbox/th-otp-gh',
        issued: new Date(now).toISOString(),
        modified: new Date(now),
        category: 'primary',
      };
      h.setPollerState([ghOtp], 1);
      h.triggerPoll([ghOtp], 1);

      const rev1 = h.source.getRevision();
      expect(rev1).toBeGreaterThan(rev0);
      expect(h.source.getUnreadCounts().total).toBe(1);

      const code1 = await h.source.getLatestVerificationCode();
      expect(code1).toEqual({
        code: '849201',
        service: 'GitHub',
        subject: '849201 is your GitHub verification code',
        from: 'GitHub <noreply@github.com>',
        messageId: 'msg-otp-gh',
        threadId: 'th-otp-gh',
        accountId: 'acc-otp-lifecycle',
        receivedAt: now,
      });

      // 3. Newer OTP email arrives (Slack) 30 seconds later
      const slackOtp: AtomMessage = {
        id: 'msg-otp-slack',
        threadId: 'th-otp-slack',
        from: 'Slack <no-reply@slack.com>',
        subject: '482910 is your Slack verification code',
        snippet: 'Your confirmation code is 482910.',
        link: 'https://mail.google.com/mail/u/0/#inbox/th-otp-slack',
        issued: new Date(now + 30_000).toISOString(),
        modified: new Date(now + 30_000),
        category: 'primary',
      };
      h.setPollerState([slackOtp, ghOtp], 2);
      h.triggerPoll([slackOtp, ghOtp], 2);

      const rev2 = h.source.getRevision();
      expect(rev2).toBeGreaterThan(rev1);
      expect(h.source.getUnreadCounts().total).toBe(2);

      // Latest verification code is now the newer Slack code
      const code2 = await h.source.getLatestVerificationCode();
      expect(code2?.code).toBe('482910');
      expect(code2?.service).toBe('Slack');

      // 4. Triage (archive) the Slack OTP email
      await h.source.triageThread('th-otp-slack', 'trash');
      const rev3 = h.source.getRevision();
      expect(rev3).toBeGreaterThan(rev2);
      expect(h.source.getUnreadCounts().total).toBe(1);

      // Verification code cleanly falls back to the active GitHub code
      const code3 = await h.source.getLatestVerificationCode();
      expect(code3?.code).toBe('849201');
      expect(code3?.service).toBe('GitHub');

      // 5. Triage (trash) the remaining GitHub OTP email
      await h.source.triageThread('th-otp-gh', 'trash');
      const rev4 = h.source.getRevision();
      expect(rev4).toBeGreaterThan(rev3);
      expect(h.source.getUnreadCounts().total).toBe(0);

      // No verification codes remain
      expect(await h.source.getLatestVerificationCode()).toBeNull();

      // 6. Arrive a new Stripe OTP, mark it read in cache (not triaged) -> code is still accessible
      h.setCache([
        {
          id: 'msg-otp-stripe',
          threadId: 'th-otp-stripe',
          from: 'Stripe <support@stripe.com>',
          subject: '392817 is your Stripe verification code',
          snippet: 'Your single-use code is 392817.',
          category: 'primary',
          unread: false,
          timestampMs: now + 60_000,
          modified: new Date(now + 60_000),
        },
      ]);
      await h.source.getRecentMessages(5);

      const rev5 = h.source.getRevision();
      expect(rev5).toBeGreaterThan(rev4);
      const codeStripe = await h.source.getLatestVerificationCode();
      expect(codeStripe?.code).toBe('392817');

      // Now archive the read Stripe email from inbox -> code is removed
      await h.source.triageThread('th-otp-stripe', 'archive');
      expect(await h.source.getLatestVerificationCode()).toBeNull();

      // 7. Max age expiration: old OTP (20 mins ago) expires under 15m maxAgeMs
      h.setCache([
        {
          id: 'msg-otp-expired',
          threadId: 'th-otp-expired',
          from: 'Google <no-reply@accounts.google.com>',
          subject: 'G-771122 is your Google verification code',
          snippet: '',
          category: 'primary',
          unread: true,
          timestampMs: now - 20 * 60 * 1000,
          modified: new Date(now - 20 * 60 * 1000),
        },
      ]);
      await h.source.getRecentMessages(5);

      // Expired for 15 minute limit
      expect(await h.source.getLatestVerificationCode(15 * 60 * 1000)).toBeNull();
      // Valid if maxAgeMs is expanded to 30 minutes
      const codeExpiredCheck = await h.source.getLatestVerificationCode(30 * 60 * 1000);
      expect(codeExpiredCheck?.code).toBe('G-771122');

      h.cleanup();
    });
  });
});

/**
 * Every category tab, not just Primary.
 *
 * The bugs found on this branch were all in the paths a category takes through
 * the ledger, and the tests only ever exercised Primary. A category that is
 * counted and one that is silenced take different branches, so both are covered
 * for each of the five.
 */
describe('every category tab', () => {
  const CATEGORIES = ['primary', 'updates', 'promotions', 'social', 'forums'] as const;

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

  const row = (id: string, threadId: string, unread: boolean, category: string) => ({
    id,
    threadId,
    from: 'someone',
    subject: 'subject',
    snippet: 'snippet',
    category: category as 'primary',
    unread,
    modified: new Date(1000),
  });

  const allEnabled = {
    primary: 'loud',
    updates: 'badge',
    promotions: 'badge',
    social: 'badge',
    forums: 'badge',
  };

  for (const category of CATEGORIES) {
    it(`counts a read and an unread in ${category}`, () => {
      const ledger = new UnreadLedger();
      ledger.updateNotificationSettings(allEnabled);
      ledger.reconcileWithAtom([], 0, 20000, undefined, 20000);
      expect(ledger.getBreakdown().total).toBe(0);

      // Unread in this category moves the total, whichever category it is.
      ledger.reconcileWithCache([row('m1', 't1', true, category)], 21000, 18000);
      expect(ledger.getBreakdown().total).toBe(1);
      expect(ledger.getBreakdown().byCategory.get(category)).toBe(1);

      // And reading it takes the total back.
      ledger.reconcileWithCache([row('m1', 't1', false, category)], 22000, 18000);
      expect(ledger.getBreakdown().total).toBe(0);
      expect(ledger.getBreakdown().byCategory.get(category)).toBe(0);
    });

    it(`counts ${category} for display and excludes it from the badge when silenced`, () => {
      const ledger = new UnreadLedger();
      ledger.updateNotificationSettings({ ...allEnabled, [category]: 'off' });
      ledger.reconcileWithAtom([], 0, 20000, undefined, 20000);

      // One cache read, and the total moves. That is the whole latency guarantee:
      // a silenced category is counted for display on the same read that sees it,
      // exactly as a counted one is, rather than arriving later when the feed
      // catches up. The dock badge number does not move, and that is the filter.
      ledger.reconcileWithCache([row('m1', 't1', true, category)], 21000, 18000);
      const breakdown = ledger.getBreakdown();
      // Two numbers with one meaning each: the menu bar shows what is unread, the
      // dock badge shows what deserves a nudge. Neither is a compromise between
      // the two, which is what made a silenced category look like a lag.
      expect(breakdown.total).toBe(1);
      expect(breakdown.byCategory.get(category)).toBe(1);
      const counted = new Set(CATEGORIES.filter((cat) => cat !== category)) as ReadonlySet<
        (typeof CATEGORIES)[number]
      >;
      expect(ledger.getUnreadCountFor(counted)).toBe(0);
    });
  }

  describe('getLatestVerificationCode', () => {
    it('extracts latest verification code from unread message in ledger', () => {
      const ledger = new UnreadLedger();
      const now = Date.now();
      ledger.reconcileWithCache(
        [
          {
            id: 'msg-otp-1',
            threadId: 'th-otp-1',
            from: 'GitHub <noreply@github.com>',
            subject: '849201 is your GitHub verification code',
            snippet: 'Use this code to verify your account.',
            unread: true,
            category: 'primary',
            modified: new Date(now - 60_000),
          },
        ],
        now,
        now,
      );

      const result = ledger.getLatestVerificationCode('acc-1', 15 * 60 * 1000, now);
      expect(result).toEqual({
        code: '849201',
        service: 'GitHub',
        subject: '849201 is your GitHub verification code',
        from: 'GitHub <noreply@github.com>',
        messageId: 'msg-otp-1',
        threadId: 'th-otp-1',
        accountId: 'acc-1',
        receivedAt: now - 60_000,
      });
    });

    it('returns verification code even if message is marked read, but removes it when triaged', () => {
      const ledger = new UnreadLedger();
      const now = Date.now();
      ledger.reconcileWithCache(
        [
          {
            id: 'msg-otp-1',
            threadId: 'th-otp-1',
            from: 'GitHub <noreply@github.com>',
            subject: '849201 is your GitHub verification code',
            snippet: 'Use this code to verify your account.',
            unread: false,
            category: 'primary',
            modified: new Date(now - 60_000),
          },
        ],
        now,
        now,
      );

      // Still returns code while in inbox (even when read)
      expect(ledger.getLatestVerificationCode('acc-1', 15 * 60 * 1000, now)).not.toBeNull();

      // Triage thread (archive)
      ledger.recordLocalTriage('msg-otp-1', 'th-otp-1', 'archive');
      expect(ledger.getLatestVerificationCode('acc-1', 15 * 60 * 1000, now)).toBeNull();
    });

    it('does not return verification code older than maxAgeMs', () => {
      const ledger = new UnreadLedger();
      const now = Date.now();
      ledger.reconcileWithCache(
        [
          {
            id: 'msg-otp-old',
            threadId: 'th-otp-old',
            from: 'Google <no-reply@accounts.google.com>',
            subject: 'G-123456 is your Google verification code',
            snippet: '',
            unread: true,
            category: 'primary',
            modified: new Date(now - 20 * 60 * 1000), // 20 mins ago
          },
        ],
        now,
        now,
      );

      // 15 min limit
      expect(ledger.getLatestVerificationCode('acc-1', 15 * 60 * 1000, now)).toBeNull();
    });
  });
});
