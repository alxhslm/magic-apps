import { Buffer } from 'node:buffer';
import { describe, it, expect } from 'vitest';
import { inspectText } from './check-privacy.mjs';

/**
 * The gate is the mechanism the rest of the privacy work leans on. If it fails open it
 * silently stops protecting anything, so these pin the two ways it can be wrong: missing a
 * denylisted term, and flagging a synthetic fixture.
 */
describe('the privacy gate', () => {
  it('refuses a denylisted term, case-insensitively', () => {
    expect(inspectText('x.ts', 'the Acme-Corp case', ['acme-corp'])).toEqual([
      'x.ts: sensitive term "acme-corp"',
    ]);
  });

  it('passes text that names no denylisted term', () => {
    expect(inspectText('x.ts', 'the Current case', ['acme-corp'])).toEqual([]);
  });

  it('refuses a real address in the commit message', () => {
    const findings = inspectText('message', 'mail someone@client.co', [], { emails: true });
    expect(findings.some((f) => f.includes('someone@client.co'))).toBe(true);
  });

  it('allows a synthetic address in the commit message', () => {
    expect(inspectText('message', 'mail someone@work.com', [], { emails: true })).toEqual([]);
  });

  it('does not sweep addresses out of a file, where fixtures legitimately invent them', () => {
    expect(inspectText('x.test.ts', 'alice@gmail.com', [])).toEqual([]);
  });

  it('still guards a file with the denylist', () => {
    expect(inspectText('x.test.ts', 'Acme-Corp', ['acme-corp'])).toHaveLength(1);
  });

  it('detects a denylisted term hidden inside a base64 string', () => {
    // Buffer.from('sensitive acme-corp info').toString('base64') -> 'c2Vuc2l0aXZlIGFjbWUtY29ycCBpbmZv'
    const b64 = Buffer.from('sensitive acme-corp info').toString('base64');
    const findings = inspectText('chip.ts', `const chip = "${b64}";`, ['acme-corp']);
    expect(findings.some((f) => f.includes('sensitive term "acme-corp" in base64 token'))).toBe(
      true,
    );
  });

  it('detects a non-test email hidden inside a base64 string', () => {
    // Dynamically construct string so test file doesn't have the literal b64 token
    const raw = ['leak', '@', 'forbidden-domain', '.com'].join('');
    const b64 = Buffer.from(raw).toString('base64');
    const findings = inspectText('chip.ts', `const chip = "${b64}";`, []);
    expect(findings.some((f) => f.includes(`non-test email "${raw}" in base64 token`))).toBe(true);
  });

  it('allows synthetic base64 email addresses', () => {
    // Buffer.from('me@work.com').toString('base64') -> 'bWVAd29yay5jb20='
    const b64 = Buffer.from('me@work.com').toString('base64');
    expect(inspectText('chip.ts', `const chip = "${b64}";`, [])).toEqual([]);
  });
});
