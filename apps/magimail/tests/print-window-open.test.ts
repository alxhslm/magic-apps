import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installMainWorldPrintOpenStub } from '../src/print-window-open.js';

type TestWindow = {
  location: { href: string };
  open: (url?: string | URL, target?: string, features?: string) => unknown;
  __magimailPrintOpenStubInstalled?: boolean;
};

describe('installMainWorldPrintOpenStub', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it('is serialisable with no external imports or closures', () => {
    const source = installMainWorldPrintOpenStub.toString();
    expect(source).not.toMatch(/\bimport\b|\brequire\(/);
  });

  it('returns a stub window when window.open returns null for a Gmail view=pt URL', () => {
    const nativeOpen = vi.fn(() => null);
    const mockWin: TestWindow = {
      location: { href: 'https://mail.google.com/mail/u/0/#inbox/1800000000000001' },
      open: nativeOpen,
    };
    (globalThis as { window?: TestWindow }).window = mockWin;

    installMainWorldPrintOpenStub();

    const result = mockWin.open(
      'https://mail.google.com/mail/u/0/?ui=2&view=pt&search=all&th=1800000000000001',
      '_blank',
    ) as { closed: boolean; focus: () => void; close: () => void } | null;

    expect(nativeOpen).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result?.closed).toBe(false);
    expect(typeof result?.focus).toBe('function');
    expect(typeof result?.close).toBe('function');
  });

  it('resolves relative view=pt URLs against window.location.href', () => {
    const nativeOpen = vi.fn(() => null);
    const mockWin: TestWindow = {
      location: { href: 'https://mail.google.com/mail/u/0/#inbox/1800000000000001' },
      open: nativeOpen,
    };
    (globalThis as { window?: TestWindow }).window = mockWin;

    installMainWorldPrintOpenStub();

    const result = mockWin.open('?ui=2&view=pt&search=all&th=1800000000000001', '_blank') as {
      closed: boolean;
    } | null;

    expect(result).not.toBeNull();
    expect(result?.closed).toBe(false);
  });

  it('returns null when window.open denies non-print URLs or non-Gmail hosts', () => {
    const nativeOpen = vi.fn(() => null);
    const mockWin: TestWindow = {
      location: { href: 'https://mail.google.com/mail/u/0/#inbox' },
      open: nativeOpen,
    };
    (globalThis as { window?: TestWindow }).window = mockWin;

    installMainWorldPrintOpenStub();

    expect(mockWin.open('https://example.com/?view=pt', '_blank')).toBeNull();
    expect(mockWin.open('https://mail.google.com/mail/u/0/#inbox', '_blank')).toBeNull();
    expect(mockWin.open(undefined, '_blank')).toBeNull();
  });

  it('passes through the real window when window.open succeeds', () => {
    const realWin = { closed: false, focus: vi.fn() };
    const nativeOpen = vi.fn(() => realWin);
    const mockWin: TestWindow = {
      location: { href: 'https://mail.google.com/mail/u/0/#inbox' },
      open: nativeOpen,
    };
    (globalThis as { window?: TestWindow }).window = mockWin;

    installMainWorldPrintOpenStub();

    expect(mockWin.open('https://mail.google.com/mail/u/0/?view=cm', '_blank')).toBe(realWin);
  });

  it('does not double-wrap window.open if called multiple times', () => {
    const nativeOpen = vi.fn(() => null);
    const mockWin: TestWindow = {
      location: { href: 'https://mail.google.com/mail/u/0/#inbox' },
      open: nativeOpen,
    };
    (globalThis as { window?: TestWindow }).window = mockWin;

    installMainWorldPrintOpenStub();
    const wrappedOnce = mockWin.open;
    installMainWorldPrintOpenStub();

    expect(mockWin.open).toBe(wrappedOnce);
  });

  it('is wired into preload.ts via executeInMainWorld', () => {
    const preloadSource = fs.readFileSync(path.resolve(__dirname, '../src/preload.ts'), 'utf8');
    expect(preloadSource).toContain('installMainWorldPrintOpenStub');
    expect(preloadSource).toContain('executeInMainWorld');
  });
});
