import { describe, it, expect } from 'vitest';
import { parseMailtoUri, buildGmailComposeUrl } from '../src/mailto.js';

describe('Mailto Protocol Handler', () => {
  it('parses basic mailto address', () => {
    const params = parseMailtoUri('mailto:taylor@example.com');
    expect(params.to).toBe('taylor@example.com');
    expect(params.subject).toBeUndefined();
  });

  it('parses mailto with subject, body, cc, and bcc', () => {
    const params = parseMailtoUri(
      'mailto:taylor@example.com?subject=Hello%20World&body=How%20are%20you&cc=team@example.com&bcc=boss@example.com',
    );
    expect(params.to).toBe('taylor@example.com');
    expect(params.subject).toBe('Hello World');
    expect(params.body).toBe('How are you');
    expect(params.cc).toBe('team@example.com');
    expect(params.bcc).toBe('boss@example.com');
  });

  it('converts mailto into Gmail compose URL with correct parameters', () => {
    const url = buildGmailComposeUrl({
      to: 'taylor@example.com',
      subject: 'Quarterly Review',
      body: 'Hi Taylor, see attached report.',
    });

    expect(url).toContain('https://mail.google.com/mail/u/0/?');
    expect(url).toContain('view=cm');
    expect(url).toContain('to=taylor%40example.com');
    expect(url).toContain('su=Quarterly+Review');
    expect(url).toContain('body=Hi+Taylor%2C+see+attached+report.');
  });

  it('handles invalid or empty mailto string safely', () => {
    expect(parseMailtoUri('')).toEqual({});
    expect(parseMailtoUri('https://example.com')).toEqual({});
  });
});
