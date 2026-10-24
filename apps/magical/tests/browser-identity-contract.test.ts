import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Magical presented Chrome headers over a page whose `navigator.userAgentData`
 * still said bare Chromium, and Google blocked sign-in with "This browser or app
 * may not be secure". The cause was structural: the account view was created
 * without a preload, so `applyMainWorldIdentity` never ran.
 *
 * Nothing in a unit test can observe a live page, so this pins the wiring that
 * failed — the file contents, not the behaviour. It is deliberately crude,
 * because the failure it guards is invisible until someone tries to sign in.
 */

const SRC = path.resolve(__dirname, '../src');

function source(name: string): string {
  return fs.readFileSync(path.join(SRC, name), 'utf8');
}

const managerSource = source('accounts-manager.ts');
const preloadSource = source('calendar-preload.ts');

describe('browser identity wiring', () => {
  it('gives every account view a preload', () => {
    // Every view is built in one place, so this is the only site to check.
    expect(managerSource).toMatch(/preload:\s*this\.preloadPath/);
    expect(managerSource).toMatch(/calendar-preload\.js/);
  });

  it('keeps account views unsandboxed, as Magimail does', () => {
    // `contextBridge.executeInMainWorld` is what reaches the page's main world;
    // Magimail's account views run the same preload with sandbox off.
    expect(managerSource).toMatch(/sandbox:\s*false/);
    expect(managerSource).not.toMatch(/sandbox:\s*true/);
  });

  it('patches the main world rather than the isolated one', () => {
    // With contextIsolation on, an ordinary `navigator` patch lands where
    // Google's scripts never look.
    expect(preloadSource).toContain('executeInMainWorld');
    expect(preloadSource).toContain('applyMainWorldIdentity');
  });

  it('takes its brands from core rather than restating them', () => {
    // Headers and page must come from one list. A second copy here is how the
    // two drift into naming different browsers again.
    expect(preloadSource).toContain('chromeBrands');
    expect(preloadSource).toContain('chromeFullVersionBrands');
    expect(preloadSource).not.toMatch(/['"]Google Chrome['"]/);
  });

  it('is built as its own bundle entry', () => {
    const tsup = fs.readFileSync(path.resolve(__dirname, '../tsup.config.ts'), 'utf8');
    expect(tsup).toContain('src/calendar-preload.ts');
  });
});
