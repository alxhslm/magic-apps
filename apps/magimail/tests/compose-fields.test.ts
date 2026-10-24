import { describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import {
  populateComposeFields,
  waitForComposeElements,
  type ComposeFields,
} from '../src/compose-fields.js';

describe('compose-fields', () => {
  it('returns true immediately when no fields are provided', async () => {
    const win = {
      isDestroyed: () => false,
      webContents: { executeJavaScript: vi.fn() },
    } as unknown as BrowserWindow;
    const result = await populateComposeFields(win, {});
    expect(result).toBe(true);
    expect(win.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('returns false if window is destroyed', async () => {
    const win = { isDestroyed: () => true } as unknown as BrowserWindow;
    const result = await populateComposeFields(win, { to: 'test@example.com' });
    expect(result).toBe(false);
  });

  it('populates fields via executeJavaScript when fields are present', async () => {
    const executeMock = vi.fn().mockImplementation((code: string) => {
      if (code.includes('peoplekit-id') || code.includes('subjectbox')) {
        return Promise.resolve(true);
      }
      return Promise.resolve({ to: true, cc: false, bcc: false, subject: true, body: true });
    });

    const win = {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: executeMock,
      },
    } as unknown as BrowserWindow;

    const fields: ComposeFields = {
      to: 'recipient@example.com',
      subject: 'Test Subject',
      body: 'Hello World',
    };

    const result = await populateComposeFields(win, fields);
    expect(result).toBe(true);
    expect(executeMock).toHaveBeenCalled();
  });

  it('handles cc and bcc fields in executeJavaScript payload', async () => {
    let capturedCode = '';
    const executeMock = vi.fn().mockImplementation((code: string) => {
      capturedCode = code;
      return Promise.resolve(true);
    });

    const win = {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: executeMock,
      },
    } as unknown as BrowserWindow;

    const fields: ComposeFields = {
      to: 'to@example.com',
      cc: 'cc@example.com',
      bcc: 'bcc@example.com',
    };

    const result = await populateComposeFields(win, fields);
    expect(result).toBe(true);
    expect(capturedCode).toContain('cc@example.com');
    expect(capturedCode).toContain('bcc@example.com');
  });

  it('does not use a minified class to find the message body', async () => {
    let capturedCode = '';
    const executeMock = vi.fn().mockImplementation((code: string) => {
      capturedCode = code;
      return Promise.resolve(true);
    });
    const win = {
      isDestroyed: () => false,
      webContents: { executeJavaScript: executeMock },
    } as unknown as BrowserWindow;

    await populateComposeFields(win, { body: 'Hello' });
    // The body is the single `div[role="textbox"]` in the compose window, taken
    // from the action map; no English label and no minified class is involved.
    expect(capturedCode).toContain('div[role=\\"textbox\\"]');
    expect(capturedCode).toContain('findAction');
    expect(capturedCode).not.toContain('.Am.Al.editable');
  });

  it('waitForComposeElements returns true when elements are present', async () => {
    const win = {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: vi.fn().mockResolvedValue(true),
      },
    } as unknown as BrowserWindow;

    const ready = await waitForComposeElements(win, 1000);
    expect(ready).toBe(true);
  });

  it('retries when the call rejects and waits on did-stop-loading, not a fixed delay', async () => {
    const listeners: Record<string, () => void> = {};
    let calls = 0;
    const win = {
      isDestroyed: () => false,
      webContents: {
        isLoading: () => true,
        once: (event: string, cb: () => void) => {
          listeners[event] = cb;
        },
        removeListener: (event: string) => {
          delete listeners[event];
        },
        executeJavaScript: vi.fn().mockImplementation(() => {
          calls += 1;
          // The first call is torn down by a navigation, as a fresh compose pop-out
          // routinely does; the next succeeds once the load has settled.
          if (calls === 1) return Promise.reject(new Error('context destroyed'));
          return Promise.resolve(true);
        }),
      },
    } as unknown as BrowserWindow;

    const pending = waitForComposeElements(win, 1000);
    // Let the rejection schedule its wait on the load event, then finish the load.
    await new Promise((r) => setTimeout(r, 0));
    listeners['did-stop-loading']?.();

    expect(await pending).toBe(true);
    expect(calls).toBe(2);
  });
});
