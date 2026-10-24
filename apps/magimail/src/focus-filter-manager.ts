import { createLogger } from '@magimail/core/logger';

const log = createLogger('FocusFilter');

export interface FocusFilterState {
  activeAccountIds: string[];
  /**
   * Whether excluded accounts are made unreachable as well as silenced.
   *
   * Off (the default) they stay fully usable and are only de-emphasised in the
   * switcher and the Accounts menu. On, they are greyed out and cannot be
   * selected. Either way they keep their place in both lists — see
   * `docs/magimail/focus-filters.md` for why nothing is ever removed.
   */
  disableExcludedAccounts: boolean;
  isFilterActive?: boolean;
}

export type FocusFilterChangeCallback = (filter: FocusFilterState | null) => void;

let currentFilter: FocusFilterState | null = null;
const listeners = new Set<FocusFilterChangeCallback>();

/**
 * Get a copy of the current active Focus Filter, or null if no filter is active.
 */
export function getActiveFocusFilter(): FocusFilterState | null {
  return currentFilter
    ? { ...currentFilter, activeAccountIds: [...currentFilter.activeAccountIds] }
    : null;
}

/**
 * Update the active Focus Filter state. Setting activeAccountIds to empty clears the filter.
 */
export function setFocusFilter(filter: FocusFilterState | null): void {
  if (filter && filter.activeAccountIds.length > 0) {
    currentFilter = {
      activeAccountIds: [...filter.activeAccountIds],
      disableExcludedAccounts: Boolean(filter.disableExcludedAccounts),
      isFilterActive: true,
    };
  } else {
    currentFilter = null;
  }

  // The report is "notifications stopped for my work account", and until this
  // line nothing on either side of Magimail said a filter was on at all.
  log.info(
    currentFilter
      ? `Filter active; ${currentFilter.activeAccountIds.length} account(s) stay on, excluded accounts ${currentFilter.disableExcludedAccounts ? 'disabled' : 'silenced'}`
      : 'No filter; everything stays on',
  );

  for (const listener of listeners) {
    try {
      listener(getActiveFocusFilter());
    } catch (err) {
      log.error('Listener error:', err);
    }
  }
}

/**
 * Subscribe to Focus Filter changes. Returns an unsubscribe function.
 */
export function onFocusFilterChanged(callback: FocusFilterChangeCallback): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Remove all listeners (mainly for test cleanup).
 */
export function clearFocusFilterListeners(): void {
  listeners.clear();
}

/**
 * Check whether an account's notifications are muted by the active Focus Filter.
 */
export function isAccountMutedByFocus(accountId: string): boolean {
  if (!currentFilter || currentFilter.activeAccountIds.length === 0) {
    return false;
  }
  return !currentFilter.activeAccountIds.includes(accountId);
}

/**
 * Whether an account falls outside the active Focus Filter.
 *
 * Excluded accounts are silenced and drop out of the glanceable surfaces (menu
 * bar, widgets, dock badge). They are still listed in the switcher and the
 * Accounts menu, de-emphasised.
 */
export function isAccountExcludedByFocus(accountId: string): boolean {
  return isAccountMutedByFocus(accountId);
}

/**
 * Whether an account is excluded *and* the filter was asked to disable rather
 * than merely de-emphasise, making it unselectable.
 */
export function isAccountDisabledByFocus(accountId: string): boolean {
  if (!currentFilter?.disableExcludedAccounts) return false;
  return isAccountExcludedByFocus(accountId);
}
