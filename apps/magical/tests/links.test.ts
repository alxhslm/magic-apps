import { describe, it, expect } from 'vitest';
import { isInternalUrl, withoutQuery } from '../src/links.js';

describe('isInternalUrl', () => {
  it('keeps Google Calendar and the sign-in flow in the app', () => {
    expect(isInternalUrl('https://calendar.google.com/calendar/r/week')).toBe(true);
    expect(isInternalUrl('https://accounts.google.com/ServiceLogin?service=cl')).toBe(true);
    expect(isInternalUrl('https://myaccount.google.com/security')).toBe(true);
  });

  it('sends event attachments and locations to the browser', () => {
    expect(isInternalUrl('https://drive.google.com/file/d/abc/view')).toBe(false);
    expect(isInternalUrl('https://www.google.com/maps/place/Blue+Bottle')).toBe(false);
    expect(isInternalUrl('https://meet.google.com/abc-defg-hij')).toBe(false);
  });

  it('does not match an origin by prefix', () => {
    // A lookalike host that starts with the real one would pass a
    // `startsWith` check; origin comparison is what stops it.
    expect(isInternalUrl('https://calendar.google.com.evil.test/calendar/r')).toBe(false);
  });

  it('treats http as external even on a Google host', () => {
    expect(isInternalUrl('http://calendar.google.com/calendar/r')).toBe(false);
  });

  it('is false for anything that is not a URL', () => {
    expect(isInternalUrl('javascript:alert(1)')).toBe(false);
    expect(isInternalUrl('not a url')).toBe(false);
    expect(isInternalUrl('')).toBe(false);
  });
});

describe('withoutQuery', () => {
  it('drops the query a cold start leaves on the calendar URL', () => {
    expect(withoutQuery('https://calendar.google.com/calendar/u/0/r?pli=1')).toBe(
      'https://calendar.google.com/calendar/u/0/r',
    );
  });

  it('keeps the path, which is where the date and the view mode live', () => {
    expect(withoutQuery('https://calendar.google.com/calendar/u/0/r/month/2026/9/1?tab=rc')).toBe(
      'https://calendar.google.com/calendar/u/0/r/month/2026/9/1',
    );
  });

  it('leaves a URL with no query alone', () => {
    const url = 'https://calendar.google.com/calendar/u/0/r/week';
    expect(withoutQuery(url)).toBe(url);
  });

  it('returns anything unparseable unchanged', () => {
    expect(withoutQuery('not a url')).toBe('not a url');
  });
});
