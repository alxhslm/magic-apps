import { describe, it, expect } from 'vitest';
import { unwrapRedirectors, toNativeMeetingUrl } from '../src/links.js';

describe('unwrapRedirectors', () => {
  it('unwraps Google outbound URLs with q param', () => {
    expect(unwrapRedirectors('https://www.google.com/url?q=https://example.com/page&usd=1')).toBe(
      'https://example.com/page',
    );
  });

  it('unwraps Google outbound URLs with url param', () => {
    expect(unwrapRedirectors('https://google.com/url?url=https://example.com/page')).toBe(
      'https://example.com/page',
    );
  });

  it('unwraps Outlook Safelinks', () => {
    expect(
      unwrapRedirectors(
        'https://eur02.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com&data=1',
      ),
    ).toBe('https://example.com');
  });

  it('unwraps nested redirectors up to 3 hops', () => {
    const target = 'https://app.todoist.com/app/task/12345';
    const hop1 = `https://www.google.com/url?q=${encodeURIComponent(target)}`;
    const hop2 = `https://eur02.safelinks.protection.outlook.com/?url=${encodeURIComponent(hop1)}`;
    expect(unwrapRedirectors(hop2)).toBe(target);
  });

  it('leaves clean URLs unchanged', () => {
    expect(unwrapRedirectors('https://app.todoist.com/app/task/12345')).toBe(
      'https://app.todoist.com/app/task/12345',
    );
    expect(unwrapRedirectors('https://www.notion.so/my-page-123')).toBe(
      'https://www.notion.so/my-page-123',
    );
  });

  it('handles invalid or non-URL inputs safely', () => {
    expect(unwrapRedirectors('not a url')).toBe('not a url');
    expect(unwrapRedirectors('')).toBe('');
  });
});

describe('toNativeMeetingUrl', () => {
  it('rewrites Zoom web links to native scheme', () => {
    expect(toNativeMeetingUrl('https://zoom.us/j/1234567890')).toBe(
      'zoommtg://zoom.us/join?action=join&confno=1234567890',
    );
    expect(toNativeMeetingUrl('https://subdomain.zoom.us/w/9876543210')).toBe(
      'zoommtg://zoom.us/join?action=join&confno=9876543210',
    );
  });

  it('keeps Zoom password parameters', () => {
    expect(toNativeMeetingUrl('https://acme.zoom.us/j/999?pwd=SeCrEt')).toBe(
      'zoommtg://zoom.us/join?action=join&confno=999&pwd=SeCrEt',
    );
  });

  it('unwraps redirectors before checking for meeting URLs', () => {
    const wrapped = `https://www.google.com/url?q=${encodeURIComponent('https://zoom.us/j/12345?pwd=pass')}`;
    expect(toNativeMeetingUrl(wrapped)).toBe(
      'zoommtg://zoom.us/join?action=join&confno=12345&pwd=pass',
    );
  });

  it('rewrites Teams web links to native scheme', () => {
    expect(toNativeMeetingUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x')).toBe(
      'msteams://teams.microsoft.com/l/meetup-join/19%3ameeting_x',
    );
    expect(toNativeMeetingUrl('https://teams.live.com/meet/98765')).toBe(
      'msteams://teams.live.com/meet/98765',
    );
  });

  it('leaves Meet, Webex and other URLs unchanged', () => {
    expect(toNativeMeetingUrl('https://meet.google.com/abc-defg-hij')).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
    expect(toNativeMeetingUrl('https://acme.webex.com/meet/person')).toBe(
      'https://acme.webex.com/meet/person',
    );
    expect(toNativeMeetingUrl('https://example.com/about')).toBe('https://example.com/about');
  });
});
