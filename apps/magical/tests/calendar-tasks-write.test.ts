import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTaskMutationBody,
  resolveTaskId,
  writeTaskMutation,
} from '../src/calendar-actions/tasks-write.js';
import { SyncCalendarActionDriver } from '../src/calendar-actions/sync-driver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** A live account's own Tasks sync answer, the same fixture the poller decodes. */
const readFixture = fs.readFileSync(
  path.resolve(__dirname, 'fixtures/tasks-web-sync.json'),
  'utf8',
);

/** The fixture's task that is drawn on the calendar, and the event it is drawn as. */
const CALENDAR_EVENT_ID = '5bbhtg1mockevent000000000001';
const TASK_ID = 'task_mock_0000000001';

/**
 * A read whose account holds one task Google draws nowhere: a date-only task, which
 * carries no `record[23]` binding and so no Calendar event to be resolved through.
 */
const DATE_ONLY_TASK_ID = 'date-only-task-1';
const dateOnlyRead = JSON.stringify([
  [[[DATE_ONLY_TASK_ID, [null, 'Post the form', null, [2026, 10, 11]]]]],
]);

const GAIA = '100000000000000000001';

const taskRecord = (body: unknown[]): unknown[] => {
  const envelope = body[0] as unknown[];
  const changeSets = (envelope[1] as unknown[])[2] as unknown[];
  const changeSet = changeSets[0] as unknown[];
  const records = changeSet[0] as unknown[];
  return records[0] as unknown[];
};

/**
 * These shapes are copied from Google's own Tasks writes, captured live. They are the
 * authority: a wrong field number is a mutation that answers `200` and changes nothing.
 */
describe('buildTaskMutationBody', () => {
  it('addresses the task and sets completed with its timestamp', () => {
    const now = new Date('2026-10-06T12:00:00Z');
    const body = buildTaskMutationBody('complete', TASK_ID, GAIA, now);

    const record = taskRecord(body);
    expect(record).toHaveLength(10);
    expect(typeof record[0]).toBe('string');
    expect(record[1]).toBe(3);
    expect(record[2]).toBe(TASK_ID);
    expect(record[3]).toEqual([1]);

    const [mask, properties] = record[6] as [unknown[], unknown[]];
    // Field 1 is `completed`, field 5 its timestamp; the mask names both.
    expect(mask).toEqual([null, [1, 5]]);
    expect(properties[0]).toBe(1);
    expect(properties[4]).toEqual([now.getTime() / 1000, 0]);
  });

  it('clears completed by sending the mask against an empty properties message', () => {
    const body = buildTaskMutationBody('reopen', TASK_ID, GAIA);
    const record = taskRecord(body);

    const [mask, properties] = record[6] as [unknown[], unknown[]];
    // The same mask, against an empty properties message: that is what clears it.
    expect(mask).toEqual([null, [1, 5]]);
    expect(properties).toEqual([]);
  });

  it('marks a task deleted with a deleted-at timestamp', () => {
    const now = new Date('2026-10-06T12:00:00Z');
    const body = buildTaskMutationBody('delete', TASK_ID, GAIA, now);
    const record = taskRecord(body);

    const [mask, properties] = record[6] as [unknown[], unknown[]];
    // Field 6 is `deleted`, field 13 its timestamp.
    expect(mask).toEqual([null, [6, 13]]);
    expect(properties).toHaveLength(13);
    expect(properties[5]).toBe(1);
    expect(properties[12]).toEqual([now.getTime() / 1000, 0]);
  });

  it('pins the whole body, which is the construction measured against a live account', () => {
    const now = new Date('2026-10-06T12:00:00Z');
    const wire = (mutation: 'complete' | 'reopen' | 'delete') =>
      JSON.stringify(buildTaskMutationBody(mutation, 'task-1', '111', now)).replace(
        /"[A-Za-z0-9_-]{16}"/,
        '"RECORD-ID"',
      );

    expect(wire('complete')).toBe(
      '[[null,[[1791288000,0],null,[[[["RECORD-ID",3,"task-1",[1],null,null,' +
        '[[null,[1,5]],[1,null,null,null,[1791288000,0]]],null,null,[1791288000,0]]],[]]]]],' +
        'null,[null,["111"]],null,null]',
    );
    expect(wire('reopen')).toBe(
      '[[null,[[1791288000,0],null,[[[["RECORD-ID",3,"task-1",[1],null,null,' +
        '[[null,[1,5]],[]],null,null,[1791288000,0]]],[]]]]],' +
        'null,[null,["111"]],null,null]',
    );
    expect(wire('delete')).toBe(
      '[[null,[[1791288000,0],null,[[[["RECORD-ID",3,"task-1",[1],null,null,' +
        '[[null,[6,13]],[null,null,null,null,null,1,null,null,null,null,null,null,[1791288000,0]]],' +
        'null,null,[1791288000,0]]],[]]]]],null,[null,["111"]],null,null]',
    );
  });

  it('carries no list record, which the mutation does not need', () => {
    const envelope = buildTaskMutationBody('complete', TASK_ID, GAIA)[0] as unknown[];
    const changeSets = (envelope[1] as unknown[])[2] as unknown[];
    const changeSet = changeSets[0] as unknown[];
    expect((changeSet[0] as unknown[]).length).toBe(1);
  });

  it('stamps the envelope with the same modified-at tuple the record carries', () => {
    const body = buildTaskMutationBody('complete', TASK_ID, GAIA);
    const envelope = body[0] as unknown[];
    expect((envelope[1] as unknown[])[0]).toEqual(taskRecord(body)[9]);
  });

  it('names the account by its Gaia ID when it has one', () => {
    expect(buildTaskMutationBody('complete', TASK_ID, GAIA)[2]).toEqual([null, [GAIA]]);
    expect(buildTaskMutationBody('complete', TASK_ID)[2]).toBeNull();
  });
});

describe('resolveTaskId', () => {
  it('maps a Calendar event id to the Tasks id a write needs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(readFixture, { status: 200 }));
    const taskId = await resolveTaskId(
      { partition: 'p', gaiaId: GAIA, getSapisidImpl: async () => 'sapisid', fetchImpl },
      CALENDAR_EVENT_ID,
    );
    expect(taskId).toBe(TASK_ID);
  });

  it('resolves a task Google draws nowhere by its own Tasks id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(dateOnlyRead, { status: 200 }));
    const taskId = await resolveTaskId(
      { partition: 'p', gaiaId: GAIA, getSapisidImpl: async () => 'sapisid', fetchImpl },
      DATE_ONLY_TASK_ID,
    );
    expect(taskId).toBe(DATE_ONLY_TASK_ID);
  });

  it('finds nothing for an event no task is drawn as', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(readFixture, { status: 200 }));
    const taskId = await resolveTaskId(
      { partition: 'p', gaiaId: GAIA, getSapisidImpl: async () => 'sapisid', fetchImpl },
      'no-such-event',
    );
    expect(taskId).toBeUndefined();
  });

  it('declines without a session cookie', async () => {
    const fetchImpl = vi.fn();
    const taskId = await resolveTaskId(
      { partition: 'p', gaiaId: GAIA, getSapisidImpl: async () => null, fetchImpl },
      CALENDAR_EVENT_ID,
    );
    expect(taskId).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('writeTaskMutation', () => {
  const context = (fetchImpl: typeof fetch) => ({
    partition: 'persist:test',
    gaiaId: GAIA,
    accountIndex: 0,
    apiKey: 'page_api_key',
    getSapisidImpl: async () => 'sapisid_cookie',
    fetchImpl,
  });

  it('reads for the id, then posts the change naming that id', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return new Response(bodies.length === 1 ? readFixture : '[[]]', { status: 200 });
    });

    const written = await writeTaskMutation(context(fetchImpl), CALENDAR_EVENT_ID, 'complete');

    expect(written).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toContain(GAIA);
    // The Calendar event id is not what the write addresses.
    expect(bodies[1]).toContain(TASK_ID);
    expect(bodies[1]).not.toContain(CALENDAR_EVENT_ID);

    const headers = fetchImpl.mock.calls[1][1].headers as Record<string, string>;
    expect(headers['Authorization']).toMatch(/^SAPISIDHASH \d+_[0-9a-f]{40}_u$/);
    expect(headers['X-Goog-Api-Key']).toBe('page_api_key');
    expect(headers['Origin']).toBe('https://calendar.google.com');
  });

  it('declines without a session cookie, and posts nothing', async () => {
    const fetchImpl = vi.fn();
    const written = await writeTaskMutation(
      { ...context(fetchImpl), getSapisidImpl: async () => null },
      CALENDAR_EVENT_ID,
      'complete',
    );
    expect(written).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('completes a date-only task through the same write, naming its internal id', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return new Response(bodies.length === 1 ? dateOnlyRead : '[[]]', { status: 200 });
    });

    const written = await writeTaskMutation(context(fetchImpl), DATE_ONLY_TASK_ID, 'complete');

    expect(written).toBe(true);
    expect(bodies[1]).toContain(DATE_ONLY_TASK_ID);
    // The same mask and properties a completion has always carried; only the id resolved
    // differently.
    expect(bodies[1]).toContain('[[null,[1,5]],[1,null,null,null,');
  });

  it('posts a chip handle straight through, without a read', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('[[]]', { status: 200 }));

    const written = await writeTaskMutation(
      context(fetchImpl),
      `tasks_${DATE_ONLY_TASK_ID}`,
      'complete',
    );

    expect(written).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].body).toContain(DATE_ONLY_TASK_ID);
    expect(fetchImpl.mock.calls[0][1].body).toContain('[[null,[1,5]],[1,null,null,null,');
  });

  it('deletes a date-only task with the delete mask', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return new Response(bodies.length === 1 ? dateOnlyRead : '[[]]', { status: 200 });
    });

    const written = await writeTaskMutation(context(fetchImpl), DATE_ONLY_TASK_ID, 'delete');

    expect(written).toBe(true);
    expect(bodies[1]).toContain(DATE_ONLY_TASK_ID);
    expect(bodies[1]).toContain('[[null,[6,13]],[null,null,null,null,null,1,');
  });

  it('declines when the read names no task for the event', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(readFixture, { status: 200 }));
    const written = await writeTaskMutation(context(fetchImpl), 'no-such-event', 'delete');
    expect(written).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('declines when the write is rejected, even though the read was fine', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(readFixture, { status: 200 }))
      .mockResolvedValueOnce(new Response('[13,"Internal error."]', { status: 500 }));
    const written = await writeTaskMutation(context(fetchImpl), CALENDAR_EVENT_ID, 'complete');
    expect(written).toBe(false);
  });

  it('declines when the read itself fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const written = await writeTaskMutation(context(fetchImpl), CALENDAR_EVENT_ID, 'complete');
    expect(written).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('SyncCalendarActionDriver task writes', () => {
  const account = {
    id: 'a',
    partition: 'persist:test',
    accountIndex: 0,
    gaiaId: GAIA,
    apiKey: 'page_api_key',
  };
  const eid = Buffer.from(`${CALENDAR_EVENT_ID} me@m`, 'utf8').toString('base64url');

  const driverWith = (fetchImpl: typeof fetch) =>
    new SyncCalendarActionDriver({
      getAccountContext: (id) => (id === 'a' ? account : undefined),
      tasksFetchImpl: fetchImpl,
      getTasksSapisidImpl: async () => 'sapisid_cookie',
    });

  /** A read that answers with the fixture, then a write with `status`. */
  const readThen = (status: number) =>
    vi
      .fn()
      .mockResolvedValueOnce(new Response(readFixture, { status: 200 }))
      .mockResolvedValue(new Response('[[]]', { status }));

  it('completes a task by the Tasks id behind its eid', async () => {
    const fetchImpl = readThen(200);
    const outcome = await driverWith(fetchImpl).setTaskCompleted(
      undefined,
      'a',
      eid,
      new Date(),
      true,
    );

    expect(outcome).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1].body).toContain(TASK_ID);
    // The change sets `completed` rather than clearing it.
    expect(fetchImpl.mock.calls[1][1].body).toContain('[[null,[1,5]],[1,null,null,null,');
  });

  it('reopens a task through the same write', async () => {
    const fetchImpl = readThen(200);
    const outcome = await driverWith(fetchImpl).setTaskCompleted(
      undefined,
      'a',
      eid,
      new Date(),
      false,
    );
    expect(outcome).toBe('ok');
  });

  it('deletes a task through the same write when the event is a task', async () => {
    const fetchImpl = readThen(200);
    const outcome = await driverWith(fetchImpl).deleteEvent(undefined, 'a', eid, new Date(), true);
    expect(outcome).toBe('ok');
    expect(fetchImpl.mock.calls[1][1].body).toContain(TASK_ID);
  });

  it('completes a task Google draws nowhere by the Tasks id its chip carries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('[[]]', { status: 200 }));

    const outcome = await driverWith(fetchImpl).setTaskCompleted(
      undefined,
      'a',
      `tasks_${DATE_ONLY_TASK_ID}`,
      new Date(),
      true,
    );

    expect(outcome).toBe('ok');
    // The chip handle carries the Tasks id already, so there is no read to make.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].body).toContain(DATE_ONLY_TASK_ID);
    expect(fetchImpl.mock.calls[0][1].body).not.toContain('tasks_');
  });

  it('deletes a task Google draws nowhere through the same chip handle', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('[[]]', { status: 200 }));

    const outcome = await driverWith(fetchImpl).deleteEvent(
      undefined,
      'a',
      `tasks_${DATE_ONLY_TASK_ID}`,
      new Date(),
      true,
    );

    expect(outcome).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].body).toContain(
      '[[null,[6,13]],[null,null,null,null,null,1,',
    );
  });

  it('declines a task write for an account it does not know', async () => {
    const fetchImpl = readThen(200);
    const driver = driverWith(fetchImpl);
    expect(await driver.setTaskCompleted(undefined, 'other', eid, new Date(), true)).toBe('failed');
    expect(await driver.deleteEvent(undefined, 'other', eid, new Date(), true)).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('declines when the account has no Gaia ID to sign with', async () => {
    const fetchImpl = readThen(200);
    const driver = new SyncCalendarActionDriver({
      getAccountContext: () => ({ id: 'a', partition: 'p' }),
      tasksFetchImpl: fetchImpl,
      getTasksSapisidImpl: async () => 'sapisid_cookie',
    });
    expect(await driver.setTaskCompleted(undefined, 'a', eid, new Date(), true)).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('declines an eid it cannot decode', async () => {
    const fetchImpl = readThen(200);
    expect(
      await driverWith(fetchImpl).setTaskCompleted(undefined, 'a', 'not-an-eid', new Date(), true),
    ).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
