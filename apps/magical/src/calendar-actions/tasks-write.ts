/**
 * tasks-write.ts
 *
 * Direct writes to Google Tasks: ticking a task off, ticking it back open, and deleting it.
 *
 * All three are one mutation — a task record carrying a `properties_update_mask` that
 * names the fields being set, and a positional properties message holding their new
 * values. The field numbers were captured from Google's own writes, not derived:
 * `1` is `completed`, `5` `completedAt`, `6` `deleted` and `13` `deletedAt`. A wrong
 * number is a write that answers `200` and changes nothing.
 *
 * The RPC addresses a task by its **Tasks id**, which is not the Calendar event id an
 * `eid` carries. A write naming the Calendar event id answers `200` and does nothing —
 * measured — so every write resolves the id from a Tasks sync read first, the same way
 * `SyncCalendarActionDriver` refreshes its sync token with a read before it writes a
 * calendar change.
 *
 * The payload carries no list record. Google's own client sends one, but measured against
 * a live account the mutation lands with the task record alone, so the list id and its
 * version counter are not reconstructed here. See `docs/magical/google-tasks.md`.
 */
import { createLogger } from '@magimail/core/logger';
import { TASK_CHIP_PREFIX } from '../calendar-decoder.js';
import { parseTasksSyncResponse } from '../tasks-decoder.js';
import {
  postTasksSync,
  readSapisidCookie,
  tasksReadBody,
  tasksSyncHeaders,
  type TasksSyncAuth,
} from '../tasks-rpc.js';

const log = createLogger('TasksWrite');

export type TaskMutation = 'complete' | 'reopen' | 'delete';

/**
 * Field numbers of a task's own message, as its `properties_update_mask` names them.
 *
 * The mask lists the numbers; the properties message is positional, so a value sits at
 * its field number minus one. Both halves have to agree: a mask naming a field the
 * properties message leaves null clears it, which is how the reopen is written.
 */
const TASK_FIELD_COMPLETED = 1;
const TASK_FIELD_COMPLETED_AT = 5;
const TASK_FIELD_DELETED = 6;
const TASK_FIELD_DELETED_AT = 13;

/** The record type Google's client gives a task, as opposed to a list (`4`). */
const TASK_RECORD_TYPE = 3;

const RECORD_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * The id a change record carries in its first slot.
 *
 * Opaque to the server: measured against a live account, the same constant in every
 * record lands as readily as a fresh one, and it is neither the task's id nor anything a
 * read returns. Generated rather than fixed so a capture of this code does not look like
 * a replay of one specific request.
 */
function recordId(): string {
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    id += RECORD_ID_ALPHABET[Math.floor(Math.random() * RECORD_ID_ALPHABET.length)];
  }
  return id;
}

/** A proto timestamp: `[seconds, nanos]`, the shape every time field on this wire uses. */
function timestampTuple(now: Date): number[] {
  const ms = now.getTime();
  return [Math.floor(ms / 1000), (ms % 1000) * 1_000_000];
}

/** A positional properties message, with each value placed at its field number. */
function propertiesFor(entries: Array<[field: number, value: unknown]>): unknown[] {
  const properties: unknown[] = [];
  for (const [field, value] of entries) {
    while (properties.length < field - 1) properties.push(null);
    properties[field - 1] = value;
  }
  return properties;
}

/**
 * One mutation, ready to POST.
 *
 * The task record is ten slots long and every one of them matters: dropping the record id
 * (`0`), the record type (`1`), the id itself (`2`), the entity version block (`3`), the
 * update block (`6`) or the modified-at tuple (`9`) answers `500 Internal error` or
 * `400 Invalid value`, measured one slot at a time. Slots beyond `9` are not sent, and the
 * envelope's own timestamp, the Gaia ID and the client label are each optional.
 */
export function buildTaskMutationBody(
  mutation: TaskMutation,
  taskId: string,
  gaiaId?: string,
  now: Date = new Date(),
): unknown[] {
  const ts = timestampTuple(now);

  // Google's own client names both `completed` and its timestamp on every tick and untick,
  // and names both `deleted` and its timestamp on a delete.
  const mask =
    mutation === 'delete'
      ? [null, [TASK_FIELD_DELETED, TASK_FIELD_DELETED_AT]]
      : [null, [TASK_FIELD_COMPLETED, TASK_FIELD_COMPLETED_AT]];
  const properties =
    mutation === 'complete'
      ? propertiesFor([
          [TASK_FIELD_COMPLETED, 1],
          [TASK_FIELD_COMPLETED_AT, ts],
        ])
      : mutation === 'reopen'
        ? // An empty properties message against a mask naming `completed` is the clear.
          []
        : propertiesFor([
            [TASK_FIELD_DELETED, 1],
            [TASK_FIELD_DELETED_AT, ts],
          ]);

  const record: unknown[] = new Array(10).fill(null);
  record[0] = recordId();
  record[1] = TASK_RECORD_TYPE;
  record[2] = taskId;
  record[3] = [1];
  record[6] = [mask, properties];
  record[9] = ts;

  // The change-set list holds one change set, which holds one record.
  const envelope = [null, [ts, null, [[[record], []]]]];
  return [envelope, null, gaiaId ? [null, [gaiaId]] : null, null, null];
}

export interface TasksWriteContext extends TasksSyncAuth {
  /** Test seams: a write without a live partition. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  getSapisidImpl?: () => Promise<string | null>;
}

async function sapisidFor(context: TasksWriteContext): Promise<string | null> {
  if (context.getSapisidImpl) return context.getSapisidImpl();
  return readSapisidCookie(context.partition);
}

/**
 * The Tasks id a handle carries by itself, or null when only a read can say.
 *
 * The grid names a task's chip `tasks_<Tasks id>`, whatever the task is drawn as, so that
 * handle carries the id already and nothing has to be looked up for it. Every other handle
 * is a Calendar event id, and only the read can say which task is drawn as it.
 */
export function taskIdFromChip(handle: string): string | null {
  if (!handle.startsWith(TASK_CHIP_PREFIX)) return null;
  const taskId = handle.slice(TASK_CHIP_PREFIX.length);
  return taskId || null;
}

/**
 * The Tasks id behind the handle a caller has, from a read it has already signed.
 *
 * A chip handle needs no read: `taskIdFromChip` reads the id straight out of it. Anything
 * else is a Calendar event id, and the binding is how a task drawn on the calendar names
 * the event it is drawn as; the read is Google's whole answer rather than a lookup. A task
 * Google draws nowhere has no binding, so an id the read itself holds is the other way it
 * resolves.
 */
async function readTaskId(
  context: TasksWriteContext,
  sapisid: string,
  calendarEventId: string,
): Promise<string | undefined> {
  // In hand already: a read would only say the same thing, one round trip later.
  const fromChip = taskIdFromChip(calendarEventId);
  if (fromChip) return fromChip;

  try {
    const response = await postTasksSync({
      partition: context.partition,
      headers: tasksSyncHeaders(context, sapisid, Math.floor(Date.now() / 1000)),
      body: JSON.stringify(tasksReadBody(context.gaiaId)),
      fetchImpl: context.fetchImpl,
    });

    if (!response.ok) {
      log.warn(`Tasks read for ${context.partition} returned HTTP ${response.status}`);
      return undefined;
    }

    const { tasks, tasksById } = parseTasksSyncResponse(await response.text());
    return tasks.get(calendarEventId)?.taskId ?? tasksById.get(calendarEventId)?.taskId;
  } catch (err) {
    log.warn(`Tasks read for ${context.partition} failed:`, err);
    return undefined;
  }
}

/** The Tasks id behind a Calendar event id, or undefined when the account cannot say. */
export async function resolveTaskId(
  context: TasksWriteContext,
  calendarEventId: string,
): Promise<string | undefined> {
  const sapisid = await sapisidFor(context);
  if (!sapisid) {
    log.warn(`No SAPISID cookie in ${context.partition}; cannot resolve a task id`);
    return undefined;
  }
  return readTaskId(context, sapisid, calendarEventId);
}

/**
 * One task mutation, from resolving the id to posting the change.
 *
 * Returns false rather than throwing for anything the caller should fall back to the view
 * over: no session, no id for this event, a read or a write the server rejected. A `200`
 * is all the server gives; that the change landed is the caller's next sync to say.
 */
export async function writeTaskMutation(
  context: TasksWriteContext,
  calendarEventId: string,
  mutation: TaskMutation,
): Promise<boolean> {
  const sapisid = await sapisidFor(context);
  if (!sapisid) {
    log.warn(`No SAPISID cookie in ${context.partition}; ${mutation} cannot go direct`);
    return false;
  }

  const taskId = await readTaskId(context, sapisid, calendarEventId);
  if (!taskId) {
    log.info(`No Tasks id for calendar event ${calendarEventId}; ${mutation} cannot go direct`);
    return false;
  }

  try {
    const response = await postTasksSync({
      partition: context.partition,
      headers: tasksSyncHeaders(context, sapisid, Math.floor(Date.now() / 1000)),
      body: JSON.stringify(buildTaskMutationBody(mutation, taskId, context.gaiaId)),
      fetchImpl: context.fetchImpl,
    });

    if (!response.ok) {
      log.warn(`${mutation} of task ${taskId} returned HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (err) {
    log.warn(`${mutation} of task ${taskId} threw:`, err);
    return false;
  }
}
