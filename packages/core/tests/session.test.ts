import { describe, it, expect } from 'vitest';
import { sanitizeUserAgent } from '../src/session.js';
import { DEFAULT_CLEAN_USER_AGENT } from '../src/constants.js';

describe('sanitizeUserAgent', () => {
  it('returns default clean macOS Chrome UA if none provided', () => {
    expect(sanitizeUserAgent()).toBe(DEFAULT_CLEAN_USER_AGENT);
    expect(sanitizeUserAgent('')).toBe(DEFAULT_CLEAN_USER_AGENT);
  });

  it('replaces UA containing Electron with clean Chrome UA', () => {
    const electronUA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) magimail/0.1.0 Chrome/128.0.0.0 Electron/34.2.0 Safari/537.36';
    expect(sanitizeUserAgent(electronUA)).toBe(DEFAULT_CLEAN_USER_AGENT);
  });

  it('preserves clean standard browser user agents', () => {
    const safariUA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
    expect(sanitizeUserAgent(safariUA)).toBe(safariUA);
  });
});
