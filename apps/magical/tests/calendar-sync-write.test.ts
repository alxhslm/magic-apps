import { describe, it, expect } from 'vitest';
import {
  buildDeleteChange,
  buildRsvpChange,
  extractToken,
  isErrorResponse,
  resolveCalendarId,
  SyncCalendarActionDriver,
} from '../src/calendar-actions/sync-driver.js';

/**
 * These shapes are copied from Google's own `sync.sync` writes, captured live. They are
 * the authority: the read decoder's field numbers are for a different message, and a
 * wrong slot is a write that returns 200 and changes nothing.
 */
describe('buildDeleteChange', () => {
  it('populates only the delete field with an empty list', () => {
    const change = buildDeleteChange('evt-1', 'me@example.com');

    const delta = change[2][0][1];
    expect(delta[0]).toBe('evt-1');
    const fieldBlock = delta[3][0];
    expect(fieldBlock).toHaveLength(21);
    expect(fieldBlock.slice(0, 20).every((slot) => slot === null)).toBe(true);
    expect(fieldBlock[20]).toEqual([]);
  });

  it('names the calendar beside the delta and carries a sequence', () => {
    const change = buildDeleteChange('evt-1', 'me@example.com');

    expect(change[2][1]).toBe('me@example.com');
    expect(typeof change[0]).toBe('number');
    expect(change[5]).toBe(change[0]);
  });
});

describe('buildRsvpChange', () => {
  it('addresses the occurrence and carries the response, times and zone', () => {
    const change = buildRsvpChange(
      'series_20261021T130000Z',
      'me@example.com',
      1,
      1792587600000,
      1792589400000,
      'Europe/London',
    );

    const delta = change[2][0][1];
    expect(delta[0]).toBe('series_20261021T130000Z');
    const fieldBlock = delta[3][0];
    expect(fieldBlock).toHaveLength(42);
    expect(fieldBlock.slice(0, 41).every((slot) => slot === null)).toBe(true);

    const attendee = fieldBlock[41];
    expect(attendee[0]).toEqual([0, null, '', null, 0]);
    expect(attendee[1]).toEqual([
      [null, [1792587600000], 'Europe/London'],
      [null, [1792589400000], 'Europe/London'],
      0,
    ]);
    // The response tuple's leading number is the enum, and it is the only thing the
    // action changes; the rest is the occurrence's own state.
    expect(attendee[2]).toEqual([1, null, '', null, 0]);
  });

  it('encodes decline, tentative and accept as 1, 2 and 3', () => {
    const code = (response: number) => {
      const change = buildRsvpChange('occ', 'cal', response, 1, 2, 'UTC');
      return change[2][0][1][3][0][41][2][0];
    };
    expect(code(1)).toBe(1);
    expect(code(2)).toBe(2);
    expect(code(3)).toBe(3);
  });
});

describe('extractToken', () => {
  it('reads the next sync token out of an anti-XSSI guarded response', () => {
    const token = 'C' + 'a'.repeat(300);
    const body = `)]}'\n\n[["syncaction.sr",0,[null,["${token}",null,true]],…]]`;
    expect(extractToken(body)).toBe(token);
  });

  it('falls back to the longest base64 field when the slot has moved', () => {
    const token = 'B'.repeat(200);
    expect(extractToken(`[["unexpected", {"token":"${token}"}]]`)).toBe(token);
  });

  it('returns null for a body with nothing token-shaped', () => {
    expect(extractToken('[["syncaction.sr",0,[null,null]]]')).toBeNull();
  });
});

describe('task actions go through Google Tasks, not the calendar change', () => {
  const noGaia = new SyncCalendarActionDriver({
    getAccountContext: () => ({ id: 'a', partition: 'p' }),
  });

  it('declines a task delete rather than building a calendar change', async () => {
    // A calendar change naming a task id is accepted and does nothing, so the task path
    // must not fall through to it.
    expect(await noGaia.deleteEvent(undefined, 'a', 'eid', new Date(), true)).toBe('failed');
  });

  it('declines a task completion it cannot sign a Tasks write with', async () => {
    expect(await noGaia.setTaskCompleted(undefined, 'a', 'eid', new Date(), true)).toBe('failed');
  });

  it('declines a task write whose eid does not decode, without reading', async () => {
    const driver = new SyncCalendarActionDriver({
      getAccountContext: () => ({ id: 'a', partition: 'p', gaiaId: '111' }),
      tasksFetchImpl: async () => {
        throw new Error('the Tasks read must not be reached');
      },
    });
    expect(await driver.setTaskCompleted(undefined, 'a', 'not-an-eid', new Date(), true)).toBe(
      'failed',
    );
  });
});

describe('resolveCalendarId', () => {
  const account = { id: 'a', partition: 'p', email: 'me@example.com' };

  it("replaces the primary calendar's short eid form with the account address", () => {
    expect(resolveCalendarId('me@m', account)).toBe('me@example.com');
  });

  it('keeps a secondary calendar id, which is already full', () => {
    expect(resolveCalendarId('team@group.calendar.google.com', account)).toBe(
      'team@group.calendar.google.com',
    );
  });

  it('keeps the short form when the account has no address to replace it with', () => {
    expect(resolveCalendarId('me@m', { id: 'a', partition: 'p' })).toBe('me@m');
  });
});

describe('isErrorResponse', () => {
  it('treats the er envelope as an error even on a 200', () => {
    expect(isErrorResponse('[["er",null,null,null,null,400,null,null,null,3]]')).toBe(true);
  });

  it('accepts a completed sync round', () => {
    expect(isErrorResponse('[["syncaction.sr",0,[null,["token"]]]]')).toBe(false);
  });

  it('treats an unparseable body as an error rather than success', () => {
    expect(isErrorResponse('<html>403</html>')).toBe(true);
  });
});
