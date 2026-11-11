import { describe, it, expect } from 'vitest';
import { parseWebcalResult } from '../src/webcal-import.js';

describe('parseWebcalResult', () => {
  it('reads a successful subscription confirmation', () => {
    expect(parseWebcalResult('Calendar added')).toEqual({ kind: 'subscribed' });
    expect(parseWebcalResult('Settings saved')).toEqual({ kind: 'subscribed' });
    expect(parseWebcalResult('Calendar created')).toEqual({ kind: 'subscribed' });
  });

  it('reads a rejection when Google cannot fetch the feed', () => {
    expect(
      parseWebcalResult('Could not fetch the URL because robots.txt prevents crawling.'),
    ).toEqual({
      kind: 'rejected',
      reason: 'Could not fetch the URL because robots.txt prevents crawling.',
    });

    expect(parseWebcalResult('Failed to add calendar from URL')).toEqual({
      kind: 'rejected',
      reason: 'Failed to add calendar from URL',
    });

    expect(parseWebcalResult('Invalid URL: Unable to process')).toEqual({
      kind: 'rejected',
      reason: 'Invalid URL: Unable to process',
    });
  });

  it('returns unconfirmed for unexpected or unfamiliar dialog texts', () => {
    expect(parseWebcalResult('Discard unsaved changes?')).toEqual({
      kind: 'unconfirmed',
      reason: 'Discard unsaved changes?',
    });
  });
});
