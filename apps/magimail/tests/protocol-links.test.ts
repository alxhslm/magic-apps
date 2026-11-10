import { describe, it, expect } from 'vitest';
import { accountIdFromLink, isAllowedGmailNavigationUrl } from '../src/protocol-links.js';

describe('accountIdFromLink', () => {
  it('reads the account a thread, inbox, search or compose link names', () => {
    expect(accountIdFromLink('magimail://thread/EID?account=work&action=open')).toBe('work');
    expect(accountIdFromLink('magimail://inbox?account=work')).toBe('work');
    expect(accountIdFromLink('magimail://search?q=invoice&account=work')).toBe('work');
    expect(accountIdFromLink('magimail://compose?account=work')).toBe('work');
    expect(
      accountIdFromLink(
        'magimail://navigate?url=https%3A%2F%2Fmail.google.com%2Fmail&account=work',
      ),
    ).toBe('work');
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

describe('isAllowedGmailNavigationUrl', () => {
  it('allows mail.google.com and gmail.com hosts', () => {
    expect(isAllowedGmailNavigationUrl('https://mail.google.com/mail/u/0/#settings/labels')).toBe(
      true,
    );
    expect(isAllowedGmailNavigationUrl('https://gmail.com/mail/u/0/#inbox')).toBe(true);
    expect(isAllowedGmailNavigationUrl('https://www.gmail.com/mail/u/0/#sent')).toBe(true);
  });

  it('rejects external and non-Gmail URLs, and plaintext http', () => {
    expect(isAllowedGmailNavigationUrl('http://mail.google.com/mail/u/0/#inbox')).toBe(false);
    expect(isAllowedGmailNavigationUrl('https://calendar.google.com/calendar/r')).toBe(false);
    expect(isAllowedGmailNavigationUrl('https://google.com/search?q=gmail')).toBe(false);
    expect(isAllowedGmailNavigationUrl('https://evil.com/mail.google.com')).toBe(false);
    expect(isAllowedGmailNavigationUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedGmailNavigationUrl('not a url')).toBe(false);
  });
});
