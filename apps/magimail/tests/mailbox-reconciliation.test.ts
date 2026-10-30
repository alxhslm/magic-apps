import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnreadLedger, CACHE_TRIAGE_GRACE_MS } from '../src/mailbox/unread-ledger.js';
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
      // _xdb is read and contains stale record msg-1 marked unread.
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
      const expiredTime = triageTime + CACHE_TRIAGE_GRACE_MS + 100;
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
