import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sanitizeUserAgent, configureGoogleSession } from '../src/session.js';
import { DEFAULT_CLEAN_USER_AGENT } from '../src/constants.js';

const mockSession = vi.hoisted(() => ({
  setUserAgent: vi.fn(),
  setPermissionRequestHandler: vi.fn(),
  setPermissionCheckHandler: vi.fn(),
  webRequest: { onBeforeSendHeaders: vi.fn() },
}));

vi.mock('electron', () => ({
  session: {
    defaultSession: mockSession,
    fromPartition: vi.fn(() => mockSession),
  },
}));

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

describe('configureGoogleSession permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('denies web notifications on request and on check', () => {
    configureGoogleSession('persist:test');

    const requestHandler = mockSession.setPermissionRequestHandler.mock.calls[0]?.[0];
    const checkHandler = mockSession.setPermissionCheckHandler.mock.calls[0]?.[0];
    expect(requestHandler).toBeTypeOf('function');
    expect(checkHandler).toBeTypeOf('function');

    const allowNotification = vi.fn();
    requestHandler?.(null, 'notifications', allowNotification);
    expect(allowNotification).toHaveBeenCalledWith(false);

    const allowClipboard = vi.fn();
    requestHandler?.(null, 'clipboard-read', allowClipboard);
    expect(allowClipboard).toHaveBeenCalledWith(true);

    expect(checkHandler?.(null, 'notifications', 'https://mail.google.com')).toBe(false);
    expect(checkHandler?.(null, 'clipboard-read', 'https://mail.google.com')).toBe(true);
  });
});
