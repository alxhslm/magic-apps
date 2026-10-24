import { describe, it, expect } from 'vitest';
import { parseCalendarIdsFromRequestBody } from '../src/calendar-identity';

const body = (payload: unknown) => `f.req=${encodeURIComponent(JSON.stringify(payload))}&cwuik=10`;

describe('parseCalendarIdsFromRequestBody', () => {
  it('reads the calendar list the real client sends', () => {
    expect(
      parseCalendarIdsFromRequestBody(
        body([
          [
            ['me@work.com', 'x@import.calendar.google.com'],
            [null, null, 20352, 20386],
          ],
        ]),
      ),
    ).toEqual(['me@work.com', 'x@import.calendar.google.com']);
  });

  it('reads a request that names only a subscribed calendar', () => {
    // Observed in capture. Callers must union across requests; this one has no primary.
    expect(
      parseCalendarIdsFromRequestBody(
        body([[['en-gb.uk#holiday@group.v.calendar.google.com'], [null, null, 20352, 20386]]]),
      ),
    ).toEqual(['en-gb.uk#holiday@group.v.calendar.google.com']);
  });

  it('returns nothing for bodies it cannot parse, rather than guessing', () => {
    expect(parseCalendarIdsFromRequestBody('')).toEqual([]);
    expect(parseCalendarIdsFromRequestBody('f.req=not-json')).toEqual([]);
    expect(parseCalendarIdsFromRequestBody('cwuik=10')).toEqual([]);
    expect(parseCalendarIdsFromRequestBody(body([[[], [null, null, 1, 2]]]))).toEqual([]);
  });

  it('ignores non-calendar entries in the list slot', () => {
    expect(parseCalendarIdsFromRequestBody(body([[[null, 3, 'not-a-calendar']]]))).toEqual([]);
  });
});

describe('calendar id accumulation', () => {
  /**
   * Mirrors what AccountsManager does with each observation. The union is the point:
   * the client asks for a single subscribed calendar as readily as the whole set.
   */
  const merge = (known: string[], observed: string[]): string[] => {
    const merged = [...known];
    for (const id of observed) if (!merged.includes(id)) merged.push(id);
    return merged;
  };

  it('keeps the account calendar when a later request names only a holiday feed', () => {
    const first = parseCalendarIdsFromRequestBody(
      body([[['me@work.com', 'team@group.calendar.google.com']]]),
    );
    const second = parseCalendarIdsFromRequestBody(
      body([[['en-gb.uk#holiday@group.v.calendar.google.com']]]),
    );

    expect(merge(merge([], first), second)).toEqual([
      'me@work.com',
      'team@group.calendar.google.com',
      'en-gb.uk#holiday@group.v.calendar.google.com',
    ]);
  });

  it('is idempotent across repeated observations', () => {
    const ids = parseCalendarIdsFromRequestBody(body([[['me@work.com']]]));
    expect(merge(merge([], ids), ids)).toEqual(['me@work.com']);
  });
});
