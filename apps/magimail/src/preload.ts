import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { applyMainWorldIdentity, chromeBrands, chromeFullVersionBrands } from '@magimail/core';
import { IPC_CHANNELS } from './constants.js';

// Suppress automatic window.print() on Gmail print view (view=pt) so Magimail controls printing
try {
  if (window.location && window.location.search && window.location.search.includes('view=pt')) {
    Object.defineProperty(window, 'print', {
      value: () => {},
      writable: false,
      configurable: true,
    });
    if (webFrame && typeof webFrame.executeJavaScript === 'function') {
      webFrame
        .executeJavaScript(
          `try { Object.defineProperty(window, 'print', { value: () => {}, writable: false, configurable: true }); } catch {}`,
        )
        .catch(() => {});
    }
  }
} catch {
  // Ignore
}

// 1. Complete the browser identity in the page's main world.
// `contextIsolation: true` means anything defined on `navigator` from here would
// never reach Google's scripts; `executeInMainWorld` does.
try {
  contextBridge.executeInMainWorld({
    func: applyMainWorldIdentity,
    args: [chromeBrands(), chromeFullVersionBrands()],
  });
} catch {
  // Ignore
}

// 2. Expose safe bridge API for renderer/injection scripts
const bridgeApi = {
  sendContentHeight: (height: number) => {
    ipcRenderer.send(IPC_CHANNELS.CONTENT_HEIGHT_CHANGED, height);
  },
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_VERSION),
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('magimailBridge', bridgeApi);
  } catch {
    // Ignore
  }
} else {
  (window as unknown as Record<string, unknown>).magimailBridge = bridgeApi;
}

// 3. Sidebar Navigation Unread Observer
//
// Scoped strictly to Gmail's left navigation (`div[role="navigation"]`).
// Extracts real-time scalar counts for `#inbox` and any categories present
// in the sidebar (`#category/...`). Delivers 0ms synchronous badge updates
// without global click/keydown interception or title parsing.

let lastReportJson: string | null = null;
let sidebarDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function parseUnreadFromLink(link: Element): number {
  // 1. Look for child element containing numeric text badge
  const descendants = link.querySelectorAll('div, span');
  for (let i = descendants.length - 1; i >= 0; i--) {
    const text = (descendants[i].textContent || '').trim().replace(/,/g, '');
    const match = text.match(/^(\d+)(?:\+)?$/);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  // 2. Fall back to aria-label on the link or its parent treeitem
  const ariaLabel =
    link.getAttribute('aria-label') ||
    link.closest('[role="treeitem"]')?.getAttribute('aria-label') ||
    '';
  if (ariaLabel) {
    const numMatch = ariaLabel.match(
      /(?:^|[^\d])(\d[\d,]*)(?:\+)?\s*(?:unread|non lu|ungelesen|\)|$)/i,
    );
    if (numMatch) {
      return parseInt(numMatch[1].replace(/,/g, ''), 10);
    }
    return 0;
  }

  return 0;
}

function detectCategoriesSection(nav: Element): boolean {
  // The category links are the signal: an account has the section when its
  // sidebar renders one of the four supported categories. Matching the English
  // word "Categories" was a second signal that only worked in English.
  return Boolean(
    nav.querySelector(
      'a[href*="#category/social"], a[href*="#category/updates"], a[href*="#category/promotions"], a[href*="#category/forums"]',
    ),
  );
}

function isSidebarLoaded(nav: Element): boolean {
  // Gmail's mailbox and navigation are loaded once:
  // 1. The main content container (div[role="main"]) is mounted
  // 2. The navigation contains the inbox link
  // 3. The navigation has rendered its standard menu items
  const hasMain = Boolean(document.querySelector('div[role="main"]'));
  const hasInbox = Boolean(nav.querySelector('a[href*="#inbox"]'));
  const hasItems = nav.querySelectorAll('a, [role="treeitem"]').length >= 4;
  return hasMain && hasInbox && hasItems;
}

// Folding the Categories section
//
// Gmail's fold deletes the category rows, and those rows are where the counts
// above are read from. So the fold is done in CSS instead: the rows stay, the
// user sees them hidden. Gmail never records it, so the state is ours.

const COLLAPSED_CLASS = 'magimail-categories-collapsed';
const COLLAPSED_KEY = 'magimail:categories-collapsed';
const ROW_ATTR = 'data-magimail-category-row';
const TOGGLE_ATTR = 'data-magimail-categories-toggle';

function isCategoriesCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    // A partition with storage blocked still folds; it just does not remember
    // across a reload.
    return false;
  }
}

function applyCategoriesCollapsed(): void {
  document.documentElement?.classList.toggle(COLLAPSED_CLASS, isCategoriesCollapsed());
}

function setCategoriesCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // See isCategoriesCollapsed.
  }
  applyCategoriesCollapsed();
}

/**
 * The sidebar row owning a link: the largest ancestor that still holds only
 * that one link.
 *
 * Gmail gives these rows no role, label or stable attribute, so a row is found
 * by what it contains rather than by what it is called.
 */
function sidebarRowFor(link: Element, nav: Element): Element | null {
  let row: Element = link;
  for (let depth = 0; depth < 8; depth++) {
    const parent = row.parentElement;
    if (!parent || parent === nav) break;
    if (parent.querySelectorAll('a[href]').length > 1) break;
    row = parent;
  }
  return row === link ? null : row;
}

/**
 * Mark the category rows and the control that folds them.
 *
 * Every `#category/` row is marked, Purchases included: the unread count
 * ignores it, but it belongs to the section the user is folding.
 */
function markCategorySection(nav: Element): void {
  let firstRow: Element | null = null;
  for (const link of Array.from(nav.querySelectorAll('a[href*="#category/"]'))) {
    const row = sidebarRowFor(link, nav);
    if (!row) continue;
    row.setAttribute(ROW_ATTR, '');
    if (!firstRow) firstRow = row;
  }
  if (!firstRow || nav.querySelector(`[${TOGGLE_ATTR}]`)) return;

  // The parent row precedes the first child row, as a sibling of it or of the
  // group Gmail wraps the children in. Matching the word "Categories" would
  // only work in English, so the arrow is found by position instead.
  const candidates: Element[] = [];
  let scope: Element | null = firstRow;
  for (let level = 0; level < 2 && scope; level++) {
    let previous = scope.previousElementSibling;
    for (let back = 0; back < 4 && previous; back++) {
      candidates.push(previous);
      previous = previous.previousElementSibling;
    }
    scope = scope.parentElement;
  }
  for (const candidate of candidates) {
    const toggle = candidate.querySelector('[role="link"]:not([href])');
    if (toggle) {
      toggle.setAttribute(TOGGLE_ATTR, '');
      claimDisclosure(toggle);
      return;
    }
  }
}

/**
 * Take the fold off Gmail, on the control itself.
 *
 * Gmail delegates its own handler from somewhere below the sidebar root, so a
 * capture listener on this element runs first and `stopImmediatePropagation`
 * is enough to keep the rows. Listening any wider would put us in the path of
 * every click in the page to no purpose; the tradeoff is that Gmail moving to
 * a capture handler above this element would win, and the section would fold
 * the way it always did with the last known count covering the number.
 *
 * Attached where the control is marked, which only happens when there is not
 * already one marked, so a rebuilt control is claimed exactly once.
 */
function claimDisclosure(toggle: Element): void {
  const swallow = (event: Event) => {
    // Gmail folds off whichever of the three it sees first, so all three are
    // stopped; only the click decides the new state.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'click') setCategoriesCollapsed(!isCategoriesCollapsed());
  };
  for (const type of ['mousedown', 'mouseup', 'click']) {
    toggle.addEventListener(type, swallow, true);
  }
}

let lastUserInteractionAt = 0;
window.addEventListener(
  'click',
  () => {
    lastUserInteractionAt = Date.now();
  },
  { capture: true, passive: true },
);
window.addEventListener(
  'keydown',
  () => {
    lastUserInteractionAt = Date.now();
  },
  { capture: true, passive: true },
);

function scanSidebar() {
  const nav = document.querySelector('div[role="navigation"]');
  if (!nav) return;

  markCategorySection(nav);
  applyCategoriesCollapsed();

  const presentCategories: ('inbox' | 'updates' | 'promotions' | 'social' | 'forums')[] = [];
  const counts: Record<string, number> = {};

  // 1. Inbox (Primary)
  const inboxLink = nav.querySelector('a[href*="#inbox"]:not([href*="#inbox/"])');
  if (inboxLink) {
    presentCategories.push('inbox');
    counts.inbox = parseUnreadFromLink(inboxLink);
  }

  // 2. Categories
  const categoryKeys = ['updates', 'promotions', 'social', 'forums'] as const;
  for (const cat of categoryKeys) {
    const catLink = nav.querySelector(`a[href*="#category/${cat}"]`);
    if (catLink) {
      presentCategories.push(cat);
      // Category rows in Gmail's sidebar (#category/...) are label-scoped and count
      // archived unread mail across the entire smartlabel query. We do not extract
      // scalar counts from them for inbox unread totals.
    }
  }

  const hasCategoriesSection = detectCategoriesSection(nav);
  const isLoaded = isSidebarLoaded(nav);

  const report = {
    timestamp: Date.now(),
    lastUserInteractionAt,
    counts,
    presentCategories,
    hasCategoriesSection,
    isLoaded,
  };

  const reportJson = JSON.stringify({ counts, presentCategories, hasCategoriesSection, isLoaded });
  if (reportJson !== lastReportJson) {
    lastReportJson = reportJson;
    ipcRenderer.send(IPC_CHANNELS.DOM_UNREAD_UPDATE, report);
    ipcRenderer.send(IPC_CHANNELS.MAILBOX_CHANGE_HINT);
  }
}

function queueSidebarScan() {
  if (sidebarDebounceTimer) return;
  sidebarDebounceTimer = setTimeout(() => {
    sidebarDebounceTimer = null;
    scanSidebar();
  }, 20);
}

function initSidebarObserver() {
  const attachObserver = (nav: Element) => {
    const observer = new MutationObserver(() => {
      // Marking runs here rather than inside the debounced scan. Gmail rebuilds
      // these rows whenever the selected mailbox or a count changes, and a
      // rebuilt row carries none of our attributes; waiting out the debounce
      // would paint it before it was marked, so a folded section flashes its
      // rows back on every navigation. Observer callbacks are microtasks, so
      // marking here lands before the frame.
      markCategorySection(nav);
      applyCategoriesCollapsed();
      queueSidebarScan();
    });
    observer.observe(nav, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-label', 'title', 'class'],
    });
    queueSidebarScan();
  };

  const nav = document.querySelector('div[role="navigation"]');
  if (nav) {
    attachObserver(nav);
  } else {
    const bodyObserver = new MutationObserver(() => {
      const found = document.querySelector('div[role="navigation"]');
      if (found) {
        bodyObserver.disconnect();
        attachObserver(found);
      }
    });
    bodyObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // Observe the main content container (message list & triage actions) to emit
  // MAILBOX_CHANGE_HINT when unread emails are archived or modified within categories.
  let triageDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const queueTriageHint = () => {
    if (triageDebounceTimer) return;
    triageDebounceTimer = setTimeout(() => {
      triageDebounceTimer = null;
      ipcRenderer.send(IPC_CHANNELS.MAILBOX_CHANGE_HINT);
    }, 200);
  };

  const attachMainObserver = (main: Element) => {
    const mainObserver = new MutationObserver(() => {
      queueTriageHint();
    });
    mainObserver.observe(main, {
      childList: true,
      subtree: true,
    });
  };

  const main = document.querySelector('div[role="main"]');
  if (main) {
    attachMainObserver(main);
  } else {
    const mainFinder = new MutationObserver(() => {
      const foundMain = document.querySelector('div[role="main"]');
      if (foundMain) {
        mainFinder.disconnect();
        attachMainObserver(foundMain);
      }
    });
    mainFinder.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
}

function initSidebar(): void {
  applyCategoriesCollapsed();
  initSidebarObserver();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSidebar);
} else {
  initSidebar();
}

// 4. Network status monitoring
window.addEventListener('online', () => {
  ipcRenderer.send(IPC_CHANNELS.NETWORK_STATUS_CHANGED, true);
});
window.addEventListener('offline', () => {
  ipcRenderer.send(IPC_CHANNELS.NETWORK_STATUS_CHANGED, false);
});
