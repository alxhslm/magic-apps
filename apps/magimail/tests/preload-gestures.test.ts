import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const preloadSource = readFileSync(path.join(REPO_ROOT, 'apps/magimail/src/preload.ts'), 'utf8');

describe('sidebar-driven mailbox unread observer contract', () => {
  it('scopes strictly to div[role="navigation"]', () => {
    expect(preloadSource).toContain('div[role="navigation"]');
    expect(preloadSource).toMatch(/a\[href\*="#inbox"/);
    expect(preloadSource).toMatch(/a\[href\*="#category\/\$\{cat\}"\]/);
  });

  it('eliminates global click and keydown listeners from preload', () => {
    // No global keydown listener capturing every keystroke in Gmail
    expect(preloadSource).not.toMatch(/document\.addEventListener\(\s*['"]keydown['"]/);
    // No global click listener evaluating 17-clause action selector on every
    // click, and no pointer listener on the document by any other spelling.
    expect(preloadSource).not.toMatch(
      /document\.addEventListener\(\s*(?:type|['"](?:click|mousedown|mouseup|keydown)['"])/,
    );
    expect(preloadSource).not.toMatch(/ACTION_BUTTON_SELECTOR/);
    expect(preloadSource).not.toMatch(/isMailActionKey/);
  });

  it('claims the Categories disclosure on the control itself, not on a container', () => {
    // Gmail delegates its fold from below the sidebar root, so a capture
    // listener on the control runs first. Listening any wider would sit in the
    // path of every click in the page for no gain.
    expect(preloadSource).toMatch(/toggle\.addEventListener\(type, swallow, true\)/);
    expect(preloadSource).not.toMatch(/nav\.addEventListener\(/);
  });

  it('folds the Categories section in CSS so the rows stay readable', () => {
    // Gmail's own fold removes the rows, which blinds the observer above.
    expect(preloadSource).toContain('magimail-categories-collapsed');
    expect(preloadSource).toContain('data-magimail-category-row');
    expect(preloadSource).toMatch(/event\.preventDefault\(\);/);
    expect(preloadSource).toMatch(/event\.stopImmediatePropagation\(\);/);
    // Purchases is not counted, but it is folded with the rest of the section.
    expect(preloadSource).toMatch(/querySelectorAll\('a\[href\*="#category\/"\]'\)/);
  });

  it('marks rows in the observer callback, not behind the scan debounce', () => {
    // A row Gmail rebuilds carries none of our attributes. Marking it only
    // after the debounce paints it first, so a folded section flashes its rows
    // back on every navigation.
    const callback = preloadSource.match(/new MutationObserver\(\(\) => \{[\s\S]*?\n {4}\}\);/);
    expect(callback).not.toBeNull();
    expect(callback?.[0]).toContain('markCategorySection(nav)');
    expect(callback?.[0]).toContain('applyCategoriesCollapsed()');
  });

  it('finds the disclosure control by position rather than by its label', () => {
    // The control carries no role, label or tooltip naming it, and matching the
    // word "Categories" would only hold in English.
    expect(preloadSource).toContain('previousElementSibling');
    expect(preloadSource).toMatch(/\[role="link"\]:not\(\[href\]\)/);
    expect(preloadSource).not.toMatch(/\/\^Categories\$\/i/);
  });

  it('never parses unread counts from document.title', () => {
    expect(preloadSource).not.toMatch(/parseUnreadCountFromTitle/);
    expect(preloadSource).not.toMatch(/onTitleMutation/);
  });

  it('coalesces DOM changes with a short debounce and dispatches DOM_UNREAD_UPDATE', () => {
    expect(preloadSource).toContain('IPC_CHANNELS.DOM_UNREAD_UPDATE');
    expect(preloadSource).toMatch(/setTimeout\(\s*\(\)\s*=>\s*\{[\s\S]*?20\s*\)/);
  });

  it('leaves DOM banner injection out of preload in favor of native UI', () => {
    expect(preloadSource).not.toContain('magimail-category-banner');
  });
});
