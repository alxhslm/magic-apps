import { describe, it, expect } from 'vitest';
import { unwrapRedirectors } from '../src/links.js';

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
