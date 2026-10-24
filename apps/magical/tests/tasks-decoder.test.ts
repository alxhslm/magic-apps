import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTasksSyncResponse,
  TasksDecodeError,
  TASK_RECORD_IDX,
  TASK_DETAILS_IDX,
} from '../src/tasks-decoder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixturePath = path.resolve(__dirname, 'fixtures/tasks-web-sync.json');
const fixtureContent = fs.readFileSync(fixturePath, 'utf8');

// The shape a live account answers with: a flat run of change records, holding task
// lists, a recurrence definition and tasks side by side, each wrapped in a sparse list
// whose populated slot moves between records.
const recordsFixture = fs.readFileSync(
  path.resolve(__dirname, 'fixtures/tasks-web-sync-records.json'),
  'utf8',
);

describe('tasks-decoder', () => {
  it('parses the measured fixture and separates completed and open tasks', () => {
    const result = parseTasksSyncResponse(fixtureContent);

    expect(result.tasks.size).toBe(2);

    const completed = result.tasks.get('5bbhtg1mockevent000000000001');
    expect(completed).toBeDefined();
    expect(completed?.taskId).toBe('task_mock_0000000001');
    expect(completed?.calendarEventId).toBe('5bbhtg1mockevent000000000001');
    expect(completed?.completed).toBe(true);
    expect(completed?.completedAt).toBeInstanceOf(Date);
    expect(completed?.completedAt?.getTime()).toBe(1790114306307);

    const open = result.tasks.get('6cchit2mockevent000000000002');
    expect(open).toBeDefined();
    expect(open?.taskId).toBe('task_mock_0000000002');
    expect(open?.calendarEventId).toBe('6cchit2mockevent000000000002');
    expect(open?.completed).toBe(false);
    expect(open?.completedAt).toBeNull();
  });

  it('keeps a task Google draws nowhere, keyed by its own Tasks id', () => {
    // A task with a time of day is materialised onto the calendar and carries a binding
    // at `record[23]`; a date-only task carries none, so there is no event to key it by.
    // Every other slot is null, and only the load-bearing ones are written out.
    const nulls = (count: number) => new Array(count).fill(null);
    const response = JSON.stringify([
      [
        [
          ['date-only-task-1', [null, 'Post the form', null, [2026, 10, 11]]],
          [
            'time-blocked-task',
            [null, 'Book the dentist', null, [2026, 10, 12]],
            ...nulls(6),
            [[null, [2026, 10, 12], [9], 'Europe/London', null, ['1791824400']]],
            ...nulls(14),
            [['binding-record-1', ['cal-event-1']]],
          ],
        ],
      ],
    ]);

    const result = parseTasksSyncResponse(response);

    // Only the task with an event to be drawn as is keyed by one.
    expect(result.tasks.size).toBe(1);
    expect(result.tasks.get('cal-event-1')?.taskId).toBe('time-blocked-task');

    const dateOnly = result.tasksById.get('date-only-task-1');
    expect(dateOnly?.title).toBe('Post the form');
    expect(dateOnly?.calendarEventId).toBeNull();
    // A date and no time of day: filed at midnight UTC, the instant an all-day entry uses.
    expect(dateOnly?.isAllDay).toBe(true);
    expect(dateOnly?.startTime?.toISOString()).toBe('2026-10-11T00:00:00.000Z');
    expect(dateOnly?.completed).toBe(false);
    expect(dateOnly?.completedAt).toBeNull();

    const bound = result.tasksById.get('time-blocked-task');
    expect(bound?.calendarEventId).toBe('cal-event-1');
    expect(bound?.isAllDay).toBe(false);
    expect(bound?.startTime?.toISOString()).toBe('2026-10-12T17:00:00.000Z');
  });

  it('keeps a task that has no title, and still refuses a task list', () => {
    // A task with no title is still a task: Google draws it and the popover has a row for
    // it. The slot a task keeps its completed flag in is the slot a task list keeps its own
    // name in, and that is what separates the two.
    const response = JSON.stringify([
      [
        [
          ['untitled-task-1', [null, null, null, [2026, 10, 12]]],
          ['~default', ['My Tasks']],
        ],
      ],
    ]);

    const result = parseTasksSyncResponse(response);

    const untitled = result.tasksById.get('untitled-task-1');
    expect(untitled).toBeDefined();
    expect(untitled?.title).toBe('');
    expect(untitled?.isAllDay).toBe(true);
    expect(untitled?.completed).toBe(false);

    // The list is not a task, however much its tuple looks like one.
    expect(result.tasksById.has('~default')).toBe(false);
    expect([...result.tasksById.values()].map((task) => task.taskId)).toEqual(['untitled-task-1']);
  });

  it('strips anti-XSSI guard prefix if present', () => {
    const prefixed = `)]}'\n\n${fixtureContent}`;
    const result = parseTasksSyncResponse(prefixed);
    expect(result.tasks.size).toBe(2);
  });

  it('throws TasksDecodeError on non-array root', () => {
    expect(() => parseTasksSyncResponse('{"error": "bad"}')).toThrow(TasksDecodeError);
    expect(() => parseTasksSyncResponse([])).toThrow(TasksDecodeError);
  });

  it('reads a response whose records sit at no fixed offset', () => {
    const result = parseTasksSyncResponse(recordsFixture);

    // Both tasks carry a calendar binding, and their records sit at different slots of
    // their wrappers. Reading one collection at one offset found neither.
    expect([...result.tasks.keys()].sort()).toEqual(['cal-event-done-0001', 'cal-event-open-0001']);

    const done = result.tasks.get('cal-event-done-0001');
    expect(done?.taskId).toBe('task-done-0001');
    expect(done?.completed).toBe(true);
    expect(done?.completedAt?.getTime()).toBe(1790174730963);

    const open = result.tasks.get('cal-event-open-0001');
    expect(open?.taskId).toBe('task-open-0001');
    expect(open?.completed).toBe(false);
    expect(open?.completedAt).toBeNull();
  });

  it('passes over the records that are not tasks', () => {
    const result = parseTasksSyncResponse(recordsFixture);

    // A task list carries its id where a task carries details, and a recurrence
    // definition carries the list id there; neither is a task.
    expect(result.tasks.has('~default')).toBe(false);
    for (const state of result.tasks.values()) {
      expect(state.taskId).not.toBe('recurrence-0001');
    }
  });

  it('keeps an occurrence of a recurring task out of the completion map', () => {
    const result = parseTasksSyncResponse(recordsFixture);

    // An occurrence carries no calendar binding, so there is no event id to key it by.
    for (const state of result.tasks.values()) {
      expect(state.taskId).not.toBe('occurrence-0001');
      expect(state.taskId).not.toBe('occurrence-0002');
    }
  });

  it('returns each occurrence of a recurring task, already expanded by Google', () => {
    const { occurrences } = parseTasksSyncResponse(recordsFixture);

    expect(occurrences).toHaveLength(2);
    expect(occurrences.map((o) => o.taskId)).toEqual(['occurrence-0001', 'occurrence-0002']);

    const [first] = occurrences;
    expect(first.title).toBe('Weekly review');
    expect(first.recurrenceId).toBe('recurrence-0001');
    expect(first.isAllDay).toBe(false);
    expect(first.timezone).toBe('Europe/London');
    expect(first.completed).toBe(false);
    // Read from the epoch seconds Google resolved, not rebuilt from the date parts.
    expect(first.startTime.getTime()).toBe(1790181000000);
  });

  it('leaves a bound task out of the occurrences', () => {
    const { occurrences } = parseTasksSyncResponse(recordsFixture);

    // A task the calendar already draws arrives as an event of its own; building a
    // second one from the sync would put it in the agenda twice.
    for (const occurrence of occurrences) {
      expect(occurrence.taskId).not.toBe('task-done-0001');
      expect(occurrence.taskId).not.toBe('task-open-0001');
    }
  });

  it('reports no tasks, rather than throwing, when the response holds none', () => {
    // The caller decides what an answer naming nothing means: `syncTasksCompletion`
    // keeps the cached state rather than clearing every tick on it.
    expect(parseTasksSyncResponse([[null, null, null, null, null]]).tasks.size).toBe(0);
  });

  it('passes over a record whose details are not a tuple', () => {
    const malformed = [
      [
        null,
        null,
        null,
        null,
        [null, null, ['task_1', 'invalid_details', ...Array(21).fill(null), [['bind', ['cal_1']]]]],
      ],
    ];
    expect(parseTasksSyncResponse(malformed).tasks.size).toBe(0);
  });

  it('exports pinned indices matching the wire contract', () => {
    expect(TASK_RECORD_IDX.id).toBe(0);
    expect(TASK_RECORD_IDX.details).toBe(1);
    expect(TASK_RECORD_IDX.calendarBinding).toBe(23);
    expect(TASK_DETAILS_IDX.completed).toBe(0);
    expect(TASK_DETAILS_IDX.completedTime).toBe(4);
  });
});
