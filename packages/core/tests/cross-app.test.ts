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

  it('keeps a thread that sits outside the inbox', () => {
    expect(crossAppLink('https://mail.google.com/mail/u/0/#all/FMfcgzQXKq')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://thread/FMfcgzQXKq',
    });
    expect(crossAppLink('https://mail.google.com/mail/u/0/#label/Work/FMfcgzQXKq')).toEqual({
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

  it('turns a Gmail compose link into a prefilled compose link', () => {
    expect(
      crossAppLink(
        'https://mail.google.com/mail/?view=cm&fs=1&to=alex%40corp.com&su=Hello&body=Body',
      ),
    ).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://compose?to=alex%40corp.com&su=Hello&body=Body',
    });
  });

  it('turns a Gmail folder into its own route', () => {
    expect(crossAppLink('https://mail.google.com/mail/u/0/#sent')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://sent',
    });
    expect(crossAppLink('https://mail.google.com/mail/u/0/#label/Work')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://label/Work',
    });
  });

  it('turns an add-to-calendar link into a prefilled new event', () => {
    expect(
      crossAppLink(
        'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Standup&dates=20261105T090000Z/20261105T091500Z&location=Room',
      ),
    ).toEqual({
      scheme: 'magical',
      deepLink:
        'magical://quick-add?action=TEMPLATE&text=Standup&dates=20261105T090000Z%2F20261105T091500Z&location=Room',
    });
  });

  it("maps Google's own add-to-calendar host", () => {
    expect(
      crossAppLink(
        'https://www.google.com/calendar/render?action=TEMPLATE&text=Standup&dates=20261105T090000Z/20261105T091500Z',
      ),
    ).toEqual({
      scheme: 'magical',
      deepLink:
        'magical://quick-add?action=TEMPLATE&text=Standup&dates=20261105T090000Z%2F20261105T091500Z',
    });
  });

  it('opens the Tasks route on the Calendar host', () => {
    expect(crossAppLink('https://calendar.google.com/calendar/u/0/r/tasks')).toEqual({
      scheme: 'magical',
      deepLink: 'magical://tasks',
    });
  });

  it('keeps a calendar search', () => {
    expect(crossAppLink('https://calendar.google.com/calendar/u/0/r/search?q=standup')).toEqual({
      scheme: 'magical',
      deepLink: 'magical://search?q=standup',
    });
  });

  it('opens a Google Tasks link in Magical', () => {
    expect(crossAppLink('https://tasks.google.com/embed/')).toEqual({
      scheme: 'magical',
      deepLink: 'magical://tasks',
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
    expect(
      crossAppLink('https://calendar.google.com/calendar/u/0/r/eventedit/Y3Jhd2ZvcmQ'),
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
