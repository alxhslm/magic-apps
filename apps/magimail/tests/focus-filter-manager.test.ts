import { describe, it, expect, beforeEach } from 'vitest';
import {
  getActiveFocusFilter,
  setFocusFilter,
  onFocusFilterChanged,
  clearFocusFilterListeners,
  isAccountMutedByFocus,
  isAccountExcludedByFocus,
  isAccountDisabledByFocus,
  type FocusFilterState,
} from '../src/focus-filter-manager.js';

describe('FocusFilterManager', () => {
  beforeEach(() => {
    clearFocusFilterListeners();
    setFocusFilter(null);
  });

  it('starts with no active focus filter', () => {
    expect(getActiveFocusFilter()).toBeNull();
    expect(isAccountMutedByFocus('account_work')).toBe(false);
    expect(isAccountDisabledByFocus('account_work')).toBe(false);
  });

  it('sets and activates a focus filter', () => {
    const filter: FocusFilterState = {
      activeAccountIds: ['account_work'],
      disableExcludedAccounts: true,
    };
    setFocusFilter(filter);

    const active = getActiveFocusFilter();
    expect(active).toEqual({
      activeAccountIds: ['account_work'],
      disableExcludedAccounts: true,
      isFilterActive: true,
    });

    expect(isAccountMutedByFocus('account_work')).toBe(false);
    expect(isAccountMutedByFocus('account_personal')).toBe(true);

    expect(isAccountDisabledByFocus('account_work')).toBe(false);
    expect(isAccountDisabledByFocus('account_personal')).toBe(true);
  });

  it('mutes and excludes, but does not disable, when disableExcludedAccounts is false', () => {
    setFocusFilter({
      activeAccountIds: ['account_work'],
      disableExcludedAccounts: false,
    });

    expect(isAccountMutedByFocus('account_work')).toBe(false);
    expect(isAccountMutedByFocus('account_personal')).toBe(true);

    // Excluded -- so silenced and dropped from the glanceable surfaces -- but
    // still fully reachable in the switcher.
    expect(isAccountExcludedByFocus('account_personal')).toBe(true);
    expect(isAccountDisabledByFocus('account_work')).toBe(false);
    expect(isAccountDisabledByFocus('account_personal')).toBe(false);
  });

  it('clears focus filter when passed null or empty accounts array', () => {
    setFocusFilter({
      activeAccountIds: ['account_work'],
      disableExcludedAccounts: true,
    });
    expect(getActiveFocusFilter()).not.toBeNull();

    setFocusFilter({
      activeAccountIds: [],
      disableExcludedAccounts: false,
    });
    expect(getActiveFocusFilter()).toBeNull();
    expect(isAccountMutedByFocus('account_personal')).toBe(false);
    expect(isAccountDisabledByFocus('account_personal')).toBe(false);
  });

  it('notifies subscribers on filter changes', () => {
    const events: (FocusFilterState | null)[] = [];
    const unsubscribe = onFocusFilterChanged((filter) => {
      events.push(filter);
    });

    setFocusFilter({ activeAccountIds: ['acc1', 'acc2'], disableExcludedAccounts: true });
    setFocusFilter(null);

    expect(events.length).toBe(2);
    expect(events[0]?.activeAccountIds).toEqual(['acc1', 'acc2']);
    expect(events[1]).toBeNull();

    unsubscribe();
    setFocusFilter({ activeAccountIds: ['acc3'], disableExcludedAccounts: false });
    expect(events.length).toBe(2);
  });
});
