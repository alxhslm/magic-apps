/**
 * tasks-decoder.ts
 *
 * Decodes Google Tasks internal web client sync wire format
 * (POST https://tasks-pa.clients6.google.com/$rpc/google.internal.tasks.v1.TasksApiService/Sync).
 *
 * Like Google Calendar, Google Tasks uses Closure-compiled Protocol Buffers
 * serialized to positional JavaScript arrays.
 */

import indices from './tasks-indices.json';

export const TASK_RECORD_IDX = indices.taskRecord;
export const TASK_DETAILS_IDX = indices.taskDetails;
export const TASK_SCHEDULE_IDX = indices.taskSchedule;

export class TasksDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TasksDecodeError';
  }
}

export class TasksSessionExpiredError extends Error {
  constructor(message = 'Google Tasks session has expired') {
    super(message);
    this.name = 'TasksSessionExpiredError';
  }
}

export class TasksNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TasksNetworkError';
  }
}

/**
 * Google answered and refused the account rather than the request.
 *
 * A refusal is not a malformed payload: retrying it on every poll writes the same
 * failure into the log for ever, which is what an account that has never granted Tasks
 * produced. It carries the status and the delay the poller has set before trying again.
 */
export class TasksRefusedError extends Error {
  public readonly status: number;
  public readonly retryAfterMs: number;

  constructor(status: number, retryAfterMs: number) {
    super(`Tasks Sync was refused with HTTP ${status}`);
    this.name = 'TasksRefusedError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface TaskState {
  taskId: string;
  calendarEventId: string;
  completed: boolean;
  completedAt: Date | null;
}

/**
 * One dated occurrence of a recurring task.
 *
 * Google expands a recurring task itself and sends a record per occurrence, so there is
 * no rule to expand locally. None of them carries a Calendar event id, and none of them
 * appears in the range prefetch, so an occurrence is the only account of itself there
 * is; see `docs/magical/google-tasks.md#recurring-tasks-come-from-the-tasks-sync`.
 */
export interface TaskOccurrence {
  taskId: string;
  title: string;
  /** Shared by every occurrence of the same recurring task. */
  recurrenceId: string;
  startTime: Date;
  /** True when the occurrence is a date with no time of day. */
  isAllDay: boolean;
  timezone?: string;
  completed: boolean;
  completedAt: Date | null;
}

export interface TasksSyncResult {
  tasks: Map<string, TaskState>;
  /** Every task the response named, in whatever shape it named it; see `TaskEntry`. */
  tasksById: Map<string, TaskEntry>;
  /** Every occurrence the response named, in the order it named them. */
  occurrences: TaskOccurrence[];
}

/**
 * One task the response named, keyed by its own Tasks id.
 *
 * A task Google draws on the calendar is also in `TasksSyncResult.tasks`, keyed by the
 * event it is drawn as. This is the whole set, and it is what a task Google draws nowhere
 * has instead of a binding: a date-only task carries no `record[23]`, so the Tasks id is
 * the only handle on it, and it is what a write addresses.
 */
export interface TaskEntry {
  taskId: string;
  title: string;
  /** The Calendar event it is drawn as, or null when Google draws it nowhere. */
  calendarEventId: string | null;
  /**
   * The instant it falls on: its own time of day where the record carries one, and the
   * midnight UTC of its due date where it carries only a date. Null when it has neither.
   */
  startTime: Date | null;
  /** True when the record carries no time of day, so the task is a date and nothing more. */
  isAllDay: boolean;
  timezone?: string;
  completed: boolean;
  completedAt: Date | null;
}

/**
 * The date a task is due, as the midnight-UTC instant an all-day entry is filed under.
 *
 * `record[1][3]` is `[year, month, day]` — the bare date the Tasks UI shows — and for a
 * date-only task it is all there is. Read through the machine's zone it would file a day
 * early west of UTC, which is why it is built from UTC fields; see `all-day.ts`.
 */
function readDueDate(details: unknown[]): Date | null {
  const due = details[TASK_DETAILS_IDX.dueDate];
  if (!Array.isArray(due)) return null;
  const [year, month, day] = due;
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number') {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function parseTimestampTuple(tuple: unknown): Date | null {
  if (!Array.isArray(tuple)) return null;
  const [secondsStr, nanos] = tuple;
  if (typeof secondsStr !== 'string') return null;
  const seconds = Number.parseInt(secondsStr, 10);
  if (!Number.isFinite(seconds)) return null;
  const ms = seconds * 1000 + (typeof nanos === 'number' ? Math.floor(nanos / 1_000_000) : 0);
  return new Date(ms);
}

/**
 * The moment an occurrence falls on, from its schedule tuple.
 *
 * `record[8]` is `[[null, [y, m, d], [h, m], timezone, null, [epochSeconds]]]`. The
 * epoch seconds are what the app uses: Google has already resolved the date, the time
 * and the zone into an instant, and re-deriving one from the parts would reintroduce
 * every question about which zone the parts are in. The `[h, m]` tuple is read only to
 * tell a timed occurrence from a date with no time of day.
 */
function readSchedule(
  entry: unknown[],
): { startTime: Date; isAllDay: boolean; timezone?: string } | null {
  const schedule = entry[TASK_RECORD_IDX.schedule];
  if (!Array.isArray(schedule) || !Array.isArray(schedule[0])) return null;

  const slot = schedule[0] as unknown[];
  const epoch = slot[TASK_SCHEDULE_IDX.epochSeconds];
  if (!Array.isArray(epoch) || typeof epoch[0] !== 'string') return null;

  const seconds = Number.parseInt(epoch[0], 10);
  if (!Number.isFinite(seconds)) return null;

  const timeOfDay = slot[TASK_SCHEDULE_IDX.timeOfDay];
  const zone = slot[TASK_SCHEDULE_IDX.timezone];

  return {
    startTime: new Date(seconds * 1000),
    isAllDay: !Array.isArray(timeOfDay) || timeOfDay.length === 0,
    timezone: typeof zone === 'string' ? zone : undefined,
  };
}

/**
 * Walks every record the response carries, whatever collection it arrived in.
 *
 * The payload is a flat run of change records, each wrapped in a sparse list whose
 * populated slot moves: measured against a live account, a task sat at index 2 of its
 * wrapper in one response and at index 5 in another, and the run held task lists,
 * recurrence definitions and tasks side by side. Walking the lot and matching on shape
 * is what survives that; reading a fixed collection at a fixed offset found tasks only
 * when they happened to land there, and silently found none when they did not.
 */
function* everyRecord(sections: unknown[]): Generator<unknown[]> {
  for (const section of sections) {
    if (!Array.isArray(section)) continue;
    for (const entry of section) {
      if (Array.isArray(entry)) yield entry as unknown[];
    }
  }
}

/**
 * The record as a task, or null for one of the other kinds.
 *
 * A task is known by its id and its details tuple, whose completed slot is not a title. A
 * task list carries its own name in that slot and a recurrence definition carries the list
 * id where a task carries details, so neither is mistaken for one.
 *
 * A task with no title is still a task — Google draws it and the popover has a row for it
 * — so nothing here reads the title beyond taking it when it is there. Every task the
 * account holds is parsed, and which of them a surface shows is that surface's decision.
 */
function asTaskRecord(entry: unknown[]): { taskId: string; details: unknown[] } | null {
  const taskId = entry[TASK_RECORD_IDX.id];
  if (typeof taskId !== 'string' || !taskId) return null;

  const details = entry[TASK_RECORD_IDX.details];
  if (!Array.isArray(details)) return null;
  // The slot a task keeps its completed flag in is the slot a task list keeps its name
  // in, so a string there is the list rather than a task.
  if (typeof details[TASK_DETAILS_IDX.completed] === 'string') return null;

  return { taskId, details: details as unknown[] };
}

/**
 * The Calendar event id a task is drawn on, for the tasks that have one.
 *
 * A task with a date and time of its own is materialised onto the calendar and carries
 * the binding. An occurrence of a recurring task is not: Google sends one record per
 * occurrence, each carrying its own schedule and no event id at all, which is why a
 * recurring reminder never appears among the calendar's own events.
 */
function calendarEventId(entry: unknown[]): string | null {
  const binding = entry[TASK_RECORD_IDX.calendarBinding];
  if (!Array.isArray(binding) || binding.length === 0 || !Array.isArray(binding[0])) return null;
  const idList = (binding[0] as unknown[])[1];
  if (!Array.isArray(idList) || typeof idList[0] !== 'string' || !idList[0]) return null;
  return idList[0];
}

/**
 * Parses a Google Tasks Sync RPC response.
 *
 * Returns the completion state of every task Google draws on the calendar, keyed by the
 * Calendar event id the poller already uses.
 */
export function parseTasksSyncResponse(raw: string | unknown): TasksSyncResult {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const cleaned = trimmed.startsWith(")]}'")
      ? trimmed.slice(trimmed.indexOf('\n')).trim()
      : trimmed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new TasksDecodeError(`Invalid JSON payload: ${String(err)}`);
    }
  }

  if (!Array.isArray(parsed) || !Array.isArray(parsed[0])) {
    throw new TasksDecodeError('Invalid response envelope: expected root array');
  }

  const result = new Map<string, TaskState>();
  const byId = new Map<string, TaskEntry>();
  const occurrences: TaskOccurrence[] = [];

  for (const entry of everyRecord(parsed[0])) {
    const record = asTaskRecord(entry);
    if (!record) continue;

    const title = record.details[TASK_DETAILS_IDX.title];
    const completed = record.details[TASK_DETAILS_IDX.completed] === 1;
    const completedAt = completed
      ? parseTimestampTuple(record.details[TASK_DETAILS_IDX.completedTime])
      : null;

    const eventId = calendarEventId(entry);
    const schedule = readSchedule(entry);
    byId.set(record.taskId, {
      taskId: record.taskId,
      title: typeof title === 'string' ? title : '',
      calendarEventId: eventId,
      startTime: schedule?.startTime ?? readDueDate(record.details),
      isAllDay: schedule ? schedule.isAllDay : true,
      timezone: schedule?.timezone,
      completed,
      completedAt,
    });

    if (eventId) {
      result.set(eventId, {
        taskId: record.taskId,
        calendarEventId: eventId,
        completed,
        completedAt,
      });
      continue;
    }

    // No binding: either an occurrence of a recurring task, which the calendar feed
    // never carries, or a task with no date for the app to draw it on.
    const recurrenceId = record.details[TASK_DETAILS_IDX.recurrence];
    if (typeof recurrenceId !== 'string' || !recurrenceId) continue;
    if (!schedule) continue;

    occurrences.push({
      taskId: record.taskId,
      title: typeof title === 'string' ? title : '',
      recurrenceId,
      startTime: schedule.startTime,
      isAllDay: schedule.isAllDay,
      timezone: schedule.timezone,
      completed,
      completedAt,
    });
  }

  return { tasks: result, tasksById: byId, occurrences };
}
