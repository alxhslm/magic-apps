import { describe, it, expect } from 'vitest';
import { isAccountEmail } from '../src/account-email.js';

describe('isAccountEmail', () => {
  it('accepts the addresses Google signs an account in with', () => {
    expect(isAccountEmail('alex@corp.com')).toBe(true);
    expect(isAccountEmail('alex.haslam+mail@mail.example.co.uk')).toBe(true);
    expect(isAccountEmail('  alex@corp.com  ')).toBe(true);
  });

  it('rejects what a half-rendered chip or a display name would produce', () => {
    expect(isAccountEmail('')).toBe(false);
    expect(isAccountEmail('Alex Haslam')).toBe(false);
    expect(isAccountEmail('@corp.com')).toBe(false);
    expect(isAccountEmail('alex@')).toBe(false);
    expect(isAccountEmail('alex@corp')).toBe(false);
    expect(isAccountEmail('alex@corp.com (work)')).toBe(false);
    expect(isAccountEmail(undefined)).toBe(false);
    expect(isAccountEmail(42)).toBe(false);
  });
});
