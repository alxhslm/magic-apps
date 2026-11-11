import type { NotificationCategory } from './atom-poller.js';
import { DOM_ACTION_MAP } from './dom-labels.js';

export type PresentCategory = 'inbox' | NotificationCategory;

export const CATEGORY_TAB_ACTIONS: Record<string, PresentCategory> = {
  tabPrimary: 'inbox',
  tabPromotions: 'promotions',
  tabSocial: 'social',
  tabUpdates: 'updates',
  tabForums: 'forums',
};

/**
 * Checks whether an element's text or aria-label matches a given category tab action.
 */
export function matchCategoryTab(
  tabText: string,
  actionName: keyof typeof CATEGORY_TAB_ACTIONS,
  locale = 'en',
): boolean {
  const action = DOM_ACTION_MAP.actions[actionName];
  if (!action || !action.labels) return false;

  const normalizedText = tabText.trim().toLowerCase();
  if (!normalizedText) return false;

  const base = locale.split(/[-_]/)[0].toLowerCase();
  const candidateLists = [action.labels[locale], action.labels[base], action.labels.en].filter(
    (list): list is string[] => Array.isArray(list),
  );

  for (const list of candidateLists) {
    for (const label of list) {
      const normalizedLabel = label.trim().toLowerCase();
      if (!normalizedLabel) continue;
      if (action.match === 'startsWith') {
        if (normalizedText.startsWith(normalizedLabel)) return true;
      } else if (action.match === 'contains') {
        if (normalizedText.includes(normalizedLabel)) return true;
      } else {
        if (normalizedText === normalizedLabel) return true;
      }
    }
  }

  return false;
}

/**
 * Identifies the category of a single tab from its text candidate.
 */
export function categoryFromTabText(tabText: string, locale = 'en'): PresentCategory | null {
  for (const [actionName, cat] of Object.entries(CATEGORY_TAB_ACTIONS)) {
    if (matchCategoryTab(tabText, actionName as keyof typeof CATEGORY_TAB_ACTIONS, locale)) {
      return cat;
    }
  }
  return null;
}

/**
 * Extracts candidate text for a tab element using data-tooltip text or aria-label.
 */
export function extractTabText(tab: Element): string {
  const tooltipNode = tab.querySelector('[data-tooltip]');
  if (tooltipNode && tooltipNode.textContent) {
    const text = tooltipNode.textContent.trim();
    if (text) return text;
  }
  return tab.getAttribute('aria-label') || tab.textContent?.trim() || '';
}

/**
 * Derives present categories from tab elements in `div[role="main"]`.
 * When tabs are present, extracts categories from matching labels.
 * When tabs are absent (e.g. thread or label view), retains the previously detected set
 * (or defaults to `['inbox']`).
 */
export function derivePresentCategories(
  tabTexts: string[],
  previousCategories: PresentCategory[] = ['inbox'],
  locale = 'en',
): PresentCategory[] {
  if (tabTexts.length === 0) {
    return previousCategories;
  }

  const detected: PresentCategory[] = [];
  for (const text of tabTexts) {
    const cat = categoryFromTabText(text, locale);
    if (cat && !detected.includes(cat)) {
      detected.push(cat);
    }
  }

  return detected.length > 0 ? detected : previousCategories;
}
