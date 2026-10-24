import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlertScheduler, alertKey, isAlertable, type ScheduledAlert } from '../src/alert-scheduler';
import { RESPONSE_DECLINED, type NormalizedCalendarEvent } from '../src/calendar-decoder';

const T0 = new Date('2026-09-15T09:00:00Z').getTime();

function event(overrides: Partial<NormalizedCalendarEvent> = {}): NormalizedCalendarEvent {
  return {
    id: 'evt',
    calendarIds: ['me@work.com'],
    summary: 'Standup',
    webUrl: '',
    created: null,
    updated: null,
    startTime: new Date(T0 + 10 * 60_000),
    endTime: new Date(T0 + 40 * 60_000),
    isAllDay: false,
    myResponseStatus: 3,
    reminders: 'unknown',
    ...overrides,
  };
}

function makeScheduler(opts: Partial<ConstructorParameters<typeof AlertScheduler>[0]> = {}) {
  const fired: ScheduledAlert[] = [];
  const scheduler = new AlertScheduler({
    leadMinutes: 5,
    onFire: (a) => fired.push(a),
    now: () => Date.now(),
    ...opts,
  });
  return { scheduler, fired };
}

describe("an event's own notification time", () => {
  it('is used instead of the global lead', () => {
    const { scheduler } = makeScheduler({ leadMinutes: 10 });
    // Starts at T0+10min; an 8-minute warning is due 2 minutes from now.
    scheduler.schedule('src', [event({ reminders: [8] })]);
    const [alert] = scheduler.pending();
    expect(alert.leadMinutes).toBe(8);
    expect(alert.fireAt.getTime()).toBe(T0 + 2 * 60_000);
  });

  it('takes the earliest when an event carries several', () => {
    const { scheduler } = makeScheduler({ leadMinutes: 10 });
    // Within the arming horizon: 20 minutes out, so a 15-minute warning is 5 away.
    scheduler.schedule('src', [
      event({ startTime: new Date(T0 + 20 * 60_000), reminders: [15, 5] }),
    ]);
    expect(scheduler.pending()[0].leadMinutes).toBe(15);
  });

  it('falls back to the global lead when the event states none', () => {
    const { scheduler } = makeScheduler({ leadMinutes: 7 });
    scheduler.schedule('src', [event({ startTime: new Date(T0 + 12 * 60_000) })]);
    expect(scheduler.pending()[0].leadMinutes).toBe(7);
  });

  it('is not disturbed when the global lead changes', () => {
    const { scheduler } = makeScheduler({ leadMinutes: 10 });
    const own = event({ startTime: new Date(T0 + 15 * 60_000), reminders: [8] });
    scheduler.schedule('src', [own]);
    scheduler.setLeadMinutes(30);
    scheduler.schedule('src', [own]);
    expect(scheduler.pending()[0].leadMinutes).toBe(8);
  });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('alertKey', () => {
  it('distinguishes occurrences of a recurring series', () => {
    // Every occurrence of a weekly standup shares an event id; keying on that alone
    // would alert once and stay silent for the rest of the year.
    const a = alertKey(event({ instanceId: 'series_R20260915T090000' }), 5, 'src');
    const b = alertKey(event({ instanceId: 'series_R20260922T090000' }), 5, 'src');
    expect(a).not.toBe(b);
  });

  it('treats a rescheduled meeting as a new alert', () => {
    const a = alertKey(event(), 5, 'src');
    const b = alertKey(event({ startTime: new Date(T0 + 60 * 60_000) }), 5, 'src');
    expect(a).not.toBe(b);
  });

  it('separates the same event arriving from two sources', () => {
    expect(alertKey(event(), 5, 'google:a')).not.toBe(alertKey(event(), 5, 'eventkit'));
  });
});

describe('isAlertable', () => {
  it('skips all-day events, which have no moment to be early for', () => {
    expect(isAlertable(event({ isAllDay: true }))).toBe(false);
  });

  it('still alerts on an unanswered invitation', () => {
    // It is on the calendar until it is not; silence is the wrong default for a meeting
    // about to start.
    expect(isAlertable(event({ myResponseStatus: 0 }))).toBe(true);
  });

  it('skips a meeting the user declined', () => {
    expect(isAlertable(event({ myResponseStatus: RESPONSE_DECLINED }))).toBe(false);
  });

  it('alerts on an unmeasured response code rather than guessing it means declined', () => {
    // `2` is presumably tentative and has never been observed. Dropping an alert on a
    // guess is a missed meeting; one extra banner is not.
    expect(isAlertable(event({ myResponseStatus: 2 }))).toBe(true);
  });

  it('alerts on an event the user is not a guest of', () => {
    expect(isAlertable(event({ myResponseStatus: 'notInvited' }))).toBe(true);
  });

  it('skips an event when every calendar holding it has its alerts disabled', () => {
    const e = event({ calendarIds: ['muted_cal'] });
    expect(isAlertable(e, ['muted_cal'])).toBe(false);
    expect(isAlertable(e, new Set(['muted_cal']))).toBe(false);
    expect(isAlertable(e, ['other_cal'])).toBe(true);
    expect(isAlertable(e, [])).toBe(true);
  });

  it('alerts on an event one of whose calendars is still on', () => {
    // A meeting the user is in sits on their own calendar as well as on the one that
    // created it; muting that one is not a request to miss the meeting.
    const e = event({ calendarIds: ['recruiting_cal', 'me@work.com'] });
    expect(isAlertable(e, ['recruiting_cal'])).toBe(true);
    expect(isAlertable(e, ['recruiting_cal', 'me@work.com'])).toBe(false);
  });
});

describe('AlertScheduler', () => {
  it('fires at the exact lead time, not on a tick boundary', () => {
    const { scheduler, fired } = makeScheduler();
    scheduler.schedule('src', [event()]);

    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired).toHaveLength(1);
    expect(fired[0].fireAt.getTime()).toBe(T0 + 5 * 60_000);
  });

  it('fires once even when scheduled repeatedly by successive polls', () => {
    const { scheduler, fired } = makeScheduler();
    for (let i = 0; i < 5; i++) scheduler.schedule('src', [event()]);
    vi.advanceTimersByTime(10 * 60_000);
    expect(fired).toHaveLength(1);
  });

  it('does not replay alerts already notified in an earlier run', () => {
    const key = alertKey(event(), 5, 'src');
    const { scheduler, fired } = makeScheduler({ alreadyNotified: [key] });
    scheduler.schedule('src', [event()]);
    vi.advanceTimersByTime(10 * 60_000);
    expect(fired).toHaveLength(0);
  });

  it('reports each fired key so it can be persisted', () => {
    const notified: string[] = [];
    const { scheduler } = makeScheduler({ onNotified: (k) => notified.push(k) });
    scheduler.schedule('src', [event()]);
    vi.advanceTimersByTime(10 * 60_000);
    expect(notified).toEqual([alertKey(event(), 5, 'src')]);
  });

  it('drops an alert when the meeting leaves the window', () => {
    const { scheduler, fired } = makeScheduler();
    scheduler.schedule('src', [event()]);
    expect(scheduler.pending()).toHaveLength(1);

    // Cancelled in Google, so it is absent from the next poll.
    scheduler.schedule('src', []);
    vi.advanceTimersByTime(10 * 60_000);
    expect(fired).toHaveLength(0);
  });

  it('leaves distant events unarmed for a later poll to pick up', () => {
    const { scheduler } = makeScheduler();
    scheduler.schedule('src', [event({ startTime: new Date(T0 + 6 * 60 * 60_000) })]);
    expect(scheduler.pending()).toHaveLength(0);
  });

  it('fires immediately for a meeting whose moment passed while asleep', () => {
    const { scheduler, fired } = makeScheduler();
    // Start 4 minutes out with a 5 minute lead: the alert moment is already a minute gone.
    scheduler.schedule('src', [event({ startTime: new Date(T0 + 4 * 60_000) })]);
    vi.advanceTimersByTime(0);
    expect(fired).toHaveLength(1);
  });

  it('stays silent for an alert that is long past', () => {
    const { scheduler, fired } = makeScheduler();
    scheduler.schedule('src', [event({ startTime: new Date(T0 - 40 * 60_000) })]);
    vi.advanceTimersByTime(60_000);
    expect(fired).toHaveLength(0);
  });

  it('drops a timer that fires on wake long after its moment', () => {
    // The timer's elapsed delay and the wall clock move independently after sleep: the
    // callback can run before `powerMonitor` emits resume, with the clock an hour ahead.
    let clock = T0;
    const { scheduler, fired } = makeScheduler({ now: () => clock });
    scheduler.schedule('src', [event()]);

    clock = T0 + 60 * 60_000;
    vi.advanceTimersByTime(5 * 60_000);

    expect(fired).toHaveLength(0);
  });

  it('posts one banner when a wake-triggered re-poll follows the late timer', () => {
    let clock = T0;
    const { scheduler, fired } = makeScheduler({ now: () => clock });
    scheduler.schedule('src', [event()]);

    clock = T0 + 6 * 60_000;
    vi.advanceTimersByTime(5 * 60_000);
    expect(fired).toHaveLength(1);

    // The resume handler reconciles and polls after the timer has already fired. Neither
    // may turn one meeting into two banners.
    scheduler.reconcile();
    scheduler.schedule('src', [event()]);
    vi.advanceTimersByTime(60 * 60_000);

    expect(fired).toHaveLength(1);
  });

  it('moves an armed alert with a meeting rescheduled by another device', () => {
    const { scheduler, fired } = makeScheduler();
    scheduler.schedule('src', [event()]);

    const moved = event({ startTime: new Date(T0 + 14 * 60_000) });
    scheduler.schedule('src', [moved]);

    // One alert, at the new moment: the old timer is not merely left beside the new one.
    expect(scheduler.pending()).toHaveLength(1);
    expect(scheduler.pending()[0].key).toBe(alertKey(moved, 5, 'src'));
    expect(scheduler.pending()[0].fireAt.getTime()).toBe(T0 + 9 * 60_000);

    vi.advanceTimersByTime(9 * 60_000);
    expect(fired).toHaveLength(1);
    expect(fired[0].event.startTime.getTime()).toBe(T0 + 14 * 60_000);
  });

  it('forgets an alert that reconcile finds too late', () => {
    const { scheduler, fired } = makeScheduler();
    scheduler.schedule('src', [event()]);

    // A wake an hour later clears the timer. Leaving the alert in `armed` would report it
    // as pending for ever, because schedule() keeps every key still in the window.
    vi.setSystemTime(T0 + 60 * 60_000);
    scheduler.reconcile();

    expect(scheduler.pending()).toHaveLength(0);
    vi.advanceTimersByTime(60_000);
    expect(fired).toHaveLength(0);
  });

  it('re-fires timers that a sleep left behind', () => {
    const { scheduler, fired } = makeScheduler();
    scheduler.schedule('src', [event()]);

    // setTimeout measures elapsed time, so a sleeping machine leaves timers behind the
    // wall clock. Jump the clock without running timers, as a resume does.
    vi.setSystemTime(T0 + 7 * 60_000);
    scheduler.reconcile();
    vi.advanceTimersByTime(0);

    expect(fired).toHaveLength(1);
  });

  it('snoozes a banner that has already fired, which is the real flow', () => {
    const { scheduler, fired } = makeScheduler();
    scheduler.schedule('src', [event()]);
    const key = scheduler.pending()[0].key;

    // The alert fires; the banner is on screen; the user presses Snooze.
    vi.advanceTimersByTime(5 * 60_000);
    expect(fired).toHaveLength(1);
    expect(scheduler.pending()).toHaveLength(0);

    expect(scheduler.snooze(key, 2)).toBe(true);
    vi.advanceTimersByTime(2 * 60_000);
    expect(fired).toHaveLength(2);
  });

  it('re-arms a snoozed alert without marking it done', () => {
    const { scheduler, fired } = makeScheduler();
    scheduler.schedule('src', [event()]);
    const key = scheduler.pending()[0].key;

    expect(scheduler.snooze(key, 2)).toBe(true);
    vi.advanceTimersByTime(2 * 60_000);
    expect(fired).toHaveLength(1);
  });

  it('re-arms everything when the lead time changes', () => {
    const { scheduler, fired } = makeScheduler();
    scheduler.schedule('src', [event()]);

    scheduler.setLeadMinutes(1);
    expect(scheduler.pending()).toHaveLength(0);
    scheduler.schedule('src', [event()]);

    vi.advanceTimersByTime(9 * 60_000 - 1);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired).toHaveLength(1);
    expect(fired[0].leadMinutes).toBe(1);
  });

  it('keeps sources independent when one of them empties', () => {
    const { scheduler, fired } = makeScheduler();
    scheduler.schedule('google', [event({ id: 'g1' })]);
    scheduler.schedule('eventkit', [event({ id: 'k1' })]);
    expect(scheduler.pending()).toHaveLength(2);

    // EventKit reports nothing; Google's alert must survive.
    scheduler.schedule('eventkit', []);
    vi.advanceTimersByTime(10 * 60_000);
    expect(fired.map((a) => a.event.id)).toEqual(['g1']);
  });

  it('stops ringing for an account that has been removed', () => {
    const { scheduler, fired } = makeScheduler();
    scheduler.schedule('google:a', [event({ id: 'a1' })]);
    scheduler.schedule('google:b', [event({ id: 'b1' })]);

    // Signing an account out stops its polls, so schedule() will never prune it.
    scheduler.forget('google:a');
    expect(scheduler.pending().map((a) => a.event.id)).toEqual(['b1']);

    vi.advanceTimersByTime(10 * 60_000);
    expect(fired.map((a) => a.event.id)).toEqual(['b1']);
  });

  it('cannot snooze an alert belonging to a removed account', () => {
    const { scheduler } = makeScheduler();
    scheduler.schedule('google:a', [event({ id: 'a1' })]);
    const key = alertKey(event({ id: 'a1' }), 5, 'google:a');
    vi.advanceTimersByTime(10 * 60_000);

    scheduler.forget('google:a');
    // The banner may still be on screen; re-arming it would ring for an account that
    // is no longer signed in.
    expect(scheduler.snooze(key, 5)).toBe(false);
  });
});
