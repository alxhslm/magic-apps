import { createLogger } from '@magimail/core/logger';
import type { CalendarAccount } from './accounts.js';
import { resolveCanonicalCalendarId, resolvePrimaryEmail } from './calendars.js';

const log = createLogger('FocusFilter');

/**
 * focus-filter-manager.ts
 *
 * Electron's copy of the macOS Focus filter Magical is under.
 *
 * The filter is written by `MagicalAppIntents.appex` and read by `MagicalHelper`, which
 * forwards it here; see `docs/magical/focus-filters.md`. The helper silences the banner and
 * filters the popover because both are drawn there. This copy exists for the Dock badge,
 * which counts invitations across every account and belongs to the main process.
 *
 * An allow-list: a filter names the calendars that stay active, and silences everything it
 * could have named and did not. Naming nothing is no filter at all.
 */
export interface FocusFilterState {
  /**
   * Accounts the filter keeps on. An account left off silences every calendar it has,
   * whatever `activeCalendars` says.
   */
  activeAccounts: string[];
  /**
   * Calendars the filter keeps on, each keyed `accountId|calendarId`.
   *
   * Both halves, because a Google calendar id does not identify a calendar on its own:
   * Birthdays, Tasks and each locale's holidays carry the same id in every account.
   */
  activeCalendars: string[];
  /**
   * Whether an account with nothing left on is greyed out and unselectable, rather than
   * merely quiet. The account stays listed either way.
   */
  preventAccess: boolean;
  isFilterActive?: boolean;
}

export type FocusFilterChangeCallback = (filter: FocusFilterState | null) => void;

let currentFilter: FocusFilterState | null = null;
const listeners = new Set<FocusFilterChangeCallback>();

/** The active filter, or null when no Focus is filtering Magical. */
export function getActiveFocusFilter(): FocusFilterState | null {
  return currentFilter
    ? {
        ...currentFilter,
        activeAccounts: [...currentFilter.activeAccounts],
        activeCalendars: [...currentFilter.activeCalendars],
      }
    : null;
}

/**
 * Replaces the active filter.
 *
 * Both lists empty is no filter rather than silence everywhere. The picker starts with
 * everything on, so the only way to reach it is a filter written before the app knew of
 * any account.
 */
export function setFocusFilter(filter: FocusFilterState | null): void {
  const names = filter ? filter.activeAccounts.length + filter.activeCalendars.length : 0;

  currentFilter =
    filter && names > 0
      ? {
          activeAccounts: [...filter.activeAccounts],
          activeCalendars: [...filter.activeCalendars],
          preventAccess: Boolean(filter.preventAccess),
          isFilterActive: true,
        }
      : null;

  log.info(
    currentFilter
      ? `Filter active; ${currentFilter.activeAccounts.length} account(s) and ${currentFilter.activeCalendars.length} calendar(s) stay on`
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

/** Subscribe to filter changes. Returns an unsubscribe function. */
export function onFocusFilterChanged(callback: FocusFilterChangeCallback): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** Drops every listener. For test cleanup. */
export function clearFocusFilterListeners(): void {
  listeners.clear();
}

/**
 * Whether the active filter silences this calendar.
 *
 * A Focus can only silence. It never un-mutes a calendar the user turned off in Settings,
 * which is why that set is not consulted here: the caller combines the two, and each can
 * only take a calendar away.
 *
 * The account is optional, and does two things when given. It decides whether the account
 * is wholly on, and it reconciles the primary calendar's several names — Google reports it
 * as `primary`, as the account id, or as the account's own email address depending on
 * which endpoint returned the event.
 */
export function isCalendarSilencedByFocus(
  calendarId: string,
  accountId: string,
  account?: CalendarAccount,
): boolean {
  if (!currentFilter) return false;
  if (!currentFilter.activeAccounts.includes(accountId)) return true;

  const active = new Set(currentFilter.activeCalendars);
  const isOn = (id: string): boolean => active.has(`${accountId}|${id}`);

  if (account && isWhollyActive(account, active)) return false;
  if (isOn(calendarId)) return false;
  if (!account) return true;

  if (isOn(resolveCanonicalCalendarId(calendarId, account))) return false;

  // The primary calendar only. A secondary calendar's id is already unique within its
  // account.
  const primaryEmail = resolvePrimaryEmail(account);
  const isPrimary =
    calendarId === 'primary' || calendarId === account.id || calendarId === primaryEmail;
  if (!isPrimary) return true;

  return !['primary', account.id, primaryEmail].some(isOn);
}

/**
 * Resolves which of the given calendars are silenced by the active Focus filter.
 *
 * Empty when no filter is active, so the caller can treat that as nothing silenced.
 */
export function getSilencedCalendars(
  calendars: { id: string; accountId: string }[],
  accounts?: CalendarAccount[],
): { accountId: string; calendarId: string }[] {
  if (!currentFilter) return [];
  const accountMap = new Map((accounts ?? []).map((a) => [a.id, a]));
  const silenced: { accountId: string; calendarId: string }[] = [];
  for (const cal of calendars) {
    if (isCalendarSilencedByFocus(cal.id, cal.accountId, accountMap.get(cal.accountId))) {
      silenced.push({ accountId: cal.accountId, calendarId: cal.id });
    }
  }
  return silenced;
}

/**
 * Whether every calendar this account has is on.
 *
 * Such an account is treated as wholly on, so a calendar added to it later is audible
 * rather than silenced: the filter is a list fixed when it was configured and a new
 * calendar cannot be in it, and this is the case where the user plainly did not mean to
 * hold anything back. An account they have partly filtered is one they are curating, so a
 * new calendar there stays quiet until they say otherwise.
 *
 * An account whose calendars have not been discovered counts as wholly on. There was
 * nothing to tick, so silence would be the app's decision rather than the user's.
 */
function isWhollyActive(account: CalendarAccount, active: ReadonlySet<string>): boolean {
  const owned = account.calendars ?? [];
  if (owned.length === 0) return true;
  return owned.every((calendar) => active.has(`${account.id}|${calendar.id}`));
}

/** Whether a Focus filter is holding anything back at all. */
export function isFocusFilterActive(): boolean {
  return currentFilter !== null;
}

/**
 * Whether the filter has silenced everything this account has.
 *
 * The only account-level state there is, because a switcher segment is one account: an
 * account with even one calendar left on stays fully available. Such an account shows a
 * dimmed dot, and is greyed out and unselectable when the filter asks for that.
 */
export function isAccountSilencedByFocus(account: CalendarAccount): boolean {
  if (!currentFilter) return false;
  if (!currentFilter.activeAccounts.includes(account.id)) return true;

  const owned = account.calendars ?? [];
  if (owned.length === 0) return false;
  return owned.every((calendar) => isCalendarSilencedByFocus(calendar.id, account.id, account));
}

/**
 * Whether this account is not merely quiet but out of reach.
 *
 * Never the account you are looking at. A filter that silenced every account would
 * otherwise grey out all of them at once and leave the window with nowhere to go, and the
 * way back is System Settings, which is a poor place to discover you need to be.
 */
export function isAccountDisabledByFocus(
  account: CalendarAccount,
  activeAccountId?: string,
): boolean {
  if (!currentFilter?.preventAccess) return false;
  if (account.id === activeAccountId) return false;
  return isAccountSilencedByFocus(account);
}

/**
 * Reads a `focusFilter.changed` event from the helper.
 *
 * Returns whether the event was ours, so the caller can go on trying other handlers.
 */
export function handleFocusFilterEvent(method: string, params: Record<string, unknown>): boolean {
  if (method !== 'focusFilter.changed') return false;

  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

  setFocusFilter({
    activeAccounts: strings(params.activeAccounts),
    activeCalendars: strings(params.activeCalendars),
    preventAccess: params.preventAccess === true,
  });
  return true;
}
