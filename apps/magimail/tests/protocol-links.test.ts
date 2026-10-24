import { describe, it, expect } from 'vitest';
import { accountIdFromLink } from '../src/protocol-links.js';

describe('accountIdFromLink', () => {
  it('reads the account a thread, inbox, search or compose link names', () => {
    expect(accountIdFromLink('magimail://thread/EID?account=work&action=open')).toBe('work');
    expect(accountIdFromLink('magimail://inbox?account=work')).toBe('work');
    expect(accountIdFromLink('magimail://search?q=invoice&account=work')).toBe('work');
    expect(accountIdFromLink('magimail://compose?account=work')).toBe('work');
  });

  it('leaves the choice alone for a mailto: or a link with no account', () => {
    expect(accountIdFromLink('mailto:someone@example.com')).toBeUndefined();
    expect(accountIdFromLink('magimail://inbox')).toBeUndefined();
  });

  it('is undefined for anything that is not a magimail link', () => {
    expect(accountIdFromLink('https://mail.google.com/?account=work')).toBeUndefined();
    expect(accountIdFromLink('not a url')).toBeUndefined();
    expect(accountIdFromLink('')).toBeUndefined();
  });
});
