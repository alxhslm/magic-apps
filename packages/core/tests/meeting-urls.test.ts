import { describe, it, expect } from 'vitest';
import { isMeetingUrl } from '../src/meeting-urls.js';

describe('isMeetingUrl', () => {
  it('recognises the meeting hosts the apps know', () => {
    for (const url of [
      'https://meet.google.com/abc-defg-hij',
      'https://zoom.us/j/1234567890',
      'https://us02web.zoom.us/j/1234567890?pwd=x',
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting',
      'https://teams.live.com/meet/123',
      'https://company.webex.com/meet/alex',
      'https://global.gotomeeting.com/join/123',
      'https://whereby.com/alex',
    ]) {
      expect(isMeetingUrl(url), url).toBe(true);
    }
  });

  it('leaves other links alone, including lookalike hosts', () => {
    for (const url of [
      'https://app.notion.com/p/page',
      'https://app.todoist.com/app/task/1',
      'https://example.com/',
      'https://meet.google.com.evil.test/abc',
      'https://notzoom.us/j/1',
      'mailto:alex@corp.com',
      'not a url',
    ]) {
      expect(isMeetingUrl(url), url).toBe(false);
    }
  });
});
