import { describe, it, expect } from 'vitest';
import { parseImportResult } from '../src/ics-import.js';

/**
 * The strings here are what Google Calendar's own confirmation dialog rendered when the
 * import was driven against a live account, not invented wording.
 */
describe('parseImportResult', () => {
  it('reads a successful single-event import', () => {
    expect(parseImportResult('Imported 1 out of 1 event.OK')).toEqual({
      kind: 'imported',
      imported: 1,
      total: 1,
    });
  });

  it('reads a multi-event import', () => {
    expect(parseImportResult('Imported 12 out of 12 events.OK')).toEqual({
      kind: 'imported',
      imported: 12,
      total: 12,
    });
  });

  it('treats a partial import as a success, since something landed', () => {
    expect(parseImportResult('Imported 8 out of 12 events.OK')).toEqual({
      kind: 'imported',
      imported: 8,
      total: 12,
    });
  });

  it('reads a rejection and keeps Google’s own reason', () => {
    expect(
      parseImportResult('Imported 0 out of 0 events.\nUnable to process your ical/CSV file.OK'),
    ).toEqual({
      kind: 'rejected',
      imported: 0,
      total: 0,
      message: 'Unable to process your ical/CSV file.',
    });
  });

  it('reads a rejection that carries no reason', () => {
    expect(parseImportResult('Imported 0 out of 0 events.OK')).toEqual({
      kind: 'rejected',
      imported: 0,
      total: 0,
      message: undefined,
    });
  });

  it('returns null for a dialog that is not an import result', () => {
    expect(parseImportResult('Discard unsaved changes?')).toBeNull();
  });
});
