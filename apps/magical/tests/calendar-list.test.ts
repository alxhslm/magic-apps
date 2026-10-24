import { describe, it, expect } from 'vitest';
import {
  extractRawCalendarList,
  extractGoogleApiKey,
  mergeCalendarList,
  resolveCalendarList,
} from '../src/calendar-list.js';

/**
 * One calendar in the shape `sync.sync` returns, with only the indices this module reads
 * filled in. Built rather than captured: a real response is 24kB of one account's diary.
 */
function calendar(options: {
  id: string;
  generatedName?: string;
  renamedTo?: string;
  displayName?: string;
  colourIndex?: string;
  colourValue?: number | string;
  colourKind?: number | string;
  reminders?: Array<[number, number]> | null;
}) {
  const entry = new Array(20).fill(null);
  entry[0] = options.id;
  entry[1] = [options.generatedName ?? options.id];
  entry[2] = [
    options.displayName ?? null,
    null,
    null,
    null,
    options.colourIndex ?? null,
    options.colourValue ?? null,
    0,
    options.colourKind ?? null,
  ];
  entry[4] = options.reminders ?? null;
  entry[14] = options.renamedTo ?? null;
  return [null, entry];
}

/** The page's `initialdata`, with the calendar list where Google puts it. */
const initialData = (calendars: unknown[]) => {
  const root = new Array(40).fill(null);
  const section = new Array(3).fill(null);
  section[1] = calendars;
  root[39] = [null, [null, null, section]];
  return root;
};

describe('the calendar list in a sync response', () => {
  it('reads a calendar Google named itself', () => {
    const [cal] = extractRawCalendarList(
      initialData([
        calendar({
          id: 'en-gb.uk#holiday@group.v.calendar.google.com',
          generatedName: 'Holidays in the United Kingdom',
        }),
      ]),
    );
    expect(cal.name).toBe('Holidays in the United Kingdom');
  });

  it('prefers the name the user gave it', () => {
    // An account's own calendar is generated as its address; the user's own name for it
    // is what Google shows, and what the popover should.
    const [cal] = extractRawCalendarList(
      initialData([
        calendar({ id: 'me@work.com', generatedName: 'me@work.com', renamedTo: 'Taylor Smith' }),
      ]),
    );
    expect(cal.name).toBe('Taylor Smith');
  });

  it('prefers the name the user gave a calendar over the generated one', () => {
    // A subscribed feed is generated with the URL it was added from as its name; the name
    // the user sees sits beside the colour.
    const [cal] = extractRawCalendarList(
      initialData([
        calendar({
          id: 'abc@import.calendar.google.com',
          generatedName: 'https://connect.garmin.com/modern/calendar/export/1d1b',
          displayName: 'Garmin Connect',
        }),
      ]),
    );
    expect(cal.name).toBe('Garmin Connect');
  });

  it("puts the account's own name for its calendar above both", () => {
    const [cal] = extractRawCalendarList(
      initialData([
        calendar({
          id: 'me@work.com',
          generatedName: 'me@work.com',
          displayName: 'ignored',
          renamedTo: 'Taylor Smith',
        }),
      ]),
    );
    expect(cal.name).toBe('Taylor Smith');
  });

  it('reads the notifications a calendar applies by default', () => {
    const [cal] = extractRawCalendarList(
      initialData([calendar({ id: 'me@work.com', reminders: [[2, 10]] })]),
    );
    expect(cal.defaultReminderMinutes).toEqual([10]);
  });

  it('ignores an email default, which is not a banner this app can show', () => {
    const [cal] = extractRawCalendarList(
      initialData([calendar({ id: 'me@work.com', reminders: [[0, 30]] })]),
    );
    expect(cal.defaultReminderMinutes).toEqual([]);
  });

  it('returns nothing for a page that carries no calendar list', () => {
    expect(extractRawCalendarList(new Array(40).fill(null))).toEqual([]);
  });

  it('returns nothing rather than throwing for a shape it does not know', () => {
    // This runs in a preload against a document Google controls, and an exception there
    // costs the account its calendars for the whole session.
    expect(extractRawCalendarList({ not: 'an array' })).toEqual([]);
    expect(extractRawCalendarList(null)).toEqual([]);
  });
});

describe('the colour a calendar is painted', () => {
  const colourOf = (options: Parameters<typeof calendar>[0]) =>
    resolveCalendarList(extractRawCalendarList(initialData([calendar(options)])))[0].colourHex;

  it('resolves a preset through the palette, not through the number beside it', () => {
    // The number is that colour in Google's old palette -- Peacock reads `#9FE1E7` --
    // and painting it would put every preset calendar in the wrong colour.
    expect(
      colourOf({ id: 'me@work.com', colourIndex: '14', colourValue: 10478055, colourKind: 2 }),
    ).toBe('#039BE5');
  });

  it('takes a custom colour from the number, which is the colour itself', () => {
    expect(
      colourOf({ id: 'me@work.com', colourIndex: '7', colourValue: 0x03e596, colourKind: 1 }),
    ).toBe('#03E596');
  });

  it('takes a custom colour when colourValue and colourKind arrive as strings', () => {
    expect(
      colourOf({ id: 'me@work.com', colourIndex: '7', colourValue: '255382', colourKind: '1' }),
    ).toBe('#03E596');
  });

  it('takes a custom colour when colourValue is a hex string', () => {
    expect(
      colourOf({ id: 'me@work.com', colourIndex: '7', colourValue: '#03E596', colourKind: 1 }),
    ).toBe('#03E596');
    expect(
      colourOf({ id: 'me@work.com', colourIndex: '7', colourValue: '0x03E596', colourKind: 1 }),
    ).toBe('#03E596');
  });

  it('resolves a custom colour when colourKind is omitted but colourValue is provided', () => {
    expect(colourOf({ id: 'me@work.com', colourValue: 0x03e596 })).toBe('#03E596');
    expect(colourOf({ id: 'me@work.com', colourValue: '15844367' })).toBe('#F1C40F');
  });

  it('ignores the nearest-preset index a custom colour still carries', () => {
    // A custom colour records the preset closest to it, which is not the colour.
    expect(
      colourOf({ id: 'me@work.com', colourIndex: '7', colourValue: 0x03e596, colourKind: 1 }),
    ).not.toBe('#009688');
  });

  it('has no colour when the payload states neither kind', () => {
    expect(colourOf({ id: 'me@work.com' })).toBeNull();
  });

  it('has no colour for a preset the palette does not have', () => {
    expect(colourOf({ id: 'me@work.com', colourIndex: '99', colourKind: 2 })).toBeNull();
  });
});

describe('folding a sync list into what the account already had', () => {
  const incoming = (over: Partial<{ id: string; name: string; colourHex: string | null }> = {}) => [
    {
      id: over.id ?? 'cal_1',
      name: over.name ?? 'Work',
      colourHex: over.colourHex === undefined ? '#039BE5' : over.colourHex,
      defaultReminderMinutes: [],
    },
  ];

  it('takes the name and colour the sync states', () => {
    const [cal] = mergeCalendarList(
      [{ id: 'cal_1', name: 'Stale', color: '#000' }],
      incoming(),
      '#FFF',
    );
    expect(cal).toMatchObject({ name: 'Work', color: '#039BE5' });
  });

  it('keeps the name it already had for a feed the page names by URL', () => {
    // The rendered sidebar has the name the user sees; the page's own data has the URL
    // the feed was added from. A URL here means "no name", not a new one.
    const [cal] = mergeCalendarList(
      [{ id: 'abc@import.calendar.google.com', name: 'Garmin Connect', color: '#000' }],
      [
        {
          id: 'abc@import.calendar.google.com',
          name: 'https://connect.garmin.com/modern/calendar/export/1d1b',
          colourHex: '#039BE5',
          defaultReminderMinutes: [],
        },
      ],
      '#FFF',
    );
    expect(cal.name).toBe('Garmin Connect');
  });

  it('names a subscribed feed after the calendar, not the URL it came from', () => {
    // Google stores the subscription URL as the name of an imported feed and shows
    // something else; a URL in the popover reads as a bug.
    const [cal] = mergeCalendarList(
      [],
      [
        {
          id: 'abc@import.calendar.google.com',
          name: 'https://connect.garmin.com/modern/calendar/export/1d1b',
          colourHex: '#039BE5',
          defaultReminderMinutes: [],
        },
      ],
      '#FFF',
    );
    expect(cal.name).not.toContain('https://');
  });

  it('keeps the colour it had when this build cannot resolve the new one', () => {
    // An unresolved colour means Google's palette has moved, not that the calendar has
    // no colour, so losing the one that worked would be the worse answer.
    const [cal] = mergeCalendarList(
      [{ id: 'cal_1', name: 'Work', color: '#123456' }],
      incoming({ colourHex: null }),
      '#FFF',
    );
    expect(cal.color).toBe('#123456');
  });

  it("falls back to the account's colour for a calendar it has never seen", () => {
    const [cal] = mergeCalendarList([], incoming({ colourHex: null }), '#FFF');
    expect(cal.color).toBe('#FFF');
  });

  it('drops a calendar the account no longer has', () => {
    const merged = mergeCalendarList(
      [
        { id: 'cal_1', name: 'Work', color: '#000' },
        { id: 'gone', name: 'Gone', color: '#000' },
      ],
      incoming(),
      '#FFF',
    );
    expect(merged.map((c) => c.id)).toEqual(['cal_1']);
  });

  it('keeps Birthdays and Tasks, which this list never mentions', () => {
    // Google shows both in its sidebar and serves neither as a calendar, so they are
    // absent from every list it sends. A contact's birthday is filed on one of them, and
    // dropping it would leave that birthday with no name and the account's colour.
    const merged = mergeCalendarList(
      [
        { id: 'birthdays@birthdays.google.com', name: 'Birthdays', color: '#7986CB' },
        { id: 'tasks@tasks.google.com', name: 'Tasks', color: '#039BE5' },
      ],
      incoming(),
      '#FFF',
    );
    expect(merged.map((c) => c.id)).toEqual([
      'cal_1',
      'birthdays@birthdays.google.com',
      'tasks@tasks.google.com',
    ]);
    expect(merged.find((c) => c.id === 'birthdays@birthdays.google.com')?.color).toBe('#7986CB');
  });
});

describe("Google's browser key in WIZ_global_data", () => {
  it('reads the one AIza value the page carries', () => {
    // Built from parts so a scan for a committed `AIza...` value finds nothing here.
    const fakeKey = ['AIza', 'SyFAKEKEYFORUNITtests00000000000000'].join('');
    const script = `window.WIZ_global_data = {"FdrFJe":"-4879","uRKQOb":"${fakeKey}"};`;
    expect(extractGoogleApiKey(script)).toBe(fakeKey);
  });

  it('returns null when the page carries no key', () => {
    expect(extractGoogleApiKey('window.WIZ_global_data = {"FdrFJe":"-4879"};')).toBeNull();
  });

  it('returns null for a missing or empty script', () => {
    expect(extractGoogleApiKey(undefined)).toBeNull();
    expect(extractGoogleApiKey(null)).toBeNull();
    expect(extractGoogleApiKey('')).toBeNull();
  });
});
