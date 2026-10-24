import { describe, it, expect } from 'vitest';
import { accountIndexFromUrl, pickReplayHeaders } from '../src/gmail-sync-state.js';

describe('pickReplayHeaders', () => {
  it('keeps the request headers and drops the connection ones', () => {
    const headers = {
      'X-Framework-Xsrf-Token': 'abc',
      'X-Google-BTD': '1',
      Origin: 'https://mail.google.com',
      Cookie: 'SID=secret',
      Host: 'mail.google.com',
      'Content-Length': '42',
      'Accept-Encoding': 'gzip',
      Connection: 'keep-alive',
    };

    expect(pickReplayHeaders(headers)).toEqual({
      'X-Framework-Xsrf-Token': 'abc',
      'X-Google-BTD': '1',
      Origin: 'https://mail.google.com',
    });
  });

  it('returns an empty object for absent headers', () => {
    expect(pickReplayHeaders(undefined)).toEqual({});
  });
});

describe('accountIndexFromUrl', () => {
  it('reads the account slot out of a /sync/ URL', () => {
    expect(accountIndexFromUrl('https://mail.google.com/sync/u/3/i/s?hl=en-GB')).toBe('3');
  });

  it('returns null for a URL that is not a /sync/ request', () => {
    expect(accountIndexFromUrl('https://mail.google.com/mail/u/0/')).toBeNull();
  });
});
