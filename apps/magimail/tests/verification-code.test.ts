import { describe, expect, it } from 'vitest';
import { extractServiceName, extractVerificationCode } from '../src/verification-code.js';

describe('extractServiceName', () => {
  it('extracts name from display name with quotes or angle brackets', () => {
    expect(extractServiceName('"GitHub" <noreply@github.com>')).toBe('GitHub');
    expect(extractServiceName('Stripe Support <support@stripe.com>')).toBe('Stripe Support');
    expect(extractServiceName('Google Security <no-reply@accounts.google.com>')).toBe(
      'Google Security',
    );
  });

  it('extracts domain when no display name is present', () => {
    expect(extractServiceName('noreply@uber.com')).toBe('Uber');
    expect(extractServiceName('auth@auth0.com')).toBe('Auth0');
  });

  it('returns undefined for empty input', () => {
    expect(extractServiceName('')).toBeUndefined();
    expect(extractServiceName(undefined)).toBeUndefined();
  });
});

describe('extractVerificationCode', () => {
  it('extracts code when code is before trigger phrase', () => {
    const result = extractVerificationCode(
      '849201 is your GitHub verification code',
      'Use this code to verify your device.',
      'GitHub <noreply@github.com>',
    );
    expect(result).toEqual({
      code: '849201',
      service: 'GitHub',
    });
  });

  it('extracts code when code is after trigger phrase', () => {
    const result = extractVerificationCode(
      'Your verification code: 629104',
      'Enter this code to finish logging in.',
      'Amazon.com <account-update@amazon.com>',
    );
    expect(result).toEqual({
      code: '629104',
      service: 'Amazon.com',
    });
  });

  it('extracts Google prefixed codes (G-xxxxxx)', () => {
    const result = extractVerificationCode(
      'G-123456 is your Google verification code',
      '',
      'Google <no-reply@accounts.google.com>',
    );
    expect(result).toEqual({
      code: 'G-123456',
      service: 'Google',
    });
  });

  it('normalizes hyphenated digit codes (e.g. 123-456 -> 123456)', () => {
    const result = extractVerificationCode(
      'Slack confirmation code: 491-823',
      '',
      'Slack <feedback@slack.com>',
    );
    expect(result).toEqual({
      code: '491823',
      service: 'Slack',
    });
  });

  it('normalizes space-separated digit codes (e.g. 123 456 -> 123456)', () => {
    const result = extractVerificationCode(
      'Security code for your account',
      'Your one-time passcode is 491 823. Valid for 10 minutes.',
      'Stripe <security@stripe.com>',
    );
    expect(result).toEqual({
      code: '491823',
      service: 'Stripe',
    });
  });

  it('extracts 4-digit code (e.g. Uber/PIN)', () => {
    const result = extractVerificationCode('4821 is your Uber code', '', 'Uber <uber@uber.com>');
    expect(result).toEqual({
      code: '4821',
      service: 'Uber',
    });
  });

  it('extracts from snippet when subject is generic', () => {
    const result = extractVerificationCode(
      'Important: Security Alert',
      'Please enter your verification code 719283 to confirm your identity.',
      'Bank <alerts@bank.com>',
    );
    expect(result).toEqual({
      code: '719283',
      service: 'Bank',
    });
  });

  it('extracts leading standalone code in subject', () => {
    const result = extractVerificationCode(
      '491823 - Slack confirmation code',
      '',
      'Slack <no-reply@slack.com>',
    );
    expect(result).toEqual({
      code: '491823',
      service: 'Slack',
    });
  });

  it('extracts sign-in code with service hyphenation', () => {
    const result = extractVerificationCode(
      '139191 is your Luma sign-in code',
      'Never share this code or enter it anywhere other than luma.com',
      'Luma <support@luma.com>',
    );
    expect(result).toEqual({
      code: '139191',
      service: 'Luma',
    });
  });

  it('extracts code after colon in snippet while ignoring card ending numbers', () => {
    const result = extractVerificationCode(
      'Your SafeKey Verification Code',
      'Your SafeKey Verification CodeDo not share this codeMR J DOEAccount ending: 12345Your verification code for transaction is:502828Here is what you should know',
      'American Express <AmericanExpress@welcome.americanexpress.com>',
    );
    expect(result).toEqual({
      code: '502828',
      service: 'American Express',
    });
  });

  it('extracts passcode from UNiDAYS pattern', () => {
    const result = extractVerificationCode(
      '575720 is your UNiDAYS passcode',
      'ONE-TIME PASSCODE\n\n575720\n\nHere is your passcode.\nIt will expire in 5 minutes.',
      'UNiDAYS <no-reply@auth.myunidays.com>',
    );
    expect(result).toEqual({
      code: '575720',
      service: 'UNiDAYS',
    });
  });

  it('extracts code formatted with asterisks in snippet', () => {
    const result = extractVerificationCode(
      'Your Rippling verification code',
      'Use the code below to verify your email in the next 15 minutes. Do not share this security code with anyone; the Rippling team will never ask you for it. *975713*',
      'Rippling <no-reply@rippling.com>',
    );
    expect(result).toEqual({
      code: '975713',
      service: 'Rippling',
    });
  });

  // Guarding against false positives:
  it('ignores standard non-verification emails', () => {
    expect(
      extractVerificationCode(
        'Team Meeting at 10:00',
        'Hey team, lets meet at 10:00 tomorrow in room 402.',
        'Colleague <colleague@example.com>',
      ),
    ).toBeNull();
  });

  it('ignores receipts and currency amounts', () => {
    expect(
      extractVerificationCode(
        'Receipt for your payment of $1234',
        'Total charged: $1234. Thank you for your purchase.',
        'Store <receipts@store.com>',
      ),
    ).toBeNull();
  });

  it('ignores years in email without verification context', () => {
    expect(
      extractVerificationCode(
        'Happy New Year 2026!',
        'Wishing you a great 2026 from all of us.',
        'Newsletter <news@example.com>',
      ),
    ).toBeNull();
  });

  it('ignores tracking numbers', () => {
    expect(
      extractVerificationCode(
        'Your order has shipped',
        'Tracking number: 9400111202556789. Estimated delivery tomorrow.',
        'Courier <track@courier.com>',
      ),
    ).toBeNull();
  });

  it('ignores phone numbers', () => {
    expect(
      extractVerificationCode(
        'Contact support',
        'Call us at (555) 123-4567 to resolve your issue.',
        'Support <help@example.com>',
      ),
    ).toBeNull();
  });
});
