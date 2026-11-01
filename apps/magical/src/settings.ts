import { app } from 'electron';
import { getAllChromiumProfiles } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';
import { sendToHelper } from './swift-helper.js';
import { loadSettings } from './settings-store.js';
import { buildSerializedCalendars } from './calendars.js';
import type { AccountsManager } from './accounts-manager.js';
import type { NormalizedCalendarEvent } from './calendar-decoder.js';

const log = createLogger('Settings');

/**
 * The settings window lives in the Swift helper, so opening it is a message
 * rather than a call. State is pushed with the request instead of the helper
 * asking for it: the helper may have been respawned and be blank, and a window
 * that opens showing stale toggles is worse than one that takes a moment.
 */
export function openSettingsWindow(
  accounts: AccountsManager,
  pane?: string,
  events?: Map<string, NormalizedCalendarEvent[]>,
  needsSignIn?: ReadonlySet<string>,
): void {
  log.info(`Opening settings window, pane=${pane ?? 'default'}`);
  const { calendars } = buildSerializedCalendars(accounts.getAccounts(), events);
  sendToHelper('settings.show', {
    pane,
    settings: loadSettings(),
    accounts: accountPayload(accounts, needsSignIn),
    browserProfiles: getAllChromiumProfiles(),
    calendars,
    appVersion: app.getVersion(),
  });
}

/** Pushes the account list and their calendars to an already-open settings window. */
export function pushAccountsToSettings(
  accounts: AccountsManager,
  events?: Map<string, NormalizedCalendarEvent[]>,
  needsSignIn?: ReadonlySet<string>,
): void {
  log.info(`Pushing ${accounts.getAccounts().length} account(s) to settings`);
  const { calendars } = buildSerializedCalendars(accounts.getAccounts(), events);
  sendToHelper('accounts.update', {
    accounts: accountPayload(accounts, needsSignIn),
    browserProfiles: getAllChromiumProfiles(),
    calendars,
  });
}

/** Pushes updated calendar metadata to an already-open settings window. */
export function pushCalendarsToSettings(
  accounts: AccountsManager,
  events?: Map<string, NormalizedCalendarEvent[]>,
): void {
  const { calendars } = buildSerializedCalendars(accounts.getAccounts(), events);
  sendToHelper('calendars.update', { calendars });
}

/** Pushes settings to an already-open window, after a change made elsewhere —
 *  the View menu's Appearance items write the same value the General tab does. */
export function pushSettingsToHelper(): void {
  log.info('Pushing settings updates to helper');
  sendToHelper('settings.update', { settings: loadSettings() });
}

/**
 * `needsAuth` is what puts a Sign In button on the row.
 *
 * Settings is where an account is added, so it is where the user looks when one has
 * stopped working; a row that says nothing leaves them editing the colour of an account
 * that cannot read anything.
 */
function accountPayload(accounts: AccountsManager, needsSignIn?: ReadonlySet<string>) {
  return accounts.getAccounts().map((a) => ({
    id: a.id,
    name: a.name,
    color: a.color,
    needsAuth: needsSignIn?.has(a.id) ?? false,
  }));
}
