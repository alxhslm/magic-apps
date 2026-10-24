import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { redactUrl, redactText, redactValue } from '../src/redact.js';

/**
 * The log is written to be attached to a bug report, so it leaves the machine.
 * These are the assertions that must not regress: everything else in the
 * logger can break and produce a bad log, but a regression here produces a
 * *leaked* one.
 */

const HOME = os.homedir();

describe('redactUrl', () => {
  it('drops a mailto entirely, address and all', () => {
    const out = redactUrl('mailto:casey@example.com?subject=Invoice&body=see%20attached');
    expect(out).toBe('mailto:<redacted>');
    expect(out).not.toContain('example');
    expect(out).not.toContain('Invoice');
  });

  it('drops a mailto with no query just as completely', () => {
    expect(redactUrl('mailto:casey@example.com')).toBe('mailto:<redacted>');
  });

  it('keeps the route of a share URL but not its parameters', () => {
    const out = redactUrl('magimail://share?files=/Users/casey/Desktop/tax-return.pdf');
    expect(out).toBe('magimail://share?<redacted>');
    expect(out).not.toContain('tax-return');
  });

  it('keeps an https path, which names the feed rather than the person', () => {
    expect(redactUrl('https://mail.google.com/mail/u/0/feed/atom')).toBe(
      'https://mail.google.com/mail/u/0/feed/atom',
    );
  });

  it('redacts the query of an https URL', () => {
    expect(redactUrl('https://mail.google.com/mail/u/0?email=casey@example.com')).toBe(
      'https://mail.google.com/mail/u/0?<redacted>',
    );
  });

  it('redacts a fragment, which is where Gmail puts the thread', () => {
    expect(redactUrl('https://mail.google.com/mail/u/0/#inbox/FMfcgz123')).toBe(
      'https://mail.google.com/mail/u/0/?<redacted>',
    );
  });

  it('falls back to the scalar rules when the input is not a URL', () => {
    expect(redactUrl('not a url, from casey@example.com')).toBe('not a url, from <email>');
  });

  it('passes an empty string through rather than inventing one', () => {
    expect(redactUrl('')).toBe('');
  });
});

describe('redactText', () => {
  it('replaces an email address', () => {
    expect(redactText('Auth failed for casey@example.com')).toBe('Auth failed for <email>');
  });

  it('replaces every address in a line, not just the first', () => {
    expect(redactText('a@b.com and c@d.org')).toBe('<email> and <email>');
  });

  it('replaces the home directory, which names the account', () => {
    expect(redactText(`${HOME}/Library/Logs/Magimail`)).toBe('~/Library/Logs/Magimail');
  });

  it('leaves a message with nothing identifying untouched', () => {
    const line = 'Feed fetch failed with status: 401';
    expect(redactText(line)).toBe(line);
  });
});

describe('redactValue', () => {
  it('rebuilds an Error rather than mutating the caller’s', () => {
    const original = new Error(`failed for casey@example.com at ${HOME}/x`);
    const redacted = redactValue(original) as Error;

    expect(redacted.message).toBe('failed for <email> at ~/x');
    expect(redacted.name).toBe('Error');
    // The caller may still rethrow the original, so it must be intact.
    expect(original.message).toContain('casey@example.com');
  });

  it('redacts an error stack, where paths and addresses also appear', () => {
    const err = new Error('boom');
    err.stack = `Error: boom\n    at ${HOME}/app/main.js:1:1`;
    expect((redactValue(err) as Error).stack).toBe('Error: boom\n    at ~/app/main.js:1:1');
  });

  it('walks arrays', () => {
    expect(redactValue(['a@b.com', 'fine'])).toEqual(['<email>', 'fine']);
  });

  it('walks plain objects', () => {
    expect(redactValue({ to: 'a@b.com', count: 3 })).toEqual({ to: '<email>', count: 3 });
  });

  it('leaves non-string scalars alone', () => {
    expect(redactValue(401)).toBe(401);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBe(null);
    expect(redactValue(undefined)).toBe(undefined);
  });

  it('does not rebuild a class instance, whose prototype it cannot restore', () => {
    class Account {
      constructor(public email: string) {}
    }
    const instance = new Account('a@b.com');
    expect(redactValue(instance)).toBe(instance);
  });

  it('stops descending past the depth bound instead of recursing forever', () => {
    const deep = { a: { b: { c: { d: { e: 'a@b.com' } } } } };
    // Depth 4 is the bound, so `e` is past it and survives. What matters is
    // that the walk terminates rather than how far it reaches.
    expect(() => redactValue(deep)).not.toThrow();
  });

  it('survives a self-referencing object', () => {
    const cyclic: Record<string, unknown> = { name: 'a@b.com' };
    cyclic.self = cyclic;
    expect(() => redactValue(cyclic)).not.toThrow();
  });
});

describe('the corpus that must never leak', () => {
  // Realistic records drawn from the call sites this branch converted.
  // The App Group is irrelevant to redaction, so the corpus uses a placeholder
  // rather than repeating the real team identifier.
  const appGroup = 'TEAMID.group.example.app';
  const records = [
    'open-url received: mailto:casey@example.com?subject=Q3&body=hi',
    `Shared file not found: ${HOME}/Desktop/payslip.pdf`,
    'Handling share URL: magimail://share?text=my%20bank%20details',
    `Failed to write cache to ${HOME}/Library/Group Containers/${appGroup}/widget-cache.json`,
    'Poll error for account-1: Error: 401 for casey@example.com',
    // Magical's tray. A calendar id is routinely an address, and the helper's own lines
    // reach the file through `handleStderr` rather than a call site that could redact them.
    'Revealing _mock_event_id_0000000000000001 in acc_work',
    'INFO|Tray|Calendar filter changed; 2 hidden (casey@example.com)',
  ];

  it('leaves no email address in any of them', () => {
    for (const record of records) {
      expect(redactText(record)).not.toMatch(/@[\w-]+\.\w+/);
    }
  });

  it('leaves no home directory in any of them', () => {
    for (const record of records) {
      expect(redactText(record)).not.toContain(HOME);
    }
  });
});
