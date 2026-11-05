import { describe, it, expect, vi } from 'vitest';
import { appForUrl, appLinkDecision, readApps } from '../src/app-links.js';

describe('appForUrl', () => {
  it('names the app that owns a domain, including its subdomains', () => {
    expect(appForUrl('https://www.notion.so/page')?.bundleId).toBe('notion.id');
    expect(appForUrl('https://app.notion.com/p/page')?.bundleId).toBe('notion.id');
    expect(appForUrl('https://linear.app/acme/issue/ABC-1')?.bundleId).toBe('com.linear');
  });

  it('leaves links the table does not name to the browser', () => {
    // Google's own links must keep the account's browser profile, so they are absent on purpose.
    expect(appForUrl('https://drive.google.com/file/d/abc')).toBeNull();
    expect(appForUrl('https://mail.google.com/mail/u/0/#inbox')).toBeNull();
    expect(appForUrl('https://example.com/')).toBeNull();
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

  it('opens the app when the setting says always', async () => {
    expect((await appLinkDecision(notion, 'notion.so', 'auto', undefined)).useApp).toBe(true);
  });

  it('never opens the app when the setting says never', async () => {
    expect((await appLinkDecision(notion, 'notion.so', 'never', undefined)).useApp).toBe(false);
  });

  it('asks when the setting says ask, and follows the answer', async () => {
    const ask = async () => ({ choice: 'browser' as const, remember: false });
    expect((await appLinkDecision(notion, 'notion.so', 'ask', undefined, ask)).useApp).toBe(false);
  });

  it('does not ask twice once the answer is remembered', async () => {
    const ask = vi.fn();
    const decision = await appLinkDecision(notion, 'notion.so', 'ask', { 'notion.so': 'app' }, ask);

    expect(decision.useApp).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('lets a remembered answer override the always setting', async () => {
    const decision = await appLinkDecision(notion, 'notion.so', 'auto', { 'notion.so': 'browser' });
    expect(decision.useApp).toBe(false);
  });
});
