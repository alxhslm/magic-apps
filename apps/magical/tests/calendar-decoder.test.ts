import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  stripXssiGuard,
  parsePrefetchEventRangeResponse,
  parseEventTuple,
  CalendarSessionExpiredError,
  CalendarDecodeError,
  RESPONSE_ACCEPTED,
  RESPONSE_DECLINED,
} from '../src/calendar-decoder';

describe('calendar-decoder', () => {
  const fixturesDir = path.join(__dirname, 'fixtures');
  const validFixturePath = path.join(fixturesDir, 'calendar-web-prefetcheventrange.json');
  const unauthFixturePath = path.join(fixturesDir, 'calendar-web-401-unauthenticated.json');

  it('strips anti-XSSI guard correctly', () => {
    expect(stripXssiGuard(")]}'\n\n[1, 2, 3]")).toBe('[1, 2, 3]');
    expect(stripXssiGuard(")]}'[1, 2, 3]")).toBe('[1, 2, 3]');
    expect(stripXssiGuard('[1, 2, 3]')).toBe('[1, 2, 3]');
  });

  it('identifies unauthenticated 401 response and throws CalendarSessionExpiredError', () => {
    const rawUnauth = fs.readFileSync(unauthFixturePath, 'utf8');
    expect(() => parsePrefetchEventRangeResponse(rawUnauth)).toThrow(CalendarSessionExpiredError);
  });

  it('parses real measured fixture into normalized calendar events', () => {
    const rawValid = fs.readFileSync(validFixturePath, 'utf8');
    const result = parsePrefetchEventRangeResponse(rawValid);

    expect(result.syncToken).toBe('REDACTED_SYNC_TOKEN_BASE64_BLOB');
    expect(result.calendars).toHaveLength(2);
    expect(result.calendars[0].id).toBe('user_primary@example.com');
    expect(result.calendars[0].eventCount).toBe(2);
    expect(result.calendars[1].id).toBe('team_secondary@group.calendar.google.com');
    expect(result.calendars[1].eventCount).toBe(2);

    expect(result.events).toHaveLength(4);

    // Event 1. The sanitiser replaced its summary with a meeting's, but the fields it
    // left alone -- `[82]` 13, `[81]` 22 and a contact id at `[83]` -- are the signature
    // of a contact birthday, so it is filed on the Birthdays calendar. This is what the
    // fixture's own note means by adequate for decoder tests and misleading for field
    // discovery: read the summary here and you learn the wrong thing.
    const event1 = result.events[0];
    expect(event1.id).toBe('event_id_001_alpha');
    expect(event1.calendarIds).toEqual(['birthdays@birthdays.google.com']);
    expect(event1.summary).toBe('Team Standup & Planning');
    expect(event1.webUrl).toContain('REDACTED_EID_001');
    expect(event1.organizerEmail).toBe('user_primary@example.com');
    expect(event1.recurrenceRule).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    expect(event1.isAllDay).toBe(false);
    expect(event1.startTime.getTime()).toBe(1789027200000);
    expect(event1.endTime.getTime()).toBe(1789030800000);

    // Event 2 (Review with timezone)
    const event2 = result.events[1];
    expect(event2.id).toBe('event_id_002_beta');
    expect(event2.summary).toBe('Product Architecture Review');
    expect(event2.organizerEmail).toBe('organizer@example.com');
    expect(event2.timezone).toBe('Europe/London');
    expect(event2.startTime.getTime()).toBe(1789045200000);
    expect(event2.endTime.getTime()).toBe(1789056000000);
    expect(event2.calendarName).toBe('Taylor');

    // Event 3 (Sprint Retrospective)
    const event3 = result.events[2];
    expect(event3.id).toBe('event_id_003_gamma');
    expect(event3.calendarIds).toEqual(['team_secondary@group.calendar.google.com']);
    expect(event3.calendarName).toBe('Engineering Team');
    expect(event3.summary).toBe('Sprint Retrospective');
    expect(event3.recurrenceRule).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2');

    // Event 4: the bare timestamp form, which is how an all-day entry arrives.
    const event4 = result.events[3];
    expect(event4.id).toBe('event_id_004_allday');
    expect(event4.isAllDay).toBe(true);
    expect(event4.timezone).toBeUndefined();
  });

  it('puts an invitation on the calendar it came back under, not the organiser’s', () => {
    // `[34]` names the calendar holding the event's canonical copy. On an invitation that
    // is the organiser's, so it must not be read as the calendar this copy sits on.
    // The committed fixture cannot show this: every one of its events was organised by
    // the account holder, so `[34][0]` equals the block id throughout. Measured on a live
    // account, 678 of 770 tuples under one primary calendar disagreed.
    const invitation = new Array(85).fill(null);
    invitation[0] = 'invite_evt';
    invitation[34] = ['organiser@example.com', 'Someone Else', null, true];
    invitation[35] = [null, [1789660620000], 'Europe/London'];
    invitation[36] = [null, [1789662420000], 'Europe/London'];

    const decoded = parseEventTuple(invitation, 'user_primary@example.com');
    expect(decoded?.calendarIds).toEqual(['user_primary@example.com']);
    // The name at `[34][1]` belongs to the organiser's calendar, so it is dropped rather
    // than labelling the user's own calendar with it.
    expect(decoded?.calendarName).toBeUndefined();
  });

  it('keeps the calendar name when the event was organised on that same calendar', () => {
    const result = parsePrefetchEventRangeResponse(fs.readFileSync(validFixturePath, 'utf8'));
    expect(result.events[2].calendarIds).toEqual(['team_secondary@group.calendar.google.com']);
    expect(result.events[2].calendarName).toBe('Engineering Team');
  });

  it('decodes a birthday, whose start carries the year of birth', () => {
    // A contact birthday is an annual all-day event dated to the year the person was
    // born, so a decade-wide plausibility window rejects it — and one rejected event
    // throws away the whole account's payload.
    const birthday = new Array(85).fill(null);
    birthday[0] = 'birthday_evt';
    birthday[35] = [Date.UTC(1961, 8, 26)];
    birthday[36] = [Date.UTC(1961, 8, 27)];

    const decoded = parseEventTuple(birthday, 'cal');
    expect(decoded?.startTime.getUTCFullYear()).toBe(1961);
    expect(decoded?.isAllDay).toBe(true);
  });

  it('still throws for a timestamp no calendar would hold', () => {
    const ancient = new Array(85).fill(null);
    ancient[0] = 'ancient_evt';
    ancient[35] = [Date.UTC(1200, 0, 1)];
    ancient[36] = [Date.UTC(1200, 0, 2)];

    expect(() => parseEventTuple(ancient, 'cal')).toThrow(CalendarDecodeError);
  });

  it('reads all-day from the timestamp form rather than a flag', () => {
    // Measured across 221 live events: every bare-form event lasted a whole number of
    // days and no zoned-form one did. There is no boolean all-day flag on the wire;
    // `[32]` looks like one but is true for timed meetings too, so both tuples set it.
    const timed = new Array(85).fill(null);
    timed[0] = 'timed_evt';
    timed[32] = true;
    timed[35] = [null, [1789660620000], 'Europe/London'];
    timed[36] = [null, [1789662420000], 'Europe/London'];

    const allDay = new Array(85).fill(null);
    allDay[0] = 'all_day_evt';
    allDay[32] = true;
    allDay[35] = [1789171200000];
    allDay[36] = [1789257600000];

    expect(parseEventTuple(timed, 'cal')?.isAllDay).toBe(false);
    expect(parseEventTuple(allDay, 'cal')?.isAllDay).toBe(true);
  });

  it('handles empty or malformed events gracefully without throwing', () => {
    expect(parseEventTuple([])).toBeNull();
    expect(parseEventTuple([null, 0])).toBeNull();
    expect(parseEventTuple(['only_id'])).toBeNull();
  });

  it('drops an event the wire marks as deleted, however complete it looks', () => {
    // A deletion normally arrives as a short tuple that the length check skips, but the
    // same status can ride on a full-length one. Decoding that as an event would draw the
    // meeting the user cancelled.
    const deleted = new Array(85).fill(null);
    deleted[0] = 'deleted_evt';
    deleted[1] = 2;
    deleted[5] = 'Cancelled stand-up';
    deleted[35] = [null, [1789660620000], 'Europe/London'];
    deleted[36] = [null, [1789662420000], 'Europe/London'];

    expect(parseEventTuple(deleted, 'cal')).toBeNull();
  });

  it('parses tombstone tuples with isCancelled flag when includeTombstones is enabled', () => {
    // Short deletion tuple
    const shortTombstone = ['standup_20261002T084000Z', 2];
    const decodedShort = parseEventTuple(shortTombstone, 'cal', undefined, undefined, true);
    expect(decodedShort?.isCancelled).toBe(true);
    expect(decodedShort?.seriesId).toBe('standup');
    expect(decodedShort?.id).toBe('standup_20261002T084000Z');

    // Full-length deletion tuple
    const fullTombstone = new Array(85).fill(null);
    fullTombstone[0] = 'standup_20261003T084000Z';
    fullTombstone[1] = 2;
    fullTombstone[13] = 'standup';
    fullTombstone[35] = [null, [1789660620000], 'Europe/London'];
    fullTombstone[36] = [null, [1789662420000], 'Europe/London'];
    const decodedFull = parseEventTuple(fullTombstone, 'cal', undefined, undefined, true);
    expect(decodedFull?.isCancelled).toBe(true);
    expect(decodedFull?.seriesId).toBe('standup');
  });

  it('parses EXDATE exception rules in tuple[IDX.recurrence]', () => {
    const tuple = new Array(85).fill(null);
    tuple[0] = 'rec_master';
    tuple[12] = ['RRULE:FREQ=DAILY;COUNT=5', 'EXDATE:20261002T084000Z', 'EXDATE:20261004T084000Z'];
    tuple[35] = [null, [1789660620000], 'Europe/London'];
    tuple[36] = [null, [1789662420000], 'Europe/London'];

    const decoded = parseEventTuple(tuple, 'cal');
    expect(decoded?.recurrenceRule).toBe('RRULE:FREQ=DAILY;COUNT=5');
    expect(decoded?.recurrenceExceptions).toEqual([
      'EXDATE:20261002T084000Z',
      'EXDATE:20261004T084000Z',
    ]);
  });

  it('folds tombstones so deletions win over live copies of the same occurrence', () => {
    const live = new Array(85).fill(null);
    live[0] = 'standup_20261002T084000Z';
    live[5] = 'Standup';
    live[35] = [null, [1789660620000], 'Europe/London'];
    live[36] = [null, [1789662420000], 'Europe/London'];

    const tombstone = ['standup_20261002T084000Z', 2];

    const payload = [
      [
        'prefetcheventrangeaction.perr',
        0,
        ['sync-token', [['me@work.com', [live, tombstone], [null, null, 20352, 20386], 2]]],
      ],
    ];
    const wire = `)]}'\n\n${JSON.stringify(payload)}`;

    const result = parsePrefetchEventRangeResponse(wire);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].isCancelled).toBe(true);
  });

  it('throws rather than guessing when the pinned timestamp indices are empty', () => {
    // A tuple whose timestamps sit at 37/38 instead of 35/36. An earlier decoder scanned
    // for a plausible pair and "healed"; that turns a loud failure into a wrong alert
    // time, so the contract is now to throw. See
    // docs/magical/calendar-wire-format.md#pinned-indices.
    const shifted = new Array(85).fill(null);
    shifted[0] = 'shifted_evt_123';
    shifted[5] = 'Shifted Event Title';
    shifted[37] = [1789027200000];
    shifted[38] = [1789030800000];

    expect(() => parseEventTuple(shifted, 'cal_test')).toThrow(CalendarDecodeError);
  });

  it('throws rather than returning null when a live event has no id at IDX.id', () => {
    const noId = new Array(85).fill(null);
    noId[5] = 'Event Without ID';
    noId[35] = [1789027200000];
    noId[36] = [1789030800000];

    expect(() => parseEventTuple(noId, 'cal_test')).toThrow(CalendarDecodeError);
  });

  it('throws CalendarDecodeError when an event in a prefetch response cannot be read', () => {
    const valid = new Array(85).fill(null);
    valid[0] = 'valid_evt';
    valid[35] = [1789027200000];
    valid[36] = [1789030800000];

    const broken = new Array(85).fill(null);
    broken[0] = 'broken_evt';
    // Timestamps missing / shifted
    broken[37] = [1789027200000];
    broken[38] = [1789030800000];

    const payload = [
      ['prefetcheventrangeaction.perr', 0, ['sync-token', [['me@work.com', [valid, broken]]]]],
    ];
    const wire = `)]}'\n\n${JSON.stringify(payload)}`;

    expect(() => parsePrefetchEventRangeResponse(wire)).toThrow(CalendarDecodeError);
  });

  it('accepts calendar block with accessRole at calEntry[3] regardless of event count', () => {
    const valid = new Array(85).fill(null);
    valid[0] = 'valid_evt';
    valid[35] = [1789027200000];
    valid[36] = [1789030800000];

    // calEntry carries accessRole at index 3 (e.g. 4 for owner), which should not be
    // misidentified as a claimed count.
    const payload = [
      [
        'prefetcheventrangeaction.perr',
        0,
        ['sync-token', [['me@work.com', [valid], [null, null, 20352, 20386], 4]]],
      ],
    ];
    const wire = `)]}'\n\n${JSON.stringify(payload)}`;

    const result = parsePrefetchEventRangeResponse(wire);
    expect(result.events).toHaveLength(1);
    expect(result.calendars[0].eventCount).toBe(1);
  });

  it('reads location, description and the recurrence instance id', () => {
    const tuple = new Array(85).fill(null);
    tuple[0] = 'evt_1';
    tuple[5] = 'Weekly sync';
    tuple[7] = 'Example Room 4 (8)';
    tuple[13] = 'base_series_id';
    tuple[55] = 'base_series_id_R20260907T100000';
    tuple[64] = [null, '<p>Notes</p>'];
    tuple[35] = [1789027200000];
    tuple[36] = [1789030800000];

    const parsed = parseEventTuple(tuple, 'cal');
    expect(parsed?.location).toBe('Example Room 4 (8)');
    expect(parsed?.description).toBe('<p>Notes</p>');
    expect(parsed?.seriesId).toBe('base_series_id');
  });

  it('does not take the series anchor as an occurrence id', () => {
    // Both occurrences of one weekly series, three weeks apart. `[55]` is the same on
    // each; only `[0]` separates them, so anything keyed on an occurrence -- an alert,
    // above all -- has to come from there.
    const occurrence = (id: string) => {
      const tuple = new Array(85).fill(null);
      tuple[0] = id;
      tuple[13] = 'base_series_id';
      tuple[55] = 'base_series_id_R20260907T100000';
      tuple[35] = [1789027200000];
      tuple[36] = [1789030800000];
      return parseEventTuple(tuple, 'cal');
    };

    const first = occurrence('base_series_id_20260907T100000Z');
    const fourth = occurrence('base_series_id_20260928T100000Z');
    expect(first?.instanceId).toBeUndefined();
    expect(fourth?.instanceId).toBeUndefined();
    expect(first?.id).not.toBe(fourth?.id);
  });

  it("reads an event's own notification times when it overrides its calendar's", () => {
    const tuple = new Array(85).fill(null);
    tuple[0] = 'evt';
    tuple[33] = [
      [2, 15],
      [2, 5],
    ];
    tuple[35] = [1789027200000];
    tuple[36] = [1789030800000];
    expect(parseEventTuple(tuple, 'cal')?.reminders).toEqual([15, 5]);
  });

  it('ignores an email reminder, which is not a banner this app can show', () => {
    const tuple = new Array(85).fill(null);
    tuple[0] = 'evt';
    tuple[33] = [[0, 10]];
    tuple[35] = [1789027200000];
    tuple[36] = [1789030800000];
    // Falls back rather than going silent: the email method rests on one measured event,
    // and being wrong about it would lose alerts.
    expect(parseEventTuple(tuple, 'cal')?.reminders).toBe('unknown');
  });

  it('reports reminders as unknown, because the range payloads do not carry them', () => {
    const tuple = new Array(85).fill(null);
    tuple[0] = 'evt_2';
    tuple[35] = [1789027200000];
    tuple[36] = [1789030800000];
    // 'unknown' and 'none' must stay distinct: the scheduler applies the global lead
    // time only for 'none'.
    expect(parseEventTuple(tuple, 'cal')?.reminders).toBe('unknown');
  });

  it("reads the account holder's own response from the attendee list", () => {
    const t = new Array(85).fill(null);
    t[0] = 'evt';
    t[19] = 2; // Not the participation status, despite appearances. Must be ignored.
    t[20] = [
      ['me@work.com', null, null, null, null, 0, null, null, null, true],
      ['other@work.com', null, null, null, null, 3],
    ];
    t[35] = [1789027200000];
    t[36] = [1789030800000];
    expect(parseEventTuple(t, 'cal')?.myResponseStatus).toBe(0);
  });

  it('reports notInvited when the user is not a guest', () => {
    const t = new Array(85).fill(null);
    t[0] = 'evt';
    t[20] = [['someone@work.com', null, null, null, null, 3]];
    t[35] = [1789027200000];
    t[36] = [1789030800000];
    // Distinct from "invited and unanswered": an event on a shared calendar must never
    // be badged as awaiting a reply.
    expect(parseEventTuple(t, 'cal')?.myResponseStatus).toBe('notInvited');
  });

  it('ignores the flag naming the calendar this copy lives on', () => {
    // `[8]` marks the attendee matching the calendar, which on a shared calendar is the
    // calendar rather than the user. Reading it would hand every event on a team
    // calendar a response status belonging to somebody else.
    const t = new Array(85).fill(null);
    t[0] = 'evt';
    t[20] = [['team@group.calendar.google.com', null, null, null, null, 0, null, null, true]];
    t[35] = [1789027200000];
    t[36] = [1789030800000];
    expect(parseEventTuple(t, 'team@group.calendar.google.com')?.myResponseStatus).toBe(
      'notInvited',
    );
  });

  describe('conference resolution', () => {
    const base = () => {
      const t = new Array(85).fill(null);
      t[0] = 'evt';
      t[35] = [1789027200000];
      t[36] = [1789030800000];
      return t;
    };

    it('prefers the structured video entry point over dial-in entries', () => {
      const t = base();
      t[57] = [
        [
          [5, 'https://tel.meet/abc', null, '123'],
          [3, 'https://meet.google.com/abc-defg-hij', 'abc-defg-hij'],
        ],
      ];
      expect(parseEventTuple(t, 'cal')?.conferenceUrl).toBe('https://meet.google.com/abc-defg-hij');
    });

    it('falls back to the bare Meet field', () => {
      const t = base();
      t[45] = 'https://meet.google.com/xyz-abcd-efg';
      expect(parseEventTuple(t, 'cal')?.conferenceUrl).toBe('https://meet.google.com/xyz-abcd-efg');
    });

    it('picks the Teams join link out of a body containing decoys', () => {
      const t = base();
      t[7] = 'Microsoft Teams Meeting';
      t[64] = [
        null,
        '<p>Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_YzU0 ' +
          'Options: https://teams.microsoft.com/meetingOptions/ ' +
          'Dial in: https://dialin.teams.microsoft.com/sample_dialin_id</p>',
      ];
      expect(parseEventTuple(t, 'cal')?.conferenceUrl).toBe(
        'https://teams.microsoft.com/l/meetup-join/19%3ameeting_YzU0',
      );
    });

    it('unwraps the Google redirector around a body link', () => {
      const t = base();
      t[64] = [
        null,
        '<a href="https://www.google.com/url?q=https%3A%2F%2Fzoom.us%2Fj%2F12345&amp;source=gmail">join</a>',
      ];
      expect(parseEventTuple(t, 'cal')?.conferenceUrl).toBe('https://zoom.us/j/12345');
    });

    it('returns nothing when no joinable link is present', () => {
      const t = base();
      t[64] = [null, '<p>Bring a laptop. See https://example.com/agenda</p>'];
      expect(parseEventTuple(t, 'cal')?.conferenceUrl).toBeUndefined();
    });
  });
});

describe('attendees', () => {
  const withAttendees = (raw: unknown) => {
    const t = new Array(85).fill(null);
    t[0] = 'evt';
    t[20] = raw;
    t[35] = [1789027200000];
    t[36] = [1789030800000];
    return parseEventTuple(t, 'cal');
  };

  it('reads addresses and per-attendee response status', () => {
    const parsed = withAttendees([
      ['organiser@work.com', null, null, null, null, 3],
      ['guest@work.com', null, null, null, null, 0],
    ]);
    expect(parsed?.attendees).toEqual([
      { email: 'organiser@work.com', responseStatus: 3, ownsThisCalendar: false },
      { email: 'guest@work.com', responseStatus: 0, ownsThisCalendar: false },
    ]);
  });

  it('is an empty list, not undefined, for an event with no guests', () => {
    expect(withAttendees(null)?.attendees).toEqual([]);
  });

  it('skips entries that are not addresses', () => {
    expect(withAttendees([[null, 1], ['not-an-email', null], ['ok@work.com']])?.attendees).toEqual([
      { email: 'ok@work.com', responseStatus: 0, ownsThisCalendar: false },
    ]);
  });
});

describe("an event's own colour", () => {
  const MANGO_LABEL = '0c000928-bf13-44dd-a1b4-9de20ce3f307';

  const responseWith = (labelOnEvent: string | null, table: Array<[string, number]>) => {
    const tuple = new Array(95).fill(null);
    tuple[0] = 'evt';
    tuple[5] = 'Deep work';
    tuple[91] = labelOnEvent;
    tuple[35] = [1789027200000];
    tuple[36] = [1789030800000];
    const overrides = [
      ['me@work.com', table.map(([uuid, id]) => [null, uuid, id, null, null, null, false, [id]])],
    ];
    const payload = [
      ['prefetcheventrangeaction.perr', 0, ['token', [['me@work.com', [tuple]]], overrides]],
    ];
    return `)]}'\n\n${JSON.stringify(payload)}`;
  };

  it('is the colour its label resolves to', () => {
    // Nothing in the event tuple carries a colour; it names a label, and the table
    // beside the calendar blocks says which colour that label is.
    const parsed = parsePrefetchEventRangeResponse(responseWith(MANGO_LABEL, [[MANGO_LABEL, 6]]));
    expect(parsed.events[0].colorHex).toBe('#F09300');
  });

  it('is absent when the event overrides nothing, so the calendar decides', () => {
    const parsed = parsePrefetchEventRangeResponse(responseWith(null, [[MANGO_LABEL, 6]]));
    expect(parsed.events[0].colorHex).toBeUndefined();
  });

  it('is absent when the label is not in the table', () => {
    const parsed = parsePrefetchEventRangeResponse(responseWith(MANGO_LABEL, []));
    expect(parsed.events[0].colorHex).toBeUndefined();
  });

  it('is absent for a colour id the palette does not have', () => {
    const parsed = parsePrefetchEventRangeResponse(responseWith(MANGO_LABEL, [[MANGO_LABEL, 99]]));
    expect(parsed.events[0].colorHex).toBeUndefined();
  });
});

describe('the link an event held by several calendars carries', () => {
  const eid = (payload: string) => Buffer.from(payload, 'utf8').toString('base64url');
  const copy = (calendarId: string) => {
    const t = new Array(95).fill(null);
    t[0] = 'evt';
    t[2] = `https://www.google.com/calendar/event?eid=${eid(`evt ${calendarId}`)}`;
    t[35] = [1789027200000];
    t[36] = [1789030800000];
    return t;
  };
  const response = (blocks: string[]) => {
    const payload = [
      ['prefetcheventrangeaction.perr', 0, ['token', blocks.map((id) => [id, [copy(id)]])]],
    ];
    return `)]}'\n\n${JSON.stringify(payload)}`;
  };
  const readEid = (url: string) => {
    const raw = /[?&]eid=([^&]*)/.exec(url)?.[1];
    return raw ? Buffer.from(decodeURIComponent(raw), 'base64url').toString('utf8') : null;
  };

  it("is the account's own, whichever calendar the response listed first", () => {
    // Each copy's `eid` names its own calendar, and the chip Google draws for the user
    // carries the one for the calendar they see it under.
    const parsed = parsePrefetchEventRangeResponse(
      response(['recruiting@group.calendar.google.com', 'me@work.com']),
      'me@work.com',
    );
    expect(readEid(parsed.events[0].webUrl)).toBe('evt me@work.com');
  });

  it('is left alone for an event the account has no copy of', () => {
    const parsed = parsePrefetchEventRangeResponse(
      response(['recruiting@group.calendar.google.com']),
      'me@work.com',
    );
    expect(readEid(parsed.events[0].webUrl)).toBe('evt recruiting@group.calendar.google.com');
  });
});

describe('entries folded into the primary calendar', () => {
  const entry = (eventType: number | null) => {
    const t = new Array(95).fill(null);
    t[0] = 'evt';
    t[5] = "Colleague's birthday";
    t[82] = eventType;
    t[35] = [1789027200000];
    t[36] = [1789030800000];
    return parseEventTuple(t, 'me@work.com');
  };

  it('puts a contact birthday on the Birthdays calendar, and not on the primary', () => {
    // It arrives in the primary's block; nothing but `[82]` says it is a birthday. The
    // primary has to go, or hiding Birthdays leaves every birthday on screen.
    expect(entry(13)?.calendarIds).toEqual(['birthdays@birthdays.google.com']);
  });

  it('puts a task on the Tasks calendar, and not on the primary', () => {
    expect(entry(9)?.calendarIds).toEqual(['tasks@tasks.google.com']);
  });

  it('leaves a focus time block on the primary calendar, not on Tasks', () => {
    expect(entry(7)?.calendarIds).toEqual(['me@work.com']);
    expect(entry(7)?.eventType).toBe(7);
  });

  it('reads a time-blocked task as a task, though the wire types it as focus time', () => {
    // Google Tasks materialises a task's block as a focus-time event, so `[82]` cannot tell
    // the two apart; the Tasks id at `[61][1][6][0]` can, and only a materialised block has
    // one. Measured on both sides against a live account.
    const t = new Array(95).fill(null);
    t[0] = 'evt';
    t[5] = 'Book the dentist';
    t[35] = [1789027200000];
    t[36] = [1789030800000];
    t[82] = 7;
    t[61] = [null, [false, null, null, null, null, null, ['1nMUVZWQztQzmWdU']]];

    const parsed = parseEventTuple(t, 'me@work.com');
    expect(parsed?.eventType).toBe(9);
    expect(parsed?.calendarIds).toEqual(['tasks@tasks.google.com']);
  });

  it('leaves a slot 61 that names no task as the focus time block it is', () => {
    // Five tuples on a Workspace account carry a non-null slot 61 and no id, so the id is
    // what is read rather than the slot itself.
    const t = new Array(95).fill(null);
    t[0] = 'evt';
    t[5] = 'Deep work';
    t[35] = [1789027200000];
    t[36] = [1789030800000];
    t[82] = 7;
    t[61] = [null, null, null, null, null, [null, []]];

    const parsed = parseEventTuple(t, 'me@work.com');
    expect(parsed?.eventType).toBe(7);
    expect(parsed?.calendarIds).toEqual(['me@work.com']);
  });

  it('leaves an ordinary event on the calendar it came under', () => {
    // An event merely named "... birthday" is not one; a title heuristic would move it.
    expect(entry(0)?.calendarIds).toEqual(['me@work.com']);
    expect(entry(null)?.calendarIds).toEqual(['me@work.com']);
  });

  it('says what kind of entry it is, for the kinds that stay where they are', () => {
    // An out-of-office block and a working-location entry sit on the account's own
    // calendar and are ordinary by every other measure, so the calendar id cannot tell
    // a surface how to draw them.
    expect(entry(3)?.eventType).toBe(3);
    expect(entry(7)?.eventType).toBe(7);
    expect(entry(10)?.eventType).toBe(10);
    // A working location the user named themselves arrives as its own kind, and a surface
    // that only knew about 10 drew it as an ordinary appointment.
    expect(entry(11)?.eventType).toBe(11);
    expect(entry(13)?.eventType).toBe(13);
    expect(entry(null)?.eventType).toBe(0);
  });
});

describe('one event held by several calendars', () => {
  /** A response carrying `blocks` as `[calendarId, homeCalendarId | null]` pairs. */
  const responseWith = (blocks: Array<[string, string | null]>) => {
    const tuple = (home: string | null) => {
      const t = new Array(85).fill(null);
      t[0] = 'evt';
      t[5] = 'ML Deep-dive';
      t[34] = home === null ? null : [home, 'Engineering Team', null, true];
      t[35] = [1789027200000];
      t[36] = [1789030800000];
      return t;
    };
    const payload = [
      [
        'prefetcheventrangeaction.perr',
        0,
        ['token', blocks.map(([calId, home]) => [calId, [tuple(home)]])],
      ],
    ];
    return `)]}'\n\n${JSON.stringify(payload)}`;
  };

  it('returns it once, not once per calendar', () => {
    // One object per event, whatever the copies. Two would arm the same alert twice and
    // count the same meeting twice in the Dock badge.
    const parsed = parsePrefetchEventRangeResponse(
      responseWith([
        ['me@work.com', null],
        ['colleague@work.com', null],
      ]),
      'me@work.com',
    );
    expect(parsed.events).toHaveLength(1);
  });

  it('names every calendar that held it, in the order they came back', () => {
    const shared = 'team@group.calendar.google.com';
    const parsed = parsePrefetchEventRangeResponse(
      responseWith([
        ['me@work.com', null],
        [shared, shared],
      ]),
      'me@work.com',
    );
    expect(parsed.events[0].calendarIds).toEqual(['me@work.com', shared]);
  });

  it('names them in the order they came back whichever way round that is', () => {
    const shared = 'team@group.calendar.google.com';
    const parsed = parsePrefetchEventRangeResponse(
      responseWith([
        [shared, shared],
        ['me@work.com', null],
      ]),
      'me@work.com',
    );
    expect(parsed.events[0].calendarIds).toEqual([shared, 'me@work.com']);
  });

  it("keeps an interview on the recruiting calendar and on the attendee's own", () => {
    // Measured on a live account: an interview at 13:30 the user had accepted came back
    // under both. Choosing one of them breaks the other case — filed on the recruiting
    // calendar it vanishes when they hide it, filed on their own the recruiting calendar
    // can no longer be hidden.
    const recruiting = 'recruiting@group.calendar.google.com';
    const tuple = (home: string | null) => {
      const t = new Array(95).fill(null);
      t[0] = 'evt';
      t[5] = 'Team Sync';
      t[20] = [['me@work.com', null, null, null, null, 3]];
      t[34] = home === null ? null : [home, null, null, true];
      t[35] = [1789027200000];
      t[36] = [1789030800000];
      return t;
    };
    const payload = [
      [
        'prefetcheventrangeaction.perr',
        0,
        [
          'token',
          [
            [recruiting, [tuple(recruiting)]],
            ['me@work.com', [tuple(null)]],
          ],
        ],
      ],
    ];
    const parsed = parsePrefetchEventRangeResponse(
      `)]}'\n\n${JSON.stringify(payload)}`,
      'me@work.com',
    );
    expect(parsed.events[0].calendarIds).toEqual([recruiting, 'me@work.com']);
  });

  it('names a calendar once however many copies arrived under it', () => {
    const parsed = parsePrefetchEventRangeResponse(
      responseWith([
        ['me@work.com', null],
        ['me@work.com', null],
      ]),
      'me@work.com',
    );
    expect(parsed.events[0].calendarIds).toEqual(['me@work.com']);
  });

  it('takes the calendar name from whichever copy carries it', () => {
    // Only the copy under the calendar the event lives on states the name, and that copy
    // is not always the first to arrive.
    const shared = 'team@group.calendar.google.com';
    const parsed = parsePrefetchEventRangeResponse(
      responseWith([
        ['me@work.com', null],
        [shared, shared],
      ]),
      'me@work.com',
    );
    expect(parsed.events[0].calendarName).toBe('Engineering Team');
  });

  it('still counts what each calendar returned', () => {
    const parsed = parsePrefetchEventRangeResponse(
      responseWith([
        ['me@work.com', null],
        ['colleague@work.com', null],
      ]),
      'me@work.com',
    );
    expect(parsed.calendars).toEqual([
      { id: 'me@work.com', eventCount: 1 },
      { id: 'colleague@work.com', eventCount: 1 },
    ]);
  });
});

describe("an edited series' anchor occurrence", () => {
  const SERIES = 'example_series_id';
  const UID = `${SERIES}@google.com`;
  const START = 1790325600000;

  const occurrence = (id: string) => {
    const t = new Array(85).fill(null);
    t[0] = id;
    t[5] = 'Team stand-up';
    t[13] = SERIES;
    t[18] = UID;
    t[35] = [START];
    t[36] = [START + 3_600_000];
    return t;
  };

  /** A response holding every tuple in one calendar block, as the wire sends them. */
  const responseWith = (tuples: unknown[][]) => {
    const payload = [['prefetcheventrangeaction.perr', 0, ['token', [['me@work.com', tuples]]]]];
    return `)]}'\n\n${JSON.stringify(payload)}`;
  };

  it('is one event, not the materialised copy and the recurrence copy', () => {
    // Measured on a live account: the Friday after a recurring stand-up was edited, Google
    // returned one occurrence under both spellings, in a single calendar block. Keyed by
    // id they stood as two meetings and the user saw the stand-up twice.
    const parsed = parsePrefetchEventRangeResponse(
      responseWith([
        occurrence(`${SERIES}_20260925T084000Z`),
        occurrence(`${SERIES}_R20260925T084000`),
      ]),
      'me@work.com',
    );
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].calendarIds).toEqual(['me@work.com']);
  });

  it('keeps the materialised copy and its move when the two disagree on the time', () => {
    // Measured on a live account: one occurrence had been dragged half an hour later.
    // The wire returned the recurrence copy at the time the rule gave and the materialised
    // copy at the time the user moved it to; the materialised one is the edit and wins.
    const recurrence = occurrence(`${SERIES}_R20260925T084000`);
    const moved = occurrence(`${SERIES}_20260925T084000Z`);
    moved[35] = [START + 1_800_000];
    moved[36] = [START + 5_400_000];
    const parsed = parsePrefetchEventRangeResponse(
      responseWith([recurrence, moved]),
      'me@work.com',
    );
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].id).toBe(`${SERIES}_20260925T084000Z`);
    expect(parsed.events[0].startTime.getTime()).toBe(START + 1_800_000);
  });

  it('still prefers the materialised copy when the recurrence copy carries a trailing Z', () => {
    // The wire spells the recurrence id without the `Z`, but the two regexes that read that id
    // for its slot tolerate one, and `ANCHOR_ID` in `calendar-recurrence.ts` now reads a `Z`
    // spelling as the recurrence one too. So `RECURRENCE_ID` has to recognise it here as well,
    // or the copy that still holds the rule's time wins over the one carrying the move.
    const recurrence = occurrence(`${SERIES}_R20260925T084000Z`);
    const moved = occurrence(`${SERIES}_20260925T084000Z`);
    moved[35] = [START + 1_800_000];
    moved[36] = [START + 5_400_000];
    const parsed = parsePrefetchEventRangeResponse(
      responseWith([recurrence, moved]),
      'me@work.com',
    );
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].id).toBe(`${SERIES}_20260925T084000Z`);
    expect(parsed.events[0].startTime.getTime()).toBe(START + 1_800_000);
  });

  it('leaves two occurrences of the series apart, as they share a uid', () => {
    const next = occurrence(`${SERIES}_20261002T084000Z`);
    next[35] = [START + 604_800_000];
    next[36] = [START + 608_400_000];
    const parsed = parsePrefetchEventRangeResponse(
      responseWith([occurrence(`${SERIES}_20260925T084000Z`), next]),
      'me@work.com',
    );
    expect(parsed.events).toHaveLength(2);
  });

  it('leaves the master apart from an instance that starts at the same time', () => {
    // Folding these would drop the rule and end the series at its first occurrence.
    const master = occurrence(SERIES);
    master[12] = ['RRULE:FREQ=WEEKLY;BYDAY=FR'];
    const parsed = parsePrefetchEventRangeResponse(
      responseWith([master, occurrence(`${SERIES}_20260925T084000Z`)]),
      'me@work.com',
    );
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events.some((e) => e.recurrenceRule === 'RRULE:FREQ=WEEKLY;BYDAY=FR')).toBe(true);
  });
});

describe("the account holder's own response", () => {
  /** One event as it arrives under `block`, with the block's owner flagged as the wire does. */
  const copyUnder = (block: string, accountEmail?: string) => {
    const attendee = (email: string, responseStatus: number) => {
      const row = new Array(10).fill(null);
      row[0] = email;
      row[5] = responseStatus;
      row[9] = email === block;
      return row;
    };
    const t = new Array(85).fill(null);
    t[0] = 'evt';
    t[20] = [
      attendee('me@work.com', RESPONSE_ACCEPTED),
      attendee('colleague@work.com', RESPONSE_DECLINED),
    ];
    t[35] = [1789027200000];
    t[36] = [1789030800000];
    return parseEventTuple(t, block, accountEmail);
  };

  it('is read from the account holder, not from whoever owns the calendar', () => {
    const onTheirCalendar = copyUnder('colleague@work.com', 'me@work.com');
    expect(onTheirCalendar?.myResponseStatus).toBe(RESPONSE_ACCEPTED);
  });

  it('agrees across every calendar the same event comes back under', () => {
    const mine = copyUnder('me@work.com', 'me@work.com');
    const theirs = copyUnder('colleague@work.com', 'me@work.com');
    expect(theirs?.myResponseStatus).toBe(mine?.myResponseStatus);
  });

  it('is notInvited when the account holder is not on the guest list', () => {
    expect(copyUnder('colleague@work.com', 'someone-else@work.com')?.myResponseStatus).toBe(
      'notInvited',
    );
  });
});
