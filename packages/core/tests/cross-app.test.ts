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
    expect(crossAppLink('https://mail.google.com/mail/u/0/#inbox/18fa24b91ac051')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://thread/18fa24b91ac051',
    });
  });

  it('keeps thread permalinks that use query parameters', () => {
    expect(crossAppLink('https://mail.google.com/mail/?view=pt&th=18fa24b91ac051')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://thread/18fa24b91ac051',
    });
    expect(crossAppLink('https://mail.google.com/mail/?view=cv&th=18fa24b91ac051')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://thread/18fa24b91ac051',
    });
    expect(crossAppLink('https://mail.google.com/mail/u/0/?th=FMfcgzQXKq')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://thread/FMfcgzQXKq',
    });
    expect(crossAppLink('https://mail.google.com/mail/u/0/?permthid=18fa24b91ac051')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://thread/18fa24b91ac051',
    });
    expect(
      crossAppLink('https://mail.google.com/mail/u/0/#inbox/FMfcgzQXKq?th=18fa24b91ac051'),
    ).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://thread/FMfcgzQXKq',
    });
  });

  it('keeps the query a Gmail search link names, encoded once', () => {
    expect(crossAppLink('https://mail.google.com/mail/u/2/#search/from%3Aboss')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://search?q=from%3Aboss',
    });
    expect(crossAppLink('https://mail.google.com/mail/u/0/#search/50%25')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://search?q=50%25',
    });
    expect(crossAppLink('https://mail.google.com/mail/u/0/#search/%FF')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://search?q=%25FF',
    });
  });

  it('handles search queries specified via searchParams', () => {
    expect(crossAppLink('https://mail.google.com/mail/u/0/?q=from%3Aboss')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://search?q=from%3Aboss',
    });
    expect(crossAppLink('https://mail.google.com/mail/?q=standup')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://search?q=standup',
    });
    expect(crossAppLink('https://calendar.google.com/calendar/r?q=standup')).toEqual({
      scheme: 'magical',
      deepLink: 'magical://search?q=standup',
    });
    expect(crossAppLink('https://calendar.google.com/calendar/u/0/r?q=standup')).toEqual({
      scheme: 'magical',
      deepLink: 'magical://search?q=standup',
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

  it('turns a mailto link encapsulated by Gmail into a compose link', () => {
    expect(
      crossAppLink(
        'https://mail.google.com/mail/?extsrc=mailto&url=mailto%3Aalex%40corp.com%3Fsubject%3DHello%26body%3DWorld%26cc%3Dteam%40corp.com',
      ),
    ).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://compose?to=alex%40corp.com&subject=Hello&body=World&cc=team%40corp.com',
    });
    expect(
      crossAppLink(
        'https://mail.google.com/mail/u/0/?extsrc=mailto&url=mailto%3Aalex%40corp.com%3Fsubject%3DHello%26body%3DWorld%26cc%3Dteam%40corp.com%26bcc%3Daudit%40corp.com',
      ),
    ).toEqual({
      scheme: 'magimail',
      deepLink:
        'magimail://compose?to=alex%40corp.com&subject=Hello&body=World&cc=team%40corp.com&bcc=audit%40corp.com',
    });
    expect(
      crossAppLink('https://mail.google.com/mail/?extsrc=mailto&url=mailto%3Aalex%40corp.com'),
    ).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://compose?to=alex%40corp.com',
    });
    expect(crossAppLink('https://mail.google.com/mail/?extsrc=mailto')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://compose',
    });
  });

  it('turns a Gmail folder into its own route', () => {
    expect(crossAppLink('https://mail.google.com/mail/u/0/#sent')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://sent',
    });
    expect(crossAppLink('https://mail.google.com/mail/u/0/#snoozed')).toEqual({
      scheme: 'magimail',
      deepLink: 'magimail://snoozed',
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
    expect(crossAppLink('https://calendar.google.com/calendar/u/0/r/month/2026/11')).toEqual({
      scheme: 'magical',
      deepLink: 'magical://date?at=2026-11-01T00%3A00%3A00.000Z',
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

  it('maps calendar RSVP action links to response deep links', () => {
    expect(
      crossAppLink(
        'https://calendar.google.com/calendar/event?action=RESPOND&eid=Y3Jhd2ZvcmQ&rst=1',
      ),
    ).toEqual({
      scheme: 'magical',
      deepLink: 'magical://event?eid=Y3Jhd2ZvcmQ&action=yes',
    });
    expect(
      crossAppLink(
        'https://calendar.google.com/calendar/event?action=RESPOND&eid=Y3Jhd2ZvcmQ&rst=2',
      ),
    ).toEqual({
      scheme: 'magical',
      deepLink: 'magical://event?eid=Y3Jhd2ZvcmQ&action=no',
    });
    expect(
      crossAppLink(
        'https://calendar.google.com/calendar/event?action=RESPOND&eid=Y3Jhd2ZvcmQ&rst=3',
      ),
    ).toEqual({
      scheme: 'magical',
      deepLink: 'magical://event?eid=Y3Jhd2ZvcmQ&action=maybe',
    });
    expect(
      crossAppLink('https://calendar.google.com/calendar/event?action=RESPOND&eid=Y3Jhd2ZvcmQ'),
    ).toEqual({
      scheme: 'magical',
      deepLink: 'magical://event?eid=Y3Jhd2ZvcmQ&action=reveal',
    });
    expect(
      crossAppLink(
        'https://calendar.google.com/calendar/event?action=RESPOND&eid=Y3Jhd2ZvcmQ&rst=99',
      ),
    ).toEqual({
      scheme: 'magical',
      deepLink: 'magical://event?eid=Y3Jhd2ZvcmQ&action=reveal',
    });
  });

  it('maps duplicate event links to event reveal links', () => {
    expect(
      crossAppLink('https://calendar.google.com/calendar/u/0/r/eventedit/copy/Y3Jhd2ZvcmQ'),
    ).toEqual({
      scheme: 'magical',
      deepLink: 'magical://event?eid=Y3Jhd2ZvcmQ&action=reveal',
    });
    expect(crossAppLink('https://calendar.google.com/calendar/eventedit/copy/Y3Jhd2ZvcmQ')).toEqual(
      {
        scheme: 'magical',
        deepLink: 'magical://event?eid=Y3Jhd2ZvcmQ&action=reveal',
      },
    );
  });

  it('opens the calendar when the link names nothing more specific', () => {
    expect(crossAppLink('https://calendar.google.com/calendar/u/0/r')).toEqual({
      scheme: 'magical',
      deepLink: 'magical://open',
    });
  });

  it('navigates to unmapped Google Calendar routes', () => {
    expect(crossAppLink('https://calendar.google.com/calendar/u/0/r/settings')).toEqual({
      scheme: 'magical',
      deepLink:
        'magical://navigate?url=https%3A%2F%2Fcalendar.google.com%2Fcalendar%2Fu%2F0%2Fr%2Fsettings',
    });
    expect(
      crossAppLink(
        'https://calendar.google.com/calendar/u/0/r?cid=team%40group.calendar.google.com',
      ),
    ).toEqual({
      scheme: 'magical',
      deepLink:
        'magical://navigate?url=https%3A%2F%2Fcalendar.google.com%2Fcalendar%2Fu%2F0%2Fr%3Fcid%3Dteam%2540group.calendar.google.com',
    });
  });

  it('navigates to unmapped Gmail routes', () => {
    expect(crossAppLink('https://mail.google.com/mail/u/0/#settings/labels')).toEqual({
      scheme: 'magimail',
      deepLink:
        'magimail://navigate?url=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F%23settings%2Flabels',
    });
  });

  it('maps calendar-source Gmail links to magimail navigate route', () => {
    expect(
      crossAppLink(
        'https://mail.google.com/mail?extsrc=cal&plid=ACUX6DNwTK67PHrtKuZt6DrTTz3oL-Ztw6XYr8A',
      ),
    ).toEqual({
      scheme: 'magimail',
      deepLink:
        'magimail://navigate?url=https%3A%2F%2Fmail.google.com%2Fmail%3Fextsrc%3Dcal%26plid%3DACUX6DNwTK67PHrtKuZt6DrTTz3oL-Ztw6XYr8A',
    });
    expect(
      crossAppLink(
        'https://mail.google.com/mail/u/0/?extsrc=cal&plid=ACUX6DNwTK67PHrtKuZt6DrTTz3oL-Ztw6XYr8A',
      ),
    ).toEqual({
      scheme: 'magimail',
      deepLink:
        'magimail://navigate?url=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F%3Fextsrc%3Dcal%26plid%3DACUX6DNwTK67PHrtKuZt6DrTTz3oL-Ztw6XYr8A',
    });
  });

  it('leaves every other link alone', () => {
    expect(crossAppLink('https://app.notion.com/p/page')).toBeNull();
    expect(crossAppLink('https://mail.google.com.evil.test/mail/u/0/#inbox')).toBeNull();
    expect(crossAppLink('mailto:alex@corp.com')).toBeNull();
    expect(crossAppLink('not a url')).toBeNull();
  });
});
