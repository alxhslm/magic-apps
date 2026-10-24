import { describe, it, expect } from 'vitest';
import { InviteWatcher, inviteKey, isPendingInvite } from '../src/invite-watcher';
import type { NormalizedCalendarEvent } from '../src/calendar-decoder';

/** Frozen, because an invitation to a meeting that has finished is no longer pending. */
const NOW = Date.parse('2026-09-16T08:00:00Z');

/** Every watcher here reads the same clock; the fixture event is an hour away from it. */
const makeWatcher = (
  announced?: Iterable<string>,
  onAnnounced?: (key: string) => void,
  arrivals?: { known?: Iterable<string>; onChanged?: (keys: string[]) => void },
): InviteWatcher => new InviteWatcher(announced, onAnnounced, arrivals, { now: () => NOW });

const event = (overrides: Partial<NormalizedCalendarEvent> = {}): NormalizedCalendarEvent => ({
  id: 'evt',
  calendarIds: ['me@work.com'],
  summary: 'Design review',
  webUrl: 'https://www.google.com/calendar/event?eid=ABC',
  created: null,
  updated: null,
  startTime: new Date('2026-09-16T09:00:00Z'),
  endTime: new Date('2026-09-16T10:00:00Z'),
  isAllDay: false,
  myResponseStatus: 0,
  attendees: [],
  reminders: 'unknown',
  ...overrides,
});

describe('isPendingInvite', () => {
  it('is true only when invited and unanswered', () => {
    expect(isPendingInvite(event({ myResponseStatus: 0 }))).toBe(true);
    expect(isPendingInvite(event({ myResponseStatus: 3 }))).toBe(false);
    // Seeing someone else's meeting on a shared calendar is not an invitation.
    expect(isPendingInvite(event({ myResponseStatus: 'notInvited' }))).toBe(false);
  });
});

describe('inviteKey', () => {
  it('treats a recurring series as one invitation', () => {
    // Google marks the whole series needsAction; keying per occurrence would announce
    // one banner a week for a year.
    const a = event({ seriesId: 'series', instanceId: 'series_R20260916T090000' });
    const b = event({ seriesId: 'series', instanceId: 'series_R20260923T090000' });
    expect(inviteKey(a, 'src')).toBe(inviteKey(b, 'src'));
  });
});

describe('InviteWatcher', () => {
  it('says nothing on the first poll, which is the existing backlog', () => {
    // A fresh install finds every unanswered invitation in the window. The user already
    // knows about those; banner-ing them all is indistinguishable from spam.
    const watcher = makeWatcher();
    expect(watcher.observe('src', [event({ id: 'old1' }), event({ id: 'old2' })])).toHaveLength(0);
  });

  it('announces an invitation that arrives later, once', () => {
    const watcher = makeWatcher();
    watcher.observe('src', [event({ id: 'old' })]);

    const fresh = watcher.observe('src', [event({ id: 'old' }), event({ id: 'new' })]);
    expect(fresh.map((f) => f.event.id)).toEqual(['new']);
    expect(watcher.observe('src', [event({ id: 'old' }), event({ id: 'new' })])).toHaveLength(0);
  });

  it('does not replay the backlog after a restart', () => {
    const key = inviteKey(event(), 'src');
    const watcher = makeWatcher([key]);
    expect(watcher.observe('src', [event()])).toHaveLength(0);
  });

  it('reports each announced key so it can be persisted', () => {
    const seen: string[] = [];
    const watcher = makeWatcher([], (k) => seen.push(k));
    // Seeded keys are recorded too: they must not re-announce after a restart.
    watcher.observe('src', [event()]);
    expect(seen).toEqual([inviteKey(event(), 'src')]);
  });

  it('counts what is outstanding, for the Dock badge', () => {
    const watcher = makeWatcher();
    watcher.observe('src', [event({ id: 'a' }), event({ id: 'b' })]);
    expect(watcher.pendingCount()).toBe(2);
  });

  it('clears an invitation answered elsewhere', () => {
    const watcher = makeWatcher();
    watcher.observe('src', [event()]);
    expect(watcher.pendingCount()).toBe(1);

    // Accepted on a phone, so the next poll reports it as accepted.
    watcher.observe('src', [event({ myResponseStatus: 3 })]);
    expect(watcher.pendingCount()).toBe(0);
  });

  it('clears a declined series whose later occurrences still read needsAction', () => {
    const watcher = makeWatcher();
    const occurrence = (id: string, daysAhead: number, myResponseStatus: number) =>
      event({
        id,
        seriesId: 's',
        myResponseStatus,
        startTime: new Date(NOW + daysAhead * 86_400_000),
        endTime: new Date(NOW + daysAhead * 86_400_000 + 3_600_000),
      });

    // Declining a recurring invitation answers the series, but Google leaves some later
    // occurrences needsAction. They are the same answered invitation, not new ones.
    watcher.observe('src', [occurrence('s_1', 1, 0)]);
    expect(watcher.pendingCount()).toBe(1);

    watcher.observe('src', [
      occurrence('s_1', 1, 1),
      occurrence('s_2', 8, 0),
      occurrence('s_3', 15, 0),
    ]);
    expect(watcher.pendingCount()).toBe(0);
  });

  it('does not resurrect an answered series on a later poll', () => {
    const watcher = makeWatcher();
    const declined = event({
      id: 's_1',
      seriesId: 's',
      myResponseStatus: 1,
      startTime: new Date(NOW + 86_400_000),
      endTime: new Date(NOW + 90_000_000),
    });
    const residual = event({
      id: 's_2',
      seriesId: 's',
      startTime: new Date(NOW + 8 * 86_400_000),
      endTime: new Date(NOW + 8 * 86_400_000 + 3_600_000),
    });

    watcher.observe('src', [declined]);
    expect(watcher.observe('src', [declined, residual])).toHaveLength(0);
    expect(watcher.pendingCount()).toBe(0);
  });

  it('keeps an answered and read series from coming back unread', () => {
    const watcher = makeWatcher();
    const occurrence = (id: string, daysAhead: number, myResponseStatus: number) =>
      event({
        id,
        seriesId: 's',
        myResponseStatus,
        startTime: new Date(NOW + daysAhead * 86_400_000),
        endTime: new Date(NOW + daysAhead * 86_400_000 + 3_600_000),
      });

    watcher.observe('src', []);
    const [invite] = watcher.observe('src', [occurrence('s_1', 1, 0)]);
    watcher.markRead(invite.key);

    // Replying to the one occurrence resolves the series key, and Google keeps the rest
    // needsAction. They must not be announced again, or the read invitation comes back.
    watcher.resolve(invite.key);
    expect(watcher.observe('src', [occurrence('s_1', 1, 1), occurrence('s_2', 8, 0)])).toHaveLength(
      0,
    );
    expect(watcher.newArrivalCount()).toBe(0);
    expect(watcher.observe('src', [occurrence('s_1', 1, 1), occurrence('s_2', 8, 0)])).toHaveLength(
      0,
    );
  });

  it('keeps one-off invitations independent of each other', () => {
    const watcher = makeWatcher();
    // A one-off has no series to inherit a response from, so an answered one must not
    // settle an unanswered one on the same calendar.
    watcher.observe('src', []);
    expect(
      watcher.observe('src', [event({ id: 'a', myResponseStatus: 1 }), event({ id: 'b' })]),
    ).toHaveLength(1);
    expect(watcher.pendingCount()).toBe(1);
  });

  it('announces a genuine re-invitation to a series answered before', () => {
    const watcher = makeWatcher();
    watcher.observe('src', []);
    watcher.observe('src', [event({ seriesId: 's' })]);
    watcher.observe('src', [event({ seriesId: 's', myResponseStatus: 3 })]);
    // Organiser changes the meeting and re-invites: this must not be swallowed.
    expect(watcher.observe('src', [event({ seriesId: 's' })])).toHaveLength(1);
  });

  it('keeps sources independent', () => {
    const watcher = makeWatcher();
    watcher.observe('google', [event({ id: 'g' })]);
    watcher.observe('eventkit', [event({ id: 'k' })]);
    expect(watcher.pendingCount()).toBe(2);

    watcher.observe('eventkit', []);
    expect(watcher.pendingCount()).toBe(1);
  });

  it('clears immediately when answered from a banner', () => {
    const watcher = makeWatcher();
    watcher.observe('src', []);
    const [invite] = watcher.observe('src', [event()]);
    watcher.resolve(invite.key);
    expect(watcher.pendingCount()).toBe(0);
  });

  it('drops a removed account without touching the others', () => {
    const watcher = makeWatcher();
    watcher.observe('google:a', [event({ id: 'a1' }), event({ id: 'a2' })]);
    watcher.observe('google:b', [event({ id: 'b1' })]);
    expect(watcher.pendingCount()).toBe(3);

    watcher.forget('google:a');
    expect(watcher.pendingCount()).toBe(1);
    expect(watcher.pending().map((p) => p.sourceId)).toEqual(['google:b']);
  });

  it('counts only invitations that arrived, not the backlog it seeded', () => {
    const watcher = makeWatcher();
    // First look absorbs two silently: they are not news, so they are not arrivals.
    watcher.observe('src', [event({ id: 'a' }), event({ id: 'b' })]);
    expect(watcher.pendingCount()).toBe(2);
    expect(watcher.newArrivalCount()).toBe(0);

    watcher.observe('src', [event({ id: 'a' }), event({ id: 'b' }), event({ id: 'c' })]);
    expect(watcher.pendingCount()).toBe(3);
    expect(watcher.newArrivalCount()).toBe(1);
  });

  it('drops an arrival once it is answered', () => {
    const watcher = makeWatcher();
    watcher.observe('src', []);
    watcher.observe('src', [event()]);
    expect(watcher.newArrivalCount()).toBe(1);

    watcher.observe('src', [event({ myResponseStatus: 3 })]);
    expect(watcher.newArrivalCount()).toBe(0);
  });

  it('drops an arrival answered from a banner, before the next poll', () => {
    const watcher = makeWatcher();
    watcher.observe('src', []);
    const [invite] = watcher.observe('src', [event()]);
    watcher.resolve(invite.key);
    expect(watcher.newArrivalCount()).toBe(0);
  });

  it('drops the arrivals of a removed account', () => {
    const watcher = makeWatcher();
    watcher.observe('google:a', []);
    watcher.observe('google:b', []);
    watcher.observe('google:a', [event({ id: 'a1' })]);
    watcher.observe('google:b', [event({ id: 'b1' })]);
    expect(watcher.newArrivalCount()).toBe(2);

    watcher.forget('google:a');
    expect(watcher.newArrivalCount()).toBe(1);
  });

  it('marks every arrival read on request, without answering them', () => {
    const watcher = makeWatcher();
    watcher.observe('src', []);
    watcher.observe('src', [event({ id: 'a' }), event({ id: 'b' })]);
    expect(watcher.newArrivalCount()).toBe(2);

    watcher.acknowledge();
    expect(watcher.newArrivalCount()).toBe(0);
    // Marking them read is not answering them.
    expect(watcher.pendingCount()).toBe(2);
  });

  it('counts an invitation that arrives after the rest were marked read', () => {
    const watcher = makeWatcher();
    watcher.observe('src', []);
    watcher.observe('src', [event({ id: 'a' })]);
    watcher.acknowledge();

    watcher.observe('src', [event({ id: 'a' }), event({ id: 'b' })]);
    expect(watcher.newArrivalCount()).toBe(1);
  });

  it('marks read only the source the dropdown was showing', () => {
    const watcher = makeWatcher();
    watcher.observe('google:a', []);
    watcher.observe('google:b', []);
    watcher.observe('google:a', [event({ id: 'a1' })]);
    watcher.observe('google:b', [event({ id: 'b1' })]);

    watcher.acknowledge('google:a');
    expect(watcher.newArrivalCount()).toBe(1);
  });

  it('reports the arrivals so the badge survives a restart', () => {
    let saved: string[] = [];
    const watcher = makeWatcher([], undefined, { onChanged: (keys) => (saved = keys) });
    watcher.observe('src', []);
    watcher.observe('src', [event()]);
    expect(saved).toEqual([inviteKey(event(), 'src')]);

    // Restarting re-seeds the source silently, so the count has to come from what was
    // saved rather than from the window.
    const restarted = makeWatcher([], undefined, { known: saved });
    restarted.observe('src', [event()]);
    expect(restarted.newArrivalCount()).toBe(1);
  });

  it('drops an invitation once its meeting has finished', () => {
    const watcher = makeWatcher();
    watcher.observe('src', [event()]);
    expect(watcher.pendingCount()).toBe(1);

    // Same invitation, read back after the meeting ended. Answering it changes nothing
    // anyone can act on, so it stops being something the user owes a reply to.
    const finished = event({
      startTime: new Date(NOW - 7_200_000),
      endTime: new Date(NOW - 3_600_000),
    });
    watcher.observe('src', [finished]);
    expect(watcher.pendingCount()).toBe(0);
  });

  it('keeps a series whose next occurrence is still to come', () => {
    const watcher = makeWatcher();
    const past = event({
      seriesId: 's',
      id: 's_1',
      startTime: new Date(NOW - 7_200_000),
      endTime: new Date(NOW - 3_600_000),
    });
    const next = event({
      seriesId: 's',
      id: 's_2',
      startTime: new Date(NOW + 3_600_000),
      endTime: new Date(NOW + 7_200_000),
    });
    watcher.observe('src', [past, next]);
    expect(watcher.pendingCount()).toBe(1);
  });

  it('dates a series by its next occurrence, not its last', () => {
    const watcher = makeWatcher();
    const soon = event({
      seriesId: 's',
      id: 's_2',
      startTime: new Date(NOW + 3_600_000),
      endTime: new Date(NOW + 7_200_000),
    });
    const far = event({
      seriesId: 's',
      id: 's_52',
      startTime: new Date(NOW + 31_536_000_000),
      endTime: new Date(NOW + 31_539_600_000),
    });
    // The expansion yields a year of occurrences, and the row has to say when the
    // meeting next is rather than when the series runs out.
    watcher.observe('src', [far, soon]);
    expect(watcher.pending()[0].event.id).toBe('s_2');
  });

  it('marks one arrival read and leaves the others counted', () => {
    const watcher = makeWatcher();
    watcher.observe('src', []);
    watcher.observe('src', [event({ id: 'a' }), event({ id: 'b' })]);
    expect(watcher.newArrivalCount()).toBe(2);

    watcher.markRead(inviteKey(event({ id: 'a' }), 'src'));
    expect(watcher.newArrivalCount()).toBe(1);
    // Read, not answered: it stays in the list so it can still be replied to.
    expect(watcher.pendingCount()).toBe(2);
  });

  it('seeds a re-added account rather than announcing its backlog', () => {
    const watcher = makeWatcher();
    watcher.observe('google:a', [event()]);
    watcher.forget('google:a');
    // Signed back in with the same invitation still unanswered: it is not news.
    expect(watcher.observe('google:a', [event()])).toHaveLength(0);
    expect(watcher.pendingCount()).toBe(1);
  });
});
