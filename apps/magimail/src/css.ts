import type { WebContents } from 'electron';
import { labelSelectors } from '@magimail/core';
import { getDarkModeCss, getLightModeCss } from './dark-mode.js';
import { domAction, domSelector } from './dom-labels.js';

export { RESTORE_FILTER } from './dark-mode.js';

/**
 * The bare "Ad" label under a `contains` match, emitted only inside the
 * dialog-qualified rule.
 *
 * `match` is per action and "Ad" is a substring of "read", so a bare
 * `[aria-label*="ad" i]` clause would match `data-tooltip="Mark as unread"` and
 * hide the whole inbox. The one place Gmail needs `contains "Ad"` is the ad
 * badge's `aria-haspopup="dialog"`, so the fragments are only ever used behind
 * that qualifier; the unqualified matches are on the exact action instead.
 */
const AD_DIALOG_FRAGMENTS = labelSelectors({
  labels: { en: ['Ad'] },
  match: 'contains',
  order: 'first',
});

/**
 * The `:lang()`-scoped attribute fragments for a locale-map action, joined for a
 * `:is()` list. A label clause built here carries the same match the page-side
 * `findAction` uses, and only applies to a page in the language the label is
 * written for, so a non-English account is not styled as if it were English.
 */
function labelUnion(actionKey: string): string {
  return labelSelectors(domAction(actionKey)).join(', ');
}

/**
 * Clean baseline CSS for Gmail integration in Magimail
 */
export function getGmailCustomCss(): string {
  return `
/* Magimail Clean Integration CSS */

/* 1. Hide redundant browser/download banners */
div[role="alert"]:has(a[href*="google.com/chrome"]),
div[role="alert"]:has(a[href*="chrome"]) {
  display: none !important;
}

/* 2. Vibrancy — make Gmail chrome transparent so macOS vibrancy shows through */
html, body, #loading {
  background: transparent !important;
}
/* Gmail's decoration panel divs — empty backdrop panels behind the chrome.
   Scoped to empty elements so they never strip backgrounds from mail controls or thread elements. */
div.wl:empty, div.wq:empty, div.wp:empty, div.wo:empty, div.wn:empty {
  background-color: transparent !important;
}
/* Sidebar — only make the container itself transparent, not descendants.
   Child elements keep their backgrounds (needed for mask-image icons). */
div[role="navigation"] {
  background-color: transparent !important;
}

/* Categories folded locally. Gmail's own fold removes these rows from the DOM,
   which blinds the sidebar unread observer; the preload swallows the disclosure
   click and sets this class instead, so the rows stay in the tree and keep
   reporting their counts while the user sees them folded. */
html.magimail-categories-collapsed [data-magimail-category-row] {
  display: none !important;
}
/* Gmail still draws the control open, so the arrow is turned here. */
html.magimail-categories-collapsed [data-magimail-categories-toggle] {
  transform: rotate(-90deg);
}
/* Header bar — but preserve search box */
header[role="banner"],
header[role="banner"] > div {
  background-color: transparent !important;
}

/* Dialogs and the Quick-settings dropdown keep a solid background, so vibrancy
   does not bleed through and make their text unreadable. The Quick-settings label
   is a map action, so its clause carries the label's language rather than matching
   English on every account.

   The full Settings page needs no clause: Gmail renders it under
   div[role="main"] with its own opaque container (measured rgb(255, 255, 255) on
   the en-GB build on 2026-10-01), so it is already solid. The earlier
   div[role="region"][aria-label*="Settings"] clause matched no element on the
   inbox or the Settings page and was removed. */
div:is(${labelUnion('quickSettings')}),
div[role="dialog"] {
  background-color: #ffffff !important;
}

/* Companion sidebar icon strip — transparent so native vibrancy shows through */
div[role="complementary"],
div[role="complementary"] [role="tablist"],
div[role="complementary"] [role="tab"] {
  background-color: transparent !important;
}

/* Companion drawer panel behind Tasks / Calendar / Keep when opened — solid background */
div[role="tabpanel"]:has(iframe) {
  background-color: #ffffff !important;
}

/* 3. Native macOS refined scrollbars */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.3);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(128, 128, 128, 0.55);
}

/* 4. Native Print & PDF Export Styling */
@media print {
  html, body {
    background: #ffffff !important;
  }
  div[role="navigation"],
  header[role="banner"],
  div[role="complementary"],
  div:is(${labelUnion('sidePanelToggle')}),
  div[role="toolbar"] {
    display: none !important;
  }
  div[role="main"] {
    width: 100% !important;
    max-width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
    background: #ffffff !important;
    position: static !important;
  }
}
`;
}

/**
 * Explicit light mode resets — undoes everything dark mode sets.
 * The rules and their resets are `apps/magimail/dark-mode.json`.
 */
export function getGmailLightModeCss(): string {
  return getLightModeCss('main');
}

/**
 * The dark-mode stylesheet, built from `apps/magimail/dark-mode.json`.
 * The filter chain and every exemption are in that data file.
 */
export function getGmailDarkModeCss(): string {
  return getDarkModeCss('main');
}

/**
 * CSS to hide ad rows in Gmail (Promotions, Social tabs).
 * Targets true sponsored ads using semantic attributes and ad badge indicators
 * without affecting genuine unread message rows (which use tr.zA.zE).
 */
export function getHideAdsCss(): string {
  // One `tr[role="row"]:has(...)` rule per `:lang()`-scoped label fragment, so a
  // row is hidden on whatever its own locale calls an ad rather than only in
  // English. The structural scoping is unchanged from the hand-written rules.
  //
  // The bare "Ad" and "Sponsored" are matched exactly; only the longer phrases
  // and the dialog-qualified badge use `contains`, because "Ad" is a substring
  // of "read" and a bare `*= "ad"` clause hides every inbox row.
  const rowRules = (actionKey: string) =>
    labelSelectors(domAction(actionKey)).map((fragment) => `tr[role="row"]:has(${fragment})`);
  const rules = [
    ...rowRules('adRowExact'),
    ...rowRules('adRowPhrase'),
    `tr[role="row"]:has([aria-haspopup="dialog"]:is(${AD_DIALOG_FRAGMENTS.join(', ')}))`,
  ].join(',\n');
  return `
/* Gmail sponsored ad rows in Promotions/Social tabs */
${rules} {
  display: none !important;
}
`;
}

/**
 * CSS to hide the right-hand app sidebar (Calendar, Keep, Tasks, etc) and its toggle button.
 * Targets the companion panel container and expand/collapse arrow button semantically,
 * ensuring Quick settings and Gemini side drawers remain visible and functional.
 */
export function getHideSidebarCss(): string {
  // The container is a strong hook in the map; the toggle has only a label.
  const sidePanel = domSelector('sidePanel');
  return `
/* Right side companion panel and toggle arrow button */
div:has(> ${sidePanel}),
${sidePanel},
[role="button"]:is(${labelUnion('sidePanelToggle')}) {
  display: none !important;
}
`;
}

/**
 * Dark mode CSS for subframes (e.g. Google Apps drawer, third-party add-on panels).
 * Counter-inverts media and background-image / sprite icons so their authentic
 * colors are preserved when rendered within the inverted root page.
 */
export function getSubframeDarkModeCss(): string {
  return getDarkModeCss('subframe');
}

/**
 * Light mode reset CSS for subframes.
 */
export function getSubframeLightModeCss(): string {
  return getLightModeCss('subframe');
}

/**
 * Injects Gmail custom CSS into the given WebContents
 */
export async function injectGmailStyles(
  webContents: WebContents,
  options?: {
    darkMode?: boolean;
    hideAds?: boolean;
    hideSidebar?: boolean;
  },
): Promise<void> {
  const parts = [getGmailCustomCss()];
  if (options?.darkMode) {
    parts.push(getGmailDarkModeCss());
  } else {
    parts.push(getGmailLightModeCss());
  }
  if (options?.hideAds) parts.push(getHideAdsCss());
  if (options?.hideSidebar) parts.push(getHideSidebarCss());
  const css = parts.join('\n');
  // Update style in place (atomic textContent swap — no frame without styles)
  await webContents.executeJavaScript(
    `(()=>{` +
      `let s=document.getElementById('magimail-injected-styles');` +
      `if(!s){s=document.createElement('style');s.id='magimail-injected-styles';document.head.appendChild(s);}` +
      `s.textContent=${JSON.stringify(css)};` +
      `})()`,
  );
}
