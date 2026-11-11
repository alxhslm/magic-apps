import { describe, it, expect } from 'vitest';
import {
  categoryFromTabText,
  derivePresentCategories,
  CATEGORY_TAB_ACTIONS,
  extractTabText,
} from '../src/category-tabs.js';

describe('category-tabs', () => {
  it('maps all 5 category tab actions to canonical categories', () => {
    expect(CATEGORY_TAB_ACTIONS.tabPrimary).toBe('inbox');
    expect(CATEGORY_TAB_ACTIONS.tabPromotions).toBe('promotions');
    expect(CATEGORY_TAB_ACTIONS.tabSocial).toBe('social');
    expect(CATEGORY_TAB_ACTIONS.tabUpdates).toBe('updates');
    expect(CATEGORY_TAB_ACTIONS.tabForums).toBe('forums');
  });

  it('identifies clean English tab labels', () => {
    expect(categoryFromTabText('Primary')).toBe('inbox');
    expect(categoryFromTabText('Promotions')).toBe('promotions');
    expect(categoryFromTabText('Social')).toBe('social');
    expect(categoryFromTabText('Updates')).toBe('updates');
    expect(categoryFromTabText('Forums')).toBe('forums');
  });

  it('identifies tab labels with suffix via startsWith match', () => {
    expect(categoryFromTabText('Updates, one new message,')).toBe('updates');
    expect(categoryFromTabText('Promotions, 5 new messages,')).toBe('promotions');
    expect(categoryFromTabText('Social, 2 new messages,')).toBe('social');
  });

  it('returns null for unknown tabs', () => {
    expect(categoryFromTabText('Starred')).toBeNull();
    expect(categoryFromTabText('Drafts')).toBeNull();
    expect(categoryFromTabText('')).toBeNull();
  });

  it('derives present categories from tab text lists', () => {
    const texts = ['Primary', 'Promotions', 'Social', 'Updates', 'Forums'];
    expect(derivePresentCategories(texts)).toEqual([
      'inbox',
      'promotions',
      'social',
      'updates',
      'forums',
    ]);
  });

  it('handles partial category tab configurations (e.g. only Primary and Updates enabled)', () => {
    const texts = ['Primary', 'Updates, one new message,'];
    expect(derivePresentCategories(texts)).toEqual(['inbox', 'updates']);
  });

  it('retains previous categories when in a view without tabs (e.g. thread or label view)', () => {
    const previous = ['inbox', 'social', 'updates'] as const;
    expect(derivePresentCategories([], [...previous])).toEqual(['inbox', 'social', 'updates']);
  });

  it('extracts candidate text from data-tooltip node if present, or aria-label fallback', () => {
    const fakeTabWithTooltip = {
      querySelector: (sel: string) =>
        sel === '[data-tooltip]' ? { textContent: ' Updates ' } : null,
      getAttribute: () => 'Updates, one new message,',
      textContent: '1 new Updates',
    } as unknown as Element;

    expect(extractTabText(fakeTabWithTooltip)).toBe('Updates');

    const fakeTabWithoutTooltip = {
      querySelector: () => null,
      getAttribute: (attr: string) => (attr === 'aria-label' ? 'Promotions, 2 new,' : null),
      textContent: 'Promotions',
    } as unknown as Element;

    expect(extractTabText(fakeTabWithoutTooltip)).toBe('Promotions, 2 new,');
  });
});
