import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearFocusFilterListeners,
  getActiveFocusFilter,
  getSilencedCalendars,
  handleFocusFilterEvent,
  isAccountDisabledByFocus,
  isAccountSilencedByFocus,
  isCalendarSilencedByFocus,
  isFocusFilterActive,
  onFocusFilterChanged,
  setFocusFilter,
} from '../src/focus-filter-manager';
import type { CalendarAccount } from '../src/accounts';

const work: CalendarAccount = {
  id: 'account_work',
  name: 'Work',
  partition: 'persist:magical_work',
  color: '#3b82f6',
  email: 'me@work.com',
  calendars: [
    { id: 'me@work.com', name: 'Work', color: '#3b82f6' },
    { id: 'team@group.calendar.google.com', name: 'Team', color: '#0b8043' },
    { id: 'birthdays@birthdays.google.com', name: 'Birthdays', color: '#33b679' },
  ],
};

const personal: CalendarAccount = {
  id: 'account_personal',
  name: 'Personal',
  partition: 'persist:magical_personal',
  color: '#a855f7',
  email: 'me@example.com',
  calendars: [
    { id: 'me@example.com', name: 'Personal', color: '#a855f7' },
    // The same id Work carries. Google gives it to every account.
    { id: 'birthdays@birthdays.google.com', name: 'Birthdays', color: '#7986cb' },
  ],
};

/** Everything on for one account, which is how the picker starts. */
const allOf = (account: CalendarAccount): string[] =>
  (account.calendars ?? []).map((calendar) => `${account.id}|${calendar.id}`);

/** Every account on, and every calendar of the accounts given on. */
const everythingOn = (...accounts: CalendarAccount[]) => ({
  activeAccounts: accounts.map((a) => a.id),
  activeCalendars: accounts.flatMap(allOf),
  preventAccess: false,
});

beforeEach(() => {
  clearFocusFilterListeners();
  setFocusFilter(null);
});

describe('an allow-list', () => {
  it('silences what a filter does not name', () => {
    setFocusFilter(everythingOn(work));

    expect(isCalendarSilencedByFocus('me@work.com', 'account_work', work)).toBe(false);
    expect(isCalendarSilencedByFocus('me@example.com', 'account_personal', personal)).toBe(true);
  });

  it('treats naming nothing as no filter rather than as silencing everything', () => {
    setFocusFilter({ activeAccounts: [], activeCalendars: [], preventAccess: false });

    expect(isFocusFilterActive()).toBe(false);
    expect(getActiveFocusFilter()).toBeNull();
    expect(isCalendarSilencedByFocus('me@example.com', 'account_personal', personal)).toBe(false);
  });

  it('tells two accounts apart when Google gives their calendars the same id', () => {
    // Personal keeps everything; Work keeps nothing. Both own a Birthdays with one id, so
    // a filter keyed on the calendar id alone would answer the same for both.
    setFocusFilter(everythingOn(personal));

    expect(
      isCalendarSilencedByFocus('birthdays@birthdays.google.com', 'account_personal', personal),
    ).toBe(false);
    expect(isCalendarSilencedByFocus('birthdays@birthdays.google.com', 'account_work', work)).toBe(
      true,
    );
  });

  it('keeps a calendar added to a wholly active account audible', () => {
    setFocusFilter(everythingOn(work));

    // Not in `work.calendars`, so it cannot be in a filter configured before it existed.
    expect(isCalendarSilencedByFocus('new@group.calendar.google.com', 'account_work', work)).toBe(
      false,
    );
  });

  it('silences a calendar added to an account the user has partly filtered', () => {
    setFocusFilter({
      activeAccounts: [work.id, personal.id],
      activeCalendars: ['account_work|me@work.com', ...allOf(personal)],
      preventAccess: false,
    });

    expect(isCalendarSilencedByFocus('new@group.calendar.google.com', 'account_work', work)).toBe(
      true,
    );
    expect(isCalendarSilencedByFocus('me@work.com', 'account_work', work)).toBe(false);
  });

  it('leaves an account whose calendars were never discovered alone', () => {
    const undiscovered: CalendarAccount = {
      id: 'account_new',
      name: 'New',
      partition: 'persist:magical_new',
      color: '#22c55e',
    };
    setFocusFilter({
      activeAccounts: [work.id, undiscovered.id],
      activeCalendars: allOf(work),
      preventAccess: false,
    });

    expect(isCalendarSilencedByFocus('anything@example.com', 'account_new', undiscovered)).toBe(
      false,
    );
  });

  it('reconciles the primary calendar with the names Google reports it under', () => {
    setFocusFilter({
      activeAccounts: [work.id],
      activeCalendars: ['account_work|me@work.com'],
      preventAccess: false,
    });

    for (const id of ['primary', 'account_work', 'me@work.com']) {
      expect(isCalendarSilencedByFocus(id, 'account_work', work)).toBe(false);
    }
    // A secondary calendar's id is unique within its account and never expands.
    expect(isCalendarSilencedByFocus('team@group.calendar.google.com', 'account_work', work)).toBe(
      true,
    );
  });

  it('silences an account it knows nothing about', () => {
    setFocusFilter(everythingOn(work));

    expect(isCalendarSilencedByFocus('someone@work.com', 'account_other')).toBe(true);
  });
});

describe('the helper event', () => {
  it('leaves other methods alone', () => {
    expect(handleFocusFilterEvent('tray.openApp', {})).toBe(false);
  });

  it('applies what the helper forwards, and ignores anything that is not a string key', () => {
    const handled = handleFocusFilterEvent('focusFilter.changed', {
      activeAccounts: ['account_work'],
      activeCalendars: ['account_work|me@work.com', 42],
      preventAccess: true,
    });

    expect(handled).toBe(true);
    expect(getActiveFocusFilter()).toEqual({
      activeAccounts: ['account_work'],
      activeCalendars: ['account_work|me@work.com'],
      preventAccess: true,
      isFilterActive: true,
    });
  });

  it('tells listeners, so the Dock badge is redrawn without waiting for a poll', () => {
    const seen: (string[] | null)[] = [];
    onFocusFilterChanged((filter) => seen.push(filter?.activeCalendars ?? null));

    handleFocusFilterEvent('focusFilter.changed', {
      activeAccounts: ['account_work'],
      activeCalendars: ['account_work|me@work.com'],
      preventAccess: false,
    });
    handleFocusFilterEvent('focusFilter.changed', {
      activeAccounts: [],
      activeCalendars: [],
      preventAccess: false,
    });

    expect(seen).toEqual([['account_work|me@work.com'], null]);
  });
});

describe('what the switcher and the Accounts menu ask', () => {
  it('silences a whole account when the filter turns the account off', () => {
    setFocusFilter({
      activeAccounts: [personal.id],
      activeCalendars: [...allOf(personal), ...allOf(work)],
      preventAccess: false,
    });

    // Every Work calendar is still in the calendar list; the account being off wins.
    expect(isAccountSilencedByFocus(work)).toBe(true);
    expect(isCalendarSilencedByFocus('me@work.com', work.id, work)).toBe(true);
    expect(isAccountSilencedByFocus(personal)).toBe(false);
  });

  it('leaves an account alone while it has one calendar left on', () => {
    setFocusFilter({
      activeAccounts: [work.id, personal.id],
      activeCalendars: [`${work.id}|me@work.com`, ...allOf(personal)],
      preventAccess: false,
    });

    expect(isAccountSilencedByFocus(work)).toBe(false);
  });

  it('silences an account whose every calendar was turned off one by one', () => {
    setFocusFilter({
      activeAccounts: [work.id, personal.id],
      activeCalendars: allOf(personal),
      preventAccess: false,
    });

    expect(isAccountSilencedByFocus(work)).toBe(true);
  });

  it('blocks a silenced account only when the filter asks, and never the open one', () => {
    setFocusFilter({
      activeAccounts: [personal.id],
      activeCalendars: allOf(personal),
      preventAccess: false,
    });
    expect(isAccountDisabledByFocus(work, personal.id)).toBe(false);

    setFocusFilter({
      activeAccounts: [personal.id],
      activeCalendars: allOf(personal),
      preventAccess: true,
    });
    expect(isAccountDisabledByFocus(work, personal.id)).toBe(true);
    // Looking at the silenced account is how you got locked out; it stays reachable.
    expect(isAccountDisabledByFocus(work, work.id)).toBe(false);
  });
});

describe('getSilencedCalendars', () => {
  const workCalendars = [
    { id: 'me@work.com', accountId: 'account_work' },
    { id: 'team@group.calendar.google.com', accountId: 'account_work' },
  ];
  const personalCalendars = [{ id: 'me@example.com', accountId: 'account_personal' }];
  const allCalendars = [...workCalendars, ...personalCalendars];

  it('returns nothing when no filter is active', () => {
    expect(getSilencedCalendars(allCalendars, [work, personal])).toEqual([]);
  });

  it('returns nothing when the filter is empty (treated as inactive)', () => {
    setFocusFilter({ activeAccounts: [], activeCalendars: [], preventAccess: false });
    expect(getSilencedCalendars(allCalendars, [work, personal])).toEqual([]);
  });

  it('returns the refs of calendars the active filter silences', () => {
    setFocusFilter(everythingOn(work));

    const silenced = getSilencedCalendars(allCalendars, [work, personal]);
    expect(silenced).toEqual([{ accountId: 'account_personal', calendarId: 'me@example.com' }]);
  });

  it('resolves the primary calendar alias when checking for silencing', () => {
    setFocusFilter({
      activeAccounts: [work.id],
      activeCalendars: ['account_work|me@work.com'],
      preventAccess: false,
    });

    // 'primary' is an alias for 'me@work.com' on account_work; it must not be silenced.
    const silenced = getSilencedCalendars(
      [{ id: 'primary', accountId: 'account_work' }, ...workCalendars.slice(1)],
      [work],
    );
    // Only the secondary calendar is silenced; primary (= me@work.com) is not.
    expect(silenced).toEqual([
      { accountId: 'account_work', calendarId: 'team@group.calendar.google.com' },
    ]);
  });
});
