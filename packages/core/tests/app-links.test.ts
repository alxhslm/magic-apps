import { describe, it, expect, vi } from 'vitest';
import {
  appForUrl,
  appLinkDecision,
  appLinkMode,
  modeFromAnswer,
  readApps,
} from '../src/app-links.js';

describe('appForUrl', () => {
  it('names the app that owns a domain, including its subdomains', () => {
    expect(appForUrl('https://www.notion.so/page')?.bundleId).toBe('notion.id');
    expect(appForUrl('https://app.notion.com/p/page')?.bundleId).toBe('notion.id');
    expect(appForUrl('https://linear.app/acme/issue/ABC-1')?.bundleId).toBe('com.linear');
    expect(appForUrl('https://miro.com/app/board/abc')?.bundleId).toBe(
      'com.electron.realtimeboard',
    );
  });

  it('leaves links the table does not name to the browser', () => {
    // Google's own links must keep the account's browser profile, so they are absent on purpose.
    expect(appForUrl('https://drive.google.com/file/d/abc')).toBeNull();
    expect(appForUrl('https://mail.google.com/mail/u/0/#inbox')).toBeNull();
    expect(appForUrl('https://example.com/')).toBeNull();
  });

  it('leaves a host the app does not claim to the browser', () => {
    // Notion's app claims www.notion.so and app.notion.com. Mailgun tracking links and
    // Notion Mail use other subdomains, which the app ignores when handed one.
    expect(appForUrl('https://mg.mail.notion.so/c/abc')).toBeNull();
    expect(appForUrl('https://mail.notion.so/')).toBeNull();
    expect(appForUrl('https://www.notion.com/')).toBeNull();
  });

  it('does not match a lookalike host', () => {
    expect(appForUrl('https://notion.so.evil.test/page')).toBeNull();
    expect(appForUrl('https://fake-notion.so/page')).toBeNull();
  });

  it('ignores non-web schemes and junk', () => {
    expect(appForUrl('mailto:alex@corp.com')).toBeNull();
    expect(appForUrl('not a url')).toBeNull();
  });

  it('ships a table every entry of which is readable', () => {
    const apps = readApps();
    expect(apps.length).toBeGreaterThanOrEqual(5);
    for (const app of apps) {
      expect(app.bundleId).toMatch(/^[A-Za-z0-9.-]+$/);
      expect(app.hosts.length).toBeGreaterThan(0);
    }
  });
});

describe('appLinkDecision', () => {
  const notion = { name: 'Notion', bundleId: 'notion.id', hosts: ['notion.so'] };

  it('opens the app when that app is set to always', async () => {
    const decision = await appLinkDecision(notion, appLinkMode(notion, { 'notion.id': 'auto' }));
    expect(decision.useApp).toBe(true);
    // An app with no answer recorded is automatic too.
    expect((await appLinkDecision(notion, appLinkMode(notion, {}))).useApp).toBe(true);
  });

  it('never opens the app when that app is set to never', async () => {
    const decision = await appLinkDecision(notion, appLinkMode(notion, { 'notion.id': 'never' }));
    expect(decision.useApp).toBe(false);
  });

  it('asks when that app is set to ask, and follows the answer', async () => {
    const ask = vi.fn().mockResolvedValue({ choice: 'browser', dontAskAgain: false });
    const decision = await appLinkDecision(
      notion,
      appLinkMode(notion, { 'notion.id': 'ask' }),
      ask,
    );

    expect(decision.useApp).toBe(false);
    expect(ask).toHaveBeenCalledWith(notion);
  });

  it('turns a remembered answer into the setting it stands for', () => {
    expect(modeFromAnswer({ choice: 'app', dontAskAgain: true })).toBe('auto');
    expect(modeFromAnswer({ choice: 'browser', dontAskAgain: true })).toBe('never');
  });

  it('reads an unknown or malformed setting as automatic', () => {
    expect(appLinkMode(notion, { 'notion.id': 'nonsense' as never })).toBe('auto');
    expect(appLinkMode(notion, undefined)).toBe('auto');
  });
});
