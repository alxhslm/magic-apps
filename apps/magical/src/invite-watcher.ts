import { RESPONSE_NEEDS_ACTION, type NormalizedCalendarEvent } from './calendar-decoder.js';

/**
 * invite-watcher.ts
 *
 * Spots invitations that have arrived and not been answered.
 *
 * A different shape of problem from a meeting alert, and deliberately a separate module.
 * An alert is time-based — it fires once, at a moment computed from the start time. An
 * invitation is state-based: it is pending from the moment it appears until the user
 * answers, and what we want to notify about is the *transition* into that state.
 *
 * The trap is the backlog. Naively notifying every unanswered invitation on each poll
 * would post a banner per invitation every five minutes, and a fresh pile of them at
 * every launch — for invitations the user already knows about and has been ignoring.
 * Magimail learned this with its unread badge; an alert engine gets
 * less benefit of the doubt.
 */

export interface PendingInvite {
  event: NormalizedCalendarEvent;
  sourceId: string;
  /** Stable across restarts, so an invitation is announced once. */
  key: string;
}

/**
 * Identifies one invitation.
 *
 * The series rather than the occurrence: being invited to a recurring meeting is one
 * invitation, and every occurrence carries the same unanswered state, so keying per
 * occurrence would announce fifty-two of them. Falls back to the event id when the event
 * is a one-off.
 */
export function inviteKey(event: NormalizedCalendarEvent, sourceId: string): string {
  return `${sourceId}|invite|${event.seriesId ?? event.id}`;
}

/**
 * Invited, and not yet answered.
 *
 * `'notInvited'` is excluded deliberately: an event the user can see on a shared
 * calendar but is not a guest of is not awaiting their reply.
 */
export function isPendingInvite(event: NormalizedCalendarEvent): boolean {
  return event.myResponseStatus === RESPONSE_NEEDS_ACTION;
}

/**
 * The invitation this occurrence belongs to: its series, or the event itself when it is a
 * one-off.
 *
 * A response is recorded on the series, so this is also the unit an answer covers. Google
 * keeps `needsAction` on some future occurrences of a declined series, and reading those
 * as independent invitations resurrects a series the user has already answered.
 */
function invitationOf(event: NormalizedCalendarEvent): string {
  return event.seriesId ?? event.id;
}

/**
 * Series that carry a response anywhere in the window.
 *
 * A reply answers one occurrence, and Google can leave `needsAction` on the rest of the
 * series. The series is one invitation, so a response anywhere in it settles the whole
 * thing: those residual occurrences are not a second invitation.
 */
function answeredInvitations(events: NormalizedCalendarEvent[]): Set<string> {
  const answered = new Set<string>();
  for (const event of events) {
    if (event.myResponseStatus === RESPONSE_NEEDS_ACTION) continue;
    if (event.myResponseStatus === 'notInvited') continue;
    answered.add(invitationOf(event));
  }
  return answered;
}

/**
 * Tracks which invitations have been announced, and which are still outstanding.
 *
 * `observe` is called with the full window after every poll and returns only what is
 * newly pending — the set the caller should post banners for.
 */
export class InviteWatcher {
  private announced: Set<string>;
  private outstanding = new Map<string, PendingInvite>();
  /** Sources whose backlog has been absorbed. */
  private seeded = new Set<string>();
  /**
   * Invitations that arrived and are still waiting on the user.
   *
   * The same set Magimail keeps for its `newArrivals` badge, for the same reason: it is
   * what arrived while you were away, with the backlog left out. An invitation joins only
   * when a banner actually fires for it, so a seeded backlog never enters, and leaves when
   * it stops being pending. See `docs/magimail/notifications.md#what-the-dock-badge-counts`.
   */
  private arrivals: Set<string>;

  private readonly now: () => number;

  constructor(
    alreadyAnnounced: Iterable<string> = [],
    private onAnnounced?: (key: string) => void,
    arrivals: { known?: Iterable<string>; onChanged?: (keys: string[]) => void } = {},
    options: { now?: () => number } = {},
  ) {
    this.announced = new Set(alreadyAnnounced);
    this.arrivals = new Set(arrivals.known ?? []);
    this.onArrivalsChanged = arrivals.onChanged;
    this.now = options.now ?? (() => Date.now());
  }

  private onArrivalsChanged?: (keys: string[]) => void;

  private reportArrivals(before: number): void {
    if (this.arrivals.size !== before) this.onArrivalsChanged?.([...this.arrivals]);
  }

  /**
   * Returns invitations that have *arrived*, not invitations that are outstanding.
   *
   * The distinction is the whole feature. A first poll on a fresh install finds every
   * unanswered invitation in the window, and banner-ing all of them is indistinguishable
   * from spam — the user already knows about those; they have been ignoring them. So the
   * first observation of a source **seeds**: its pending set is recorded silently, and
   * only what appears afterwards is announced. Magimail reached the same conclusion for
   * its unread badge.
   *
   * Answering an invitation elsewhere — in Google, or on a phone — drops it out of the
   * pending set, and the key is forgotten so a genuine re-invitation is announced again.
   *
   * An occurrence that has already finished is not pending, so a series leaves the pile
   * once its last occurrence in the window has passed, and what remains is dated by the
   * next occurrence rather than by whichever the expansion happened to yield last.
   */
  public observe(sourceId: string, events: NormalizedCalendarEvent[]): PendingInvite[] {
    const pendingNow = new Map<string, PendingInvite>();
    const nowMs = this.now();
    const answered = answeredInvitations(events);

    for (const event of events) {
      if (!isPendingInvite(event)) continue;
      // One answered occurrence settles the series: the response applies to all of it,
      // and the `needsAction` Google leaves on later occurrences is not a new invitation.
      if (answered.has(invitationOf(event))) continue;
      // A meeting that has already finished is not awaiting a reply: answering it changes
      // nothing anyone can act on, and a pile nobody can work off is what drives the user
      // to ignore the badge entirely. A series is dropped only once its last occurrence in
      // the window has gone, because every occurrence carries the same unanswered state.
      if (event.endTime.getTime() <= nowMs) continue;
      const key = inviteKey(event, sourceId);
      // The next occurrence stands for the series. The poller expands a year ahead, so
      // taking whichever occurrence arrived last would date a weekly meeting next June.
      const existing = pendingNow.get(key);
      if (existing && existing.event.startTime <= event.startTime) continue;
      pendingNow.set(key, { event, sourceId, key });
    }

    const isFirstLook = !this.seeded.has(sourceId);
    this.seeded.add(sourceId);

    const arrivalsBefore = this.arrivals.size;
    const fresh: PendingInvite[] = [];
    for (const [key, invite] of pendingNow) {
      if (this.announced.has(key)) continue;
      this.announced.add(key);
      this.onAnnounced?.(key);
      // Only a banner makes an arrival. A seeded backlog is not news, and counting it
      // would give the badge the same permanent number the mode exists to avoid.
      if (!isFirstLook) {
        fresh.push(invite);
        this.arrivals.add(key);
      }
    }

    // Forget anything from this source that is no longer pending, so a future invitation
    // to the same series is announced rather than silently swallowed.
    for (const [key, invite] of this.outstanding) {
      if (invite.sourceId !== sourceId) continue;
      if (!pendingNow.has(key)) {
        this.outstanding.delete(key);
        this.announced.delete(key);
        this.arrivals.delete(key);
      }
    }
    for (const [key, invite] of pendingNow) this.outstanding.set(key, invite);

    this.reportArrivals(arrivalsBefore);
    return fresh;
  }

  /** Everything awaiting an answer. */
  public pendingCount(): number {
    return this.outstanding.size;
  }

  /**
   * Invitations that arrived and are still waiting, which is not the whole pile.
   *
   * Answering one drops it, and so does opening the dropdown; see `acknowledge`.
   */
  public newArrivalCount(): number {
    return this.arrivals.size;
  }

  /** Whether this invitation is one of the arrivals, rather than part of the backlog. */
  public isNewArrival(key: string): boolean {
    return this.arrivals.has(key);
  }

  /** How many arrivals each source is holding, for the account switcher's dots. */
  public arrivalsBySource(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const key of this.arrivals) {
      const sourceId = this.outstanding.get(key)?.sourceId;
      if (!sourceId) continue;
      counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
    }
    return counts;
  }

  /** Marks one invitation read, leaving it in the pile for an answer. */
  public markRead(key: string): void {
    const before = this.arrivals.size;
    this.arrivals.delete(key);
    this.reportArrivals(before);
  }

  /** Marks all arrived invitations read, for one source or across all sources. */
  public acknowledge(sourceId?: string): void {
    const before = this.arrivals.size;
    for (const key of [...this.arrivals]) {
      if (sourceId && this.outstanding.get(key)?.sourceId !== sourceId) continue;
      this.arrivals.delete(key);
    }
    this.reportArrivals(before);
  }

  public pending(): PendingInvite[] {
    return [...this.outstanding.values()];
  }

  /** Called when the user answers from a banner, so the badge clears before the next poll. */
  public resolve(key: string): void {
    const before = this.arrivals.size;
    this.outstanding.delete(key);
    this.announced.delete(key);
    this.arrivals.delete(key);
    this.reportArrivals(before);
  }

  /**
   * Drops everything belonging to a source, for when its account is removed.
   *
   * Nothing else can clear those invitations: the account is gone, so no future poll will
   * report them answered, and a badge counting them is a number the user has no way to
   * work off. Forgetting `seeded` too means that re-adding the same account absorbs its
   * backlog silently rather than posting a banner per outstanding invitation.
   */
  public forget(sourceId: string): void {
    const before = this.arrivals.size;
    for (const [key, invite] of this.outstanding) {
      if (invite.sourceId !== sourceId) continue;
      this.outstanding.delete(key);
      this.announced.delete(key);
      this.arrivals.delete(key);
    }
    this.seeded.delete(sourceId);
    this.reportArrivals(before);
  }
}

/** How a user can answer an invitation. Applied by driving Google's own controls. */
export type RsvpResponse = 'yes' | 'no' | 'maybe';
