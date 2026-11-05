import { describe, it, expect } from 'vitest';
import { crossAppLink } from '../src/cross-app.js';

describe('crossAppLink', () => {
  it('sends a Gmail inbox link to Magimail', () => {
    expect(crossAppLink('https://mail.google.com/mail/u/0/#inbox')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://inbox',
    });
  });

  it('keeps the thread a Gmail link names', () => {
    expect(crossAppLink('https://mail.google.com/mail/u/0/#inbox/FMfcgzQXKq')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://thread/FMfcgzQXKq',
    });
  });

  it('keeps the query a Gmail search link names, encoded once', () => {
    expect(crossAppLink('https://mail.google.com/mail/u/2/#search/from%3Aboss')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://search?q=from%3Aboss',
    });
  });

  it('sends a calendar day link to Magical, as midnight on that day', () => {
    expect(crossAppLink('https://calendar.google.com/calendar/u/0/r/day/2026/11/5')).toEqual({
      scheme: 'magical',
      deepLink: 'magical://date?at=2026-11-05T00%3A00%3A00.000Z',
    });
  });

  it('sends a single event to Magical by its eid', () => {
    expect(
      crossAppLink('https://calendar.google.com/calendar/u/0/r/week/2026/11/5?eid=Y3Jhd2ZvcmQ'),
    ).toEqual({
      scheme: 'magical',
      deepLink: 'magical://event?eid=Y3Jhd2ZvcmQ&action=reveal',
    });
  });

  it('opens the calendar when the link names nothing more specific', () => {
    expect(crossAppLink('https://calendar.google.com/calendar/u/0/r')).toEqual({
      scheme: 'magical',
      deepLink: 'magical://open',
    });
  });

  it('leaves every other link alone', () => {
    expect(crossAppLink('https://app.notion.com/p/page')).toBeNull();
    expect(crossAppLink('https://mail.google.com.evil.test/mail/u/0/#inbox')).toBeNull();
    expect(crossAppLink('mailto:alex@corp.com')).toBeNull();
    expect(crossAppLink('not a url')).toBeNull();
  });
});
