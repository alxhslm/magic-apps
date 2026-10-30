import * as electron from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_CLEAN_USER_AGENT, readSecretFile, writeSecretFile } from '@magimail/core';
import { GMAIL_ATOM_FEED_URL } from './constants.js';
import { createLogger } from '@magimail/core/logger';
import type { TrayMessageItem } from './menubar-manager.js';

function getSession(): typeof electron.session | undefined {
  try {
    if ('session' in electron) {
      return (electron as unknown as { session?: typeof electron.session }).session;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function getApp(): typeof electron.app | undefined {
  try {
    if ('app' in electron) {
      return (electron as unknown as { app?: typeof electron.app }).app;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const log = createLogger('AtomPoller');

export interface AtomMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  link: string;
  issued: string;
  modified: string;
  /**
   * Which Gmail category tab the message arrived in, resolved by `pollNow()`.
   * The feed carries no label per entry, so `parseAtomXml` alone never sets it.
   * Consumers treat a missing value as `primary`.
   */
  category?: NotificationCategory;
}

/** The five Gmail category tabs, which are also the notification settings keys. */
export type NotificationCategory = 'primary' | 'updates' | 'promotions' | 'social' | 'forums';

export type AtomPollStatus = 'ok' | 'auth_required' | 'restricted' | 'network_error';

/**
 * Whether an HTML body looks like a Workspace administrator's policy block.
 *
 * A sign-in page is also HTML, so the two are read apart by wording. This is a
 * best-effort recognition, not a measurement: no tenant has yet produced a Gmail policy
 * page. It is deliberately narrow so a page mentioning Google's privacy policy is not
 * mistaken for an administrator block.
 */
function isPolicyBlockPage(text: string): boolean {
  return (
    /blocked by your administrator/i.test(text) ||
    /your (google workspace )?administrator has (blocked|disabled|restricted)/i.test(text) ||
    /not allowed by (your|the) (organization|administrator)/i.test(text) ||
    /access (is )?denied by (your|the) (organization|administrator)/i.test(text) ||
    /admin_policy|policy_enforced/i.test(text)
  );
}

export interface AtomPollResult {
  accountId: string;
  totalUnread: number;
  categoryCounts?: Map<NotificationCategory, number>;
  newMessages: AtomMessage[];
  /**
   * Mail that arrived since the last poll and has not been dealt with yet —
   * the count behind the badge's `newArrivals` mode. Unlike `totalUnread` this
   * never includes the backlog: see `trackArrivals`.
   */
  newArrivalCount: number;
  /**
   * Whether the feed held entries back, so `newArrivalCount` may be short.
   *
   * True exactly when `<fullcount>` exceeds the number of `<entry>` blocks
   * returned. That comparison needs no knowledge of how many the feed will
   * send — it reads the answer off the response — so it stays correct whatever
   * the limit is, and if Google ever changes it.
   */
  arrivalsIncomplete: boolean;
  rawFullCount?: number | null;
  /**
   * The mailbox time this response is known to describe, from the HTTP `Age`
   * header. Undefined when the response carried no age.
   */
  sourceAsOf?: number;
  status?: AtomPollStatus;
}

export type AtomPollCallback = (result: AtomPollResult) => void;

/**
 * What one round of category sub-feed fetches learned.
 *
 * A category is present in `ids` only if its sub-feed was both asked for and
 * answered — a fetch that failed leaves no entry rather than an empty one, so
 * callers can tell "nothing in this category" from "never found out".
 */
interface SubFeedResult {
  counts: Map<NotificationCategory, number>;
  ids: Map<NotificationCategory, Set<string>>;
}

interface PollerState {
  seenIds: string[];
  /**
   * Ids of arrivals still awaiting the user. See `trackArrivals`.
   *
   * Persisted because the badge it feeds outlives the process: quit with two
   * unhandled arrivals and the badge must still read 2 on the next launch,
   * which a set rebuilt from scratch cannot do — every message in the feed is
   * by then merely unread, and nothing distinguishes the two that arrived.
   */
  activeArrivals?: string[];
  /**
   * Arrival time of the newest message seen, epoch ms — the mark separating
   * mail that *arrived* from mail that is merely *unread*. See `isNewArrival`.
   * Absent in older state files, where it reads as 0 and the first poll sets it.
   */
  lastIssuedAt?: number;
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function extractMessageId(idTag: string, linkHref: string): string {
  if (linkHref) {
    const match = linkHref.match(/[?&](?:message_id|th)=([a-fA-F0-9]+)/);
    if (match) return match[1];
  }
  if (idTag) {
    const parts = idTag.split(':');
    const last = parts[parts.length - 1];
    if (last && last.trim()) return last.trim();
  }
  return idTag || '';
}

/**
 * Converts a feed id into the form Gmail's URLs use.
 *
 * The Atom feed reports ids in decimal (`message_id=1873497444986126337`), but
 * every Gmail URL that opens a message — `#inbox/<id>` — wants the same 64-bit
 * value in hex (`1a00000000000001`). Handed the decimal, Gmail resolves
 * nothing and silently leaves you on the inbox.
 *
 * A Gmail id is at most 16 hex digits, so an all-digit string longer than that
 * cannot be hex and must be the decimal form. Anything else is passed through:
 * ids that already contain a-f, and the `tag:` fallback, are hex as they stand.
 * BigInt because the decimal form exceeds Number.MAX_SAFE_INTEGER.
 */
export function toGmailUrlId(messageId: string): string {
  if (!/^\d{17,}$/.test(messageId)) return messageId;
  try {
    return BigInt(messageId).toString(16);
  } catch {
    return messageId;
  }
}

export function parseAtomXml(xml: string): { fullCount: number | null; entries: AtomMessage[] } {
  const fullCountMatch = xml.match(/<fullcount>(\d+)<\/fullcount>/i);
  const fullCount = fullCountMatch ? parseInt(fullCountMatch[1], 10) : null;

  const entries: AtomMessage[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1];

    const titleMatch = entryXml.match(/<title>([\s\S]*?)<\/title>/i);
    const summaryMatch = entryXml.match(/<summary>([\s\S]*?)<\/summary>/i);
    const linkMatch = entryXml.match(/<link[^>]*href=["']([^"']*)["'][^>]*\/?>/i);
    const idMatch = entryXml.match(/<id>([\s\S]*?)<\/id>/i);
    const modifiedMatch = entryXml.match(/<modified>([\s\S]*?)<\/modified>/i);
    const issuedMatch = entryXml.match(/<issued>([\s\S]*?)<\/issued>/i);

    const authorNameMatch = entryXml.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/i);
    const authorEmailMatch = entryXml.match(/<author>[\s\S]*?<email>([\s\S]*?)<\/email>/i);

    const rawId = idMatch ? idMatch[1].trim() : '';
    const rawLink = linkMatch ? linkMatch[1].trim() : '';
    const messageId = extractMessageId(rawId, rawLink);
    if (!messageId) {
      log.warn('Feed entry has unresolvable message id');
    }

    const name = authorNameMatch ? decodeXmlEntities(authorNameMatch[1].trim()) : '';
    const email = authorEmailMatch ? decodeXmlEntities(authorEmailMatch[1].trim()) : '';
    let from = email;
    if (name && email) {
      from = `${name} <${email}>`;
    } else if (name) {
      from = name;
    }

    entries.push({
      id: messageId,
      // Kept apart on purpose: `id` is the feed's identity, persisted in
      // seenIds to decide what is new, while `threadId` is what URLs are built
      // from. Rewriting `id` would make every already-seen message look new.
      threadId: toGmailUrlId(messageId),
      from,
      subject: titleMatch ? decodeXmlEntities(titleMatch[1].trim()) : '',
      snippet: summaryMatch ? decodeXmlEntities(summaryMatch[1].trim()) : '',
      link: rawLink,
      issued: issuedMatch ? issuedMatch[1].trim() : '',
      modified: modifiedMatch ? modifiedMatch[1].trim() : '',
    });
  }

  return { fullCount, entries };
}

function getStateDir(): string {
  const electronApp = getApp();
  const userData =
    typeof electronApp?.getPath === 'function'
      ? electronApp.getPath('userData')
      : '/tmp/magimail-atom-poller';
  const dir = path.join(userData, 'atom-state');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function loadState(accountId: string): PollerState {
  try {
    return (
      readSecretFile<PollerState>(path.join(getStateDir(), `${accountId}.json`)) ?? { seenIds: [] }
    );
  } catch (err) {
    // The next poll takes the feed as its baseline without announcing any of
    // it, so a discarded state costs an arrival count of zero until then.
    log.warn(`Discarding the poller state for ${accountId}:`, err);
  }
  return { seenIds: [] };
}

function saveState(accountId: string, state: PollerState): void {
  try {
    writeSecretFile(path.join(getStateDir(), `${accountId}.json`), state);
  } catch {
    // Ignore
  }
}

/**
 * Deletes the persisted seen-id and arrival state for an account that has gone.
 *
 * The file is named after the account and nothing else reads it once its poller is
 * stopped, so leaving it writes a record for an account nobody has for ever.
 */
export function clearPollerState(accountId: string): void {
  try {
    fs.rmSync(path.join(getStateDir(), `${accountId}.json`), { force: true });
  } catch {
    // Best-effort: a file nothing reads again is inert, and failing to remove it must not
    // stop the account being removed.
  }
}

/** Maps canonical category names to their Gmail Atom sub-feed path segment. */
const CATEGORY_FEED_PATHS: Record<string, string> = {
  primary: '^smartlabel_personal',
  updates: '^smartlabel_notification',
  promotions: '^smartlabel_promo',
  social: '^smartlabel_social',
  forums: '^smartlabel_group',
};

/**
 * Categories to look a message up in, in resolution order.
 *
 * `primary` is absent by design: Gmail's tabs are mutually exclusive, so primary
 * is the residue, and fetching its sub-feed would cost a request to learn
 * nothing.
 */
const LOOKUP_CATEGORIES: NotificationCategory[] = ['updates', 'social', 'promotions', 'forums'];

/**
 * Which category a message belongs to, given the ids each sub-feed returned.
 *
 * Anything matching no sub-feed is `primary`, which also absorbs the failure
 * cases: an unclassifiable message is announced under the row least likely to
 * be silenced rather than dropped.
 */
/** When a feed entry arrived, epoch ms, or `null` if it carries no readable date. */
export function messageArrivedAt(message: AtomMessage): number | null {
  for (const raw of [message.issued, message.modified]) {
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * How far behind the watermark a message may still count as newly arrived.
 *
 * `issued` is when a message was *sent*, not when it landed, so mail delayed in
 * transit arrives stamped earlier than mail that overtook it — greylisting
 * alone retries minutes later. Without slack those deliveries sit behind the
 * mark and are silently never announced.
 *
 * An hour covers realistic delivery delay and sender clock skew while staying
 * well short of the timescale on which mail is deliberately triaged back to
 * unread. See `docs/magimail/notifications.md#dedup-window`.
 */
export const ARRIVAL_TOLERANCE_MS = 60 * 60 * 1000;

/**
 * Whether a message *arrived*, as opposed to merely being unread.
 *
 * An old message marked unread re-enters the feed with an id the poller never
 * recorded, which by id alone looks like new mail; only the timestamp separates
 * the two. An unreadable date counts as arrived, silence about real mail being
 * the worse failure.
 */
export function isNewArrival(message: AtomMessage, watermark: number): boolean {
  const arrivedAt = messageArrivedAt(message);
  if (arrivedAt === null) return true;
  // `>=`, not `>`: feed timestamps are second-resolution, so a second message
  // landing in the same second must not be swallowed. `seenIds` has already
  // excluded anything seen before, so nothing here can announce twice.
  return arrivedAt >= watermark - ARRIVAL_TOLERANCE_MS;
}

export function resolveMessageCategory(
  messageId: string,
  idsByCategory: Map<NotificationCategory, Set<string>>,
): NotificationCategory {
  for (const category of LOOKUP_CATEGORIES) {
    if (idsByCategory.get(category)?.has(messageId)) return category;
  }
  return 'primary';
}

/**
 * Delay before re-polling after a mailbox change hint. Gmail's Atom feed is
 * served from a backend that lags the mutation slightly, so a fetch issued the
 * instant the hint arrives tends to return the pre-change count.
 */
const CHANGE_HINT_POLL_DELAY_MS = 750;

/** Minimum gap between hint-driven polls, so a burst of hints costs one fetch. */
export const CHANGE_HINT_COOLDOWN_MS = 3000;

export class AtomFeedPoller {
  private accountId: string;
  private partition: string;
  private acIntervalMs: number;
  private batteryIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onPoll: AtomPollCallback;
  private seenMessageIds: Set<string>;
  private lastIssuedAt = 0;
  /** Ids of arrivals still awaiting the user. See `trackArrivals`. */
  private activeArrivals = new Set<string>();
  /** Whether the last feed response was cut short. See `arrivalsIncomplete`. */
  private arrivalsIncomplete = false;
  private isFirstPoll = true;
  /** Message ids the latest feed listed, i.e. still unread. See `isLive`. */
  private liveMessageIds = new Set<string>();
  private isOnBattery = false;
  private isPaused = false;
  private isPolling = false;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHintPollAt = 0;
  private notificationSettings: Record<string, string> = {};
  private lastReportedUnread = 0;
  /**
   * Category per message id, for as long as the feed still lists it.
   *
   * Deliberately not persisted: it is a cache of an answer the sub-feeds can
   * always be asked for again, and a launch pays one round of lookups to refill
   * it. Pruned in `classifyEntries`.
   */
  private categoryById = new Map<string, NotificationCategory>();
  private isWindowFocused = false;
  private powerListenersAttached = false;
  private missingCategories = new Set<NotificationCategory>();
  private latestEntries: AtomMessage[] = [];
  private lastFullCount: number | null = null;

  constructor(
    accountId: string,
    partition: string,
    acIntervalSeconds: number,
    batteryIntervalSecondsOrOnPoll: number | AtomPollCallback,
    maybeOnPoll?: AtomPollCallback,
  ) {
    this.accountId = accountId;
    this.partition = partition;

    if (typeof batteryIntervalSecondsOrOnPoll === 'function') {
      this.acIntervalMs = acIntervalSeconds * 1000;
      this.batteryIntervalMs = acIntervalSeconds * 2 * 1000;
      this.onPoll = batteryIntervalSecondsOrOnPoll;
    } else {
      this.acIntervalMs = acIntervalSeconds * 1000;
      this.batteryIntervalMs = batteryIntervalSecondsOrOnPoll * 1000;
      this.onPoll = maybeOnPoll!;
    }

    const state = loadState(accountId);
    this.seenMessageIds = new Set(state.seenIds);
    this.lastIssuedAt = state.lastIssuedAt ?? 0;
    this.activeArrivals = new Set(Array.isArray(state.activeArrivals) ? state.activeArrivals : []);
    if (this.seenMessageIds.size > 0) {
      this.isFirstPoll = false;
    }
  }

  public start(): void {
    this.setupPowerMonitor();
    this.pollNow();
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.hintTimer) {
      clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    this.isPaused = true;
  }

  /**
   * Re-poll shortly, because the renderer signalled that the mailbox changed.
   *
   * This is a *trigger* only: the feed response stays the sole source of the
   * unread count. Hints are cheap and may be spurious — editing a draft also
   * rewrites Gmail's title — so they are rate-limited rather than trusted.
   */
  public requestImmediatePoll(): void {
    if (this.isPaused) return;

    // A queued hint poll already covers this hint; let it stand rather than
    // pushing it further out, so a steady trickle of hints still gets served.
    if (this.hintTimer) return;

    // Hints are rate-limited but never dropped. Switching accounts rewrites the
    // title, so the user's next action often lands inside the cooldown — a hint
    // arriving then is deferred to the end of it instead of discarded, which is
    // what previously left the badge waiting for the next scheduled tick.
    const sinceLastPoll = Date.now() - this.lastHintPollAt;
    const delay =
      sinceLastPoll >= CHANGE_HINT_COOLDOWN_MS
        ? CHANGE_HINT_POLL_DELAY_MS
        : Math.max(CHANGE_HINT_POLL_DELAY_MS, CHANGE_HINT_COOLDOWN_MS - sinceLastPoll);

    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      this.lastHintPollAt = Date.now();
      void this.pollNow();
    }, delay);
  }

  public setIntervals(acSeconds: number, batterySeconds: number): void {
    this.acIntervalMs = acSeconds * 1000;
    this.batteryIntervalMs = batterySeconds * 1000;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    if (!this.isPaused) {
      this.scheduleNext();
    }
  }

  public setBaseInterval(seconds: number): void {
    this.acIntervalMs = seconds * 1000;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    if (!this.isPaused) {
      this.scheduleNext();
    }
  }

  /**
   * Unhandled arrivals right now, readable before the first poll has run.
   *
   * The set is loaded from disk in the constructor, so the badge can be right
   * the moment the app opens rather than sitting blank until the first fetch
   * comes back. On a badge whose whole promise is that it does not clear itself,
   * a few seconds of blank reads as though it had.
   */
  public getArrivalCount(): number {
    return this.activeArrivals.size;
  }

  /**
   * Whether the latest feed listed this message, which is to say it is still
   * unread. A message that has left the feed was dealt with, and the tray shows
   * it as read.
   */
  public isLive(messageId: string): boolean {
    return this.liveMessageIds.has(messageId);
  }

  /**
   * The category a previous poll remembered for this message, or `undefined`
   * when none was recorded — either because the feed no longer lists it or
   * because a sub-feed failed and no verdict could be reached. See
   * `classifyEntries`.
   */
  public getCategory(messageId: string): NotificationCategory | undefined {
    return this.categoryById.get(messageId);
  }

  /** Update the per-category notification settings used to filter the displayed unread count. */
  public updateNotificationSettings(settings: Record<string, string>): void {
    this.notificationSettings = settings;
  }

  public setFocusAndMissingCategories(isFocused: boolean, missing: NotificationCategory[]): void {
    const prevEffective = this.getEffectiveInterval();
    this.isWindowFocused = isFocused;
    this.missingCategories = new Set(missing);
    const newEffective = this.getEffectiveInterval();
    if (prevEffective !== newEffective && !this.isPaused) {
      // If we accelerated into focused missing-category polling (5s), poll immediately
      // rather than waiting out an existing slow timer (e.g. 60s)
      if (newEffective < prevEffective) {
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        void this.pollNow();
      } else {
        this.scheduleNext();
      }
    }
  }

  public getLatestEntries(): AtomMessage[] {
    return [...this.latestEntries];
  }

  public getLastFullCount(): number | null {
    return this.lastFullCount;
  }

  public async pollNow(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const electronSession = getSession();
      if (!electronSession || typeof electronSession.fromPartition !== 'function') {
        return;
      }
      const ses = electronSession.fromPartition(this.partition);
      if (!ses || typeof ses.fetch !== 'function') {
        return;
      }
      const response = await ses.fetch(GMAIL_ATOM_FEED_URL, {
        headers: {
          'User-Agent': DEFAULT_CLEAN_USER_AGENT,
        },
      });

      // An edge cache states how long it has held the response. `Age: 0` is a
      // fresh response; a larger value is how far behind the mailbox it may be.
      const ageHeader = response.headers?.get?.('age') ?? null;
      const ageSeconds = ageHeader === null ? NaN : Number(ageHeader);
      const sourceAsOf = Number.isFinite(ageSeconds)
        ? Date.now() - Math.max(0, ageSeconds) * 1000
        : undefined;

      if (!response.ok) {
        // Status 401 or redirect to login means account is not signed in yet
        if (response.status === 401) {
          log.info(`Partition ${this.partition} not authenticated yet`);
          this.onPoll({
            accountId: this.accountId,
            totalUnread: this.lastReportedUnread,
            newMessages: [],
            newArrivalCount: this.activeArrivals.size,
            arrivalsIncomplete: this.arrivalsIncomplete,
            status: 'auth_required',
          });
        } else if (response.status === 403) {
          // A Workspace administrator can refuse Gmail's Atom feed outright. That is
          // not the network and not a sign-in the user can perform, so it gets its own
          // state rather than being called offline.
          log.warn(`Feed fetch refused by policy for ${this.accountId}`);
          this.onPoll({
            accountId: this.accountId,
            totalUnread: this.lastReportedUnread,
            newMessages: [],
            newArrivalCount: this.activeArrivals.size,
            arrivalsIncomplete: this.arrivalsIncomplete,
            status: 'restricted',
          });
        } else {
          log.error(`Feed fetch failed with status: ${response.status}`);
          this.onPoll({
            accountId: this.accountId,
            totalUnread: this.lastReportedUnread,
            newMessages: [],
            newArrivalCount: this.activeArrivals.size,
            arrivalsIncomplete: this.arrivalsIncomplete,
            status: 'network_error',
          });
        }
        return;
      }

      const xml = await response.text();
      const { fullCount, entries } = parseAtomXml(xml);
      this.lastFullCount = fullCount;

      if (fullCount === null) {
        // A policy block page also arrives as HTML with no feed, so it is read before
        // the fallback that calls every non-feed answer a sign-in page.
        if (isPolicyBlockPage(xml)) {
          log.warn(`Partition ${this.partition} returned an administrator policy block`);
          this.onPoll({
            accountId: this.accountId,
            totalUnread: this.lastReportedUnread,
            newMessages: [],
            newArrivalCount: this.activeArrivals.size,
            arrivalsIncomplete: this.arrivalsIncomplete,
            status: 'restricted',
          });
          return;
        }
        log.info(`Partition ${this.partition} returned non-feed response (auth required)`);
        this.onPoll({
          accountId: this.accountId,
          totalUnread: this.lastReportedUnread,
          newMessages: [],
          newArrivalCount: this.activeArrivals.size,
          arrivalsIncomplete: this.arrivalsIncomplete,
          status: 'auth_required',
        });
        return;
      }

      this.liveMessageIds = new Set(entries.map((entry) => entry.id));

      let newMessages: AtomMessage[] = [];
      const watermarkBefore = this.lastIssuedAt;
      const recordedBefore = this.seenMessageIds.size;

      if (this.isFirstPoll) {
        // On first run without saved state, populate baseline seen IDs without firing banners
        for (const entry of entries) {
          if (entry.id) {
            this.seenMessageIds.add(entry.id);
          } else {
            log.warn('Skipping feed entry with empty message id');
          }
        }
        this.isFirstPoll = false;
      } else {
        // Two questions: is this id unrecorded, and did the message *arrive*
        // since we last looked? Only the second rules out an old message that
        // was marked unread again.
        const unseen: AtomMessage[] = [];
        for (const entry of entries) {
          if (!entry.id) {
            log.warn('Skipping feed entry with empty message id');
            continue;
          }
          if (!this.seenMessageIds.has(entry.id)) {
            unseen.push(entry);
            // Recorded either way, so a message the watermark holds back is
            // not reconsidered on a later poll.
            this.seenMessageIds.add(entry.id);
          }
        }
        newMessages = unseen.filter((entry) => isNewArrival(entry, this.lastIssuedAt));
      }

      this.advanceWatermark(entries);
      // Persist on any change to either half, not just on a banner: a message
      // the watermark holds back is recorded while announcing nothing, and a
      // baseline poll of a dateless feed moves no watermark.
      if (this.seenMessageIds.size !== recordedBefore || this.lastIssuedAt !== watermarkBefore) {
        this.persistState();
      }

      // Only the sub-feeds this result *depends on* are fetched before it is
      // reported: a silenced category changes the count, and a new message
      // needs its row of the settings matrix before a banner can be routed.
      // Both were already paid for here. Classifying the rest of the feed is
      // not — see `classifyRemainder`.
      const blocking = new Set<NotificationCategory>();
      for (const [cat, level] of Object.entries(this.notificationSettings)) {
        if (level === 'off' && cat in CATEGORY_FEED_PATHS) {
          blocking.add(cat as NotificationCategory);
        }
      }
      for (const cat of this.missingCategories) {
        if (cat in CATEGORY_FEED_PATHS) {
          blocking.add(cat);
        }
      }
      if (newMessages.length > 0) {
        for (const cat of LOOKUP_CATEGORIES) blocking.add(cat);
      }

      const subFeeds = await this.fetchCategoryFeeds(ses, Array.from(blocking));

      this.classifyEntries(entries, subFeeds);
      this.latestEntries = entries;
      // Read off this response, not inferred from a page size we do not know.
      // Also marked incomplete if any feed entry could not have its ID extracted.
      this.arrivalsIncomplete = fullCount > entries.length || entries.some((entry) => !entry.id);
      this.trackArrivals(entries, newMessages);

      let offCategoryCount = 0;
      for (const [cat, level] of Object.entries(this.notificationSettings)) {
        if (level === 'off') {
          const subCount = subFeeds.counts.get(cat as NotificationCategory) ?? 0;
          if (entries.length > 0 && fullCount <= entries.length) {
            // When all inbox messages are present in entries, count how many belong to this off-category.
            // This prevents archived unread messages in the category sub-feed from negative-clamping
            // the inbox unread count.
            const inEntries = entries.filter((e) => e.category === cat).length;
            offCategoryCount += inEntries;
          } else {
            // When fullCount > entries.length or no entries, cap sub-feed count at fullCount.
            offCategoryCount += Math.min(subCount, fullCount);
          }
        }
      }

      const displayedUnread = Math.max(0, fullCount - offCategoryCount);
      this.lastReportedUnread = displayedUnread;

      const categoryCounts = new Map<NotificationCategory, number>();
      for (const [cat, count] of subFeeds.counts.entries()) {
        categoryCounts.set(cat, count);
      }

      this.onPoll({
        accountId: this.accountId,
        totalUnread: displayedUnread,
        categoryCounts,
        newMessages,
        newArrivalCount: this.activeArrivals.size,
        arrivalsIncomplete: this.arrivalsIncomplete,
        rawFullCount: fullCount,
        sourceAsOf,
        status: 'ok',
      });

      // Released before the tail, not by the `finally` after it. Classification
      // must not leave the poller looking busy: `pollNow` drops a call that
      // arrives while one is in flight, so a hint landing here — and marking a
      // message unread produces one — would be discarded outright and the badge
      // left waiting for the next scheduled tick.
      this.isPolling = false;
      await this.classifyRemainder(ses, entries, subFeeds);
      this.latestEntries = entries;
    } catch (err) {
      log.error(`Poll error for ${this.accountId}:`, err);
      this.onPoll({
        accountId: this.accountId,
        totalUnread: this.lastReportedUnread,
        newMessages: [],
        newArrivalCount: this.activeArrivals.size,
        arrivalsIncomplete: this.arrivalsIncomplete,
        status: 'network_error',
      });
    } finally {
      this.isPolling = false;
      if (!this.isPaused) {
        this.scheduleNext();
      }
    }
  }

  /**
   * Fetch each named category sub-feed once, returning what it counts and what
   * it contains.
   *
   * A failed feed reports zero and an empty id set rather than throwing, both
   * callers degrading safely on that and neither being worth failing the whole
   * poll over.
   */
  private async fetchCategoryFeeds(
    ses: electron.Session,
    categories: NotificationCategory[],
  ): Promise<SubFeedResult> {
    const counts = new Map<NotificationCategory, number>();
    const ids = new Map<NotificationCategory, Set<string>>();
    if (categories.length === 0) return { counts, ids };

    await Promise.all(
      categories.map(async (cat) => {
        const feedPath = CATEGORY_FEED_PATHS[cat];
        try {
          const subResp = await ses.fetch(
            `https://mail.google.com/mail/feed/atom/${encodeURIComponent(feedPath)}`,
            {
              headers: { 'User-Agent': DEFAULT_CLEAN_USER_AGENT },
            },
          );
          if (!subResp.ok) {
            log.warn(
              `Sub-feed fetch for category "${cat}" returned ${subResp.status} — treating as empty`,
            );
            return;
          }
          const parsed = parseAtomXml(await subResp.text());
          counts.set(cat, parsed.fullCount ?? 0);
          ids.set(cat, new Set(parsed.entries.map((entry) => entry.id)));
        } catch (subErr) {
          log.warn(`Sub-feed fetch error for category "${cat}" — treating as empty:`, subErr);
        }
      }),
    );

    return { counts, ids };
  }

  /**
   * Stamp every feed entry with its category, remembering each verdict.
   *
   * Only a round that asked for all four lookup sub-feeds *and* got all four
   * can classify: a sub-feed that failed comes back indistinguishable from an
   * empty one, and caching on that would quietly file its mail under `primary`
   * for as long as the thread stays in the feed. An unclassified entry is left
   * unset, which consumers read as `primary` for that poll only, so the next
   * one gets another go.
   */
  private classifyEntries(entries: AtomMessage[], subFeeds: SubFeedResult): number {
    const canClassify = LOOKUP_CATEGORIES.every((cat) => subFeeds.ids.has(cat));
    let learned = 0;

    for (const entry of entries) {
      let matchedCategory: NotificationCategory | null = null;
      for (const [cat, ids] of subFeeds.ids.entries()) {
        if (ids.has(entry.id)) {
          matchedCategory = cat;
          break;
        }
      }

      if (matchedCategory) {
        this.categoryById.set(entry.id, matchedCategory);
        entry.category = matchedCategory;
        learned += 1;
      } else if (canClassify) {
        // All 4 lookup sub-feeds were fetched and none contained this message -> Primary
        this.categoryById.set(entry.id, 'primary');
        entry.category = 'primary';
        learned += 1;
      } else {
        const cached = this.categoryById.get(entry.id);
        // If the cached category was fetched in this round and did NOT contain
        // the message, the message was recategorized away from it.
        if (cached && subFeeds.ids.has(cached) && !subFeeds.ids.get(cached)?.has(entry.id)) {
          this.categoryById.delete(entry.id);
          entry.category = 'primary';
        } else if (cached) {
          entry.category = cached;
        }
      }
    }

    // Bounded by the feed itself rather than by a cap: a thread that has left it
    // is neither displayed nor announced, so its verdict has nothing left to
    // serve. Should it return, it is classified again.
    const live = new Set(entries.map((entry) => entry.id));
    for (const id of this.categoryById.keys()) {
      if (!live.has(id)) {
        this.categoryById.delete(id);
      }
    }

    return learned;
  }

  /**
   * Bring the set of unhandled arrivals up to date with this poll.
   *
   * Two halves: everything this poll announced joins the set, and everything
   * the user has since dealt with leaves it. The set is therefore neither the
   * backlog nor the notification history — it is the intersection, mail that
   * both arrived recently and is still waiting.
   *
   * **Leaving the feed is the only thing that decrements the badge.** The feed
   * lists only unread mail, so an id that has dropped out was read, archived or
   * deleted. Opening the app does not count, which is the point: coming to the
   * front to write one mail must not clear the mark on three you have not read.
   *
   * A silenced category is excluded on the way in *and* on the way out, so
   * turning one off retires the arrivals already counted for it rather than
   * stranding them on the badge. This matches `displayedUnread`, which
   * subtracts the same categories: whichever mode the badge is in, the number
   * counts the same mail.
   *
   * The set is always a subset of the entries just listed, which bounds it to
   * the feed's page size. What that costs when a mailbox outgrows the page is
   * in `docs/magimail/notifications.md#paged-feed` — deliberately, and in that direction.
   */
  private trackArrivals(entries: AtomMessage[], newMessages: AtomMessage[]): void {
    const before = this.activeArrivals;
    const isSilenced = (category: NotificationCategory | undefined) =>
      this.notificationSettings[category ?? 'primary'] === 'off';

    const live = new Set(entries.map((entry) => entry.id));
    this.activeArrivals = new Set(Array.from(before).filter((id) => live.has(id)));

    for (const id of this.activeArrivals) {
      if (isSilenced(this.categoryById.get(id))) this.activeArrivals.delete(id);
    }

    for (const message of newMessages) {
      if (!message.id) {
        log.warn('Skipping arrival with empty message id');
        continue;
      }
      if (isSilenced(message.category)) continue;
      this.activeArrivals.add(message.id);
    }

    // Content, not size: one arrival pruned while another lands leaves the
    // count alone but must still reach disk, or a restart resurrects the old id.
    const changed =
      this.activeArrivals.size !== before.size ||
      Array.from(this.activeArrivals).some((id) => !before.has(id));
    if (changed) this.persistState();
  }

  /**
   * Classify whatever the blocking round left unresolved.
   *
   * Deliberately after `onPoll`, and this is the whole point of it being a
   * separate step. Only the tray and the widgets want a category; the badge
   * wants a number, and marking a message unread has to move that number *now*.
   * A returning thread has been pruned from the memo, so classifying it in
   * front of the count put four sub-feed fetches between the user's click and
   * the badge — which is exactly what it felt like.
   *
   * The categories land one poll later on the widget snapshot as a result,
   * since that is written from the callback. A minute-late garnish on a widget
   * is a fair trade for a badge that keeps up.
   */
  private async classifyRemainder(
    ses: electron.Session,
    entries: AtomMessage[],
    already: SubFeedResult,
  ): Promise<void> {
    if (entries.every((entry) => entry.category !== undefined)) return;

    // Whatever the blocking round already fetched is reused rather than asked
    // for twice — a silenced category serves its count and its tagging alike.
    const missing = LOOKUP_CATEGORIES.filter((cat) => !already.ids.has(cat));
    const extra = await this.fetchCategoryFeeds(ses, missing);

    this.classifyEntries(entries, {
      counts: already.counts,
      ids: new Map([...already.ids, ...extra.ids]),
    });
  }

  /**
   * Move the watermark up to the newest arrival in this poll, driven by every
   * entry rather than only the announced ones, so it tracks the mailbox.
   */
  private advanceWatermark(entries: AtomMessage[]): void {
    const now = Date.now();
    let newest = this.lastIssuedAt;
    for (const entry of entries) {
      const arrivedAt = messageArrivedAt(entry);
      // Capped at now, so a message dated in the future — spam routinely is —
      // cannot drag the mark past every genuine arrival and silence the account.
      if (arrivedAt !== null && arrivedAt <= now && arrivedAt > newest) {
        newest = arrivedAt;
      }
    }
    this.lastIssuedAt = newest;
  }

  private persistState(): void {
    // Keep set bounded to 500 recent items
    if (this.seenMessageIds.size > 500) {
      const arr = Array.from(this.seenMessageIds);
      this.seenMessageIds = new Set(arr.slice(arr.length - 500));
    }
    saveState(this.accountId, {
      seenIds: Array.from(this.seenMessageIds),
      lastIssuedAt: this.lastIssuedAt,
      activeArrivals: Array.from(this.activeArrivals),
    });
  }

  private scheduleNext(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const interval = this.getEffectiveInterval();
    this.timer = setTimeout(() => this.pollNow(), interval);
  }

  /**
   * The effective polling interval.
   *
   * If the window is focused on this account, polling accelerates to 5s (8s on battery)
   * so triage in all mailboxes and categories updates quickly. Otherwise, the configured
   * background interval is used.
   */
  public getEffectiveInterval(): number {
    if (this.isWindowFocused) {
      return this.isOnBattery ? 8000 : 5000;
    }
    return this.isOnBattery ? this.batteryIntervalMs : this.acIntervalMs;
  }

  private setupPowerMonitor(): void {
    if (this.powerListenersAttached) return;
    this.powerListenersAttached = true;

    let pm: typeof electron.powerMonitor | undefined;
    try {
      if ('powerMonitor' in electron) {
        pm = (electron as unknown as { powerMonitor?: typeof electron.powerMonitor }).powerMonitor;
      }
    } catch {
      return;
    }
    if (!pm || typeof pm.on !== 'function') {
      return;
    }

    try {
      if (typeof pm.isOnBatteryPower === 'function') {
        this.isOnBattery = pm.isOnBatteryPower();
      }
    } catch {
      // Fallback
    }

    pm.on('on-battery', () => {
      this.isOnBattery = true;
      this.scheduleNext();
    });
    pm.on('on-ac', () => {
      this.isOnBattery = false;
      this.scheduleNext();
    });
    pm.on('suspend', () => {
      this.isPaused = true;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    });
    pm.on('resume', () => {
      this.isPaused = false;
      this.pollNow();
    });
  }
}

/**
 * Converts an Atom feed message to a TrayMessageItem for display in the tray
 * or widget when Gmail's local IndexedDB offline cache is not available.
 */
export function atomMessageToTrayMessageItem(message: AtomMessage): TrayMessageItem {
  return {
    id: message.id,
    threadId: message.threadId,
    from: message.from,
    subject: message.subject,
    snippet: message.snippet,
    modified: message.modified ? new Date(message.modified) : undefined,
    category: message.category ?? 'primary',
    unread: true,
  };
}
