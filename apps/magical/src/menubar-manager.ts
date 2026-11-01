import { app, type BaseWindow } from 'electron';
import { isDemoMode, RetryScheduler } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';
import type { CalendarAccount } from './accounts.js';
import type { AccountsManager } from './accounts-manager.js';
import type { SourceHealth } from './calendar-poller.js';
import { uiString } from './strings.js';
import type { CalendarService, NormalizedCalendarEvent } from './calendar-service.js';
import { buildEventLink } from './event-links.js';
import type { RsvpResponse } from './invite-watcher.js';
import { loadSettings, saveSetting, type CalendarRef } from './settings-store.js';
import { isHelperAvailable, sendToHelper } from './swift-helper.js';
import { appGroupContainerPath, reloadNativeWidgets } from './native-widgets.js';
import { buildWidgetCache, writeWidgetCache, type WidgetCacheInput } from './widget-cache.js';
import { getSilencedCalendars, isFocusFilterActive } from './focus-filter-manager.js';

const log = createLogger('MenuBar');

import {
  type SerializedTrayCalendar,
  GOOGLE_CALENDAR_DEFAULT_SWATCHES,
  friendlyCalendarName,
  buildSerializedCalendars,
} from './calendars.js';

export {
  type SerializedTrayCalendar,
  GOOGLE_CALENDAR_DEFAULT_SWATCHES,
  friendlyCalendarName,
  buildSerializedCalendars,
};

export interface SerializedTrayEvent {
  id: string;
  accountId: string;
  /**
   * Every calendar of the account's that holds this event, canonicalised.
   *
   * The popover filters on all of them, because it keeps its own live set of hidden
   * calendars and the user's last toggle has not reached this process yet. It hides the
   * event only when every one of these is hidden.
   */
  calendarIds: string[];
  /** The calendar the event is drawn as: the first of `calendarIds` still on screen. */
  calendarName?: string;
  summary: string;
  startTime: number;
  endTime: number;
  isAllDay: boolean;
  /** What kind of entry this is, so a surface can draw a birthday or a task as one. */
  eventType: number;
  isCompleted?: boolean;
  colorHex: string;
  conferenceUrl?: string;
  location?: string;
  myResponseStatus: number;
  organizerEmail?: string;
  webUrl?: string;
  /** `magical://` link to the event, or to its day when it carries no `eid`. */
  deepLink?: string;
}

export interface SerializedTrayAccount {
  id: string;
  name: string;
  color: string;
  email: string;
  unreadCount: number;
  needsAuth: boolean;
}

/**
 * How one hidden calendar is keyed: both halves.
 *
 * A calendar id does not identify a calendar on its own. Google gives Birthdays, Tasks and
 * each locale's holidays the same id in every account, so keying on the id alone hides one
 * account's Birthdays by hiding another's.
 */
function hiddenKey(accountId: string, calendarId: string): string {
  return `${accountId}\u0000${calendarId}`;
}

/**
 * How far past and ahead to include in the menu bar tray popover by default.
 *
 * Keeps the popover payload lean (~200 events instead of ~2,400) while covering the
 * visible month grid and immediate agenda. Paging or scrolling near the end widens
 * the window via `tray.ensureRange`.
 */
const TRAY_WINDOW_DAYS_PAST = 30;
const TRAY_WINDOW_DAYS_AHEAD = 60;

export class MenuBarManager {
  private trayCreated = false;
  private cachedAccounts: CalendarAccount[] = [];
  private cachedEvents = new Map<string, NormalizedCalendarEvent[]>();
  private health = new Map<string, SourceHealth>();
  /** When each source last read successfully, for the popover's "last synced" line. */
  private lastSyncedAt = new Map<string, number>();
  private visibleRangeStartMs: number | null = null;
  private visibleRangeEndMs: number | null = null;
  private lastPayloadJson: string | null = null;
  private retryScheduler = new RetryScheduler({ maxRetries: 1, delayMs: 1000 });

  constructor(
    private getMainWindow: () => BaseWindow | null,
    private getAccountsManager: () => AccountsManager | null,
    private getCalendarService: () => CalendarService | null,
    private onNewEvent: (accountId?: string) => void,
    private onOpenSettings: () => void,
    private onOpenApp?: (accountId?: string) => void,
    private onSearch?: (query: string, accountId?: string) => void,
  ) {}

  public createTray(): void {
    if (this.trayCreated) return;
    this.trayCreated = true;
    this.lastPayloadJson = null;
    this.retryScheduler.reset();

    if (isHelperAvailable()) {
      log.info('Adding the status item');
      void sendToHelper('tray.create');
      this.pushUpdate();
    } else {
      // Every later `pushUpdate` returns early too, so the status item stays absent
      // rather than empty; without this the only symptom is nothing in the menu bar.
      log.warn('The helper is not running; the status item cannot be shown');
    }
  }

  public destroyTray(): void {
    if (!this.trayCreated) return;
    this.trayCreated = false;
    this.lastPayloadJson = null;
    this.retryScheduler.reset();

    if (isHelperAvailable()) {
      log.info('Removing the status item');
      void sendToHelper('tray.destroy');
    }
  }

  public restoreTray(): void {
    if (!this.trayCreated || !isHelperAvailable()) return;
    this.lastPayloadJson = null;
    this.retryScheduler.reset();
    void sendToHelper('tray.create');
    this.pushUpdate();
  }

  public updateAccounts(accounts: CalendarAccount[]): void {
    this.cachedAccounts = accounts;
    // A removed account's last reading would otherwise sit in the map forever, and one
    // signed-out account that is no longer there is enough to hold the popover offline.
    const present = new Set(accounts.map((a) => a.id));
    for (const id of this.health.keys()) {
      if (!present.has(id)) this.health.delete(id);
    }
    for (const id of this.lastSyncedAt.keys()) {
      if (!present.has(id)) this.lastSyncedAt.delete(id);
    }
    this.pushUpdate();
  }

  public updateEvents(eventsByAccount: Map<string, NormalizedCalendarEvent[]>): void {
    this.cachedEvents = eventsByAccount;
    this.pushUpdate();
  }

  /**
   * Records how an account's last read went, which is what both popover banners draw from.
   *
   * `CalendarService` reports per account and the popover's offline banner is one flag for
   * the app, so the two have to be reconciled. Offline means every account is failing to
   * read: while one account still reads, its agenda is live, and a band across the whole
   * popover saying the network is gone would be false for the half the user is looking at.
   * A signed-out account is not offline either; that is the sign-in banner's job, and it
   * names the account, which the offline banner cannot.
   *
   * Pushes only on a change. Every account reports `ok` on every successful poll, and the
   * poll already ends in a `tray.update` of its own.
   */
  public setAccountHealth(
    accountId: string,
    health: SourceHealth,
    lastSuccessfulReadAt?: Date | null,
  ): void {
    const at = lastSuccessfulReadAt?.getTime();
    // Recorded even when the health is unchanged, so a run of successful polls keeps the
    // timestamp current without pushing an update nothing would redraw.
    if (at !== undefined) this.lastSyncedAt.set(accountId, at);

    if (this.health.get(accountId) === health) return;
    this.health.set(accountId, health);
    this.pushUpdate();
  }

  public pushUpdate(isRetry = false): void {
    if (!this.trayCreated || !isHelperAvailable()) return;

    if (!isRetry) {
      this.retryScheduler.resetAttempts();
    }
    this.retryScheduler.cancel();

    const settings = loadSettings();
    const hiddenCalendars = settings.hiddenCalendars ?? [];
    const hidden = new Set(hiddenCalendars.map((c) => hiddenKey(c.accountId, c.calendarId)));
    const accountColorMap = new Map(this.cachedAccounts.map((a) => [a.id, a.color]));

    // ── 1. Build calendar list ──────────────────────────────────────────────
    // Must happen before events so we can resolve per-event calendar colours.
    const {
      calendars: serializedCalendars,
      calendarColorMap,
      calendarNameMap,
    } = buildSerializedCalendars(this.cachedAccounts, this.cachedEvents);

    // ── 2. Build event list ─────────────────────────────────────────────────
    const serializedEvents: SerializedTrayEvent[] = [];
    const now = Date.now();
    const defaultPastMs = TRAY_WINDOW_DAYS_PAST * 24 * 60 * 60 * 1000;
    const defaultAheadMs = TRAY_WINDOW_DAYS_AHEAD * 24 * 60 * 60 * 1000;
    const windowStart =
      this.visibleRangeStartMs !== null
        ? Math.min(this.visibleRangeStartMs, now - defaultPastMs)
        : now - defaultPastMs;
    const windowEnd =
      this.visibleRangeEndMs !== null
        ? Math.max(this.visibleRangeEndMs, now + defaultAheadMs)
        : now + defaultAheadMs;

    // One pile, one counter. `CalendarService` owns what is outstanding, so the popover,
    // the Dock badge, the toolbar dropdown and the switcher's dots cannot drift apart.
    const pendingByAccount = this.getCalendarService()?.pendingByAccount() ?? new Map();

    for (const [accountId, events] of this.cachedEvents.entries()) {
      const account = this.cachedAccounts.find((a) => a.id === accountId);
      // No account, no calendar row. Every surface here decides what to show from the
      // calendar list, and an event whose account is gone has no row there to hide it by:
      // it would be drawn in the fallback colour and be impossible to filter out.
      // `CalendarService.syncPollers` drops the account's events; this is the guard for
      // the window between the account going and that prune running.
      if (!account) continue;
      const accountFallbackColor = accountColorMap.get(accountId) || '#039be5';
      const primaryEmail =
        account?.email ||
        (account?.calendarIds || []).find(
          (id) => id.includes('@') && !id.includes('@group.') && !id.includes('@import.'),
        ) ||
        accountId;

      // Google reports the account's own calendar as `primary`, as the account id or as
      // its address depending on which endpoint answered, and the filter is stored under
      // one of them.
      const canonicalise = (id: string): string =>
        id === primaryEmail || id === 'primary' || id === accountId ? primaryEmail : id;

      for (const event of events) {
        const calendarIds = [...new Set(event.calendarIds.map(canonicalise))];

        // The calendar an event is drawn as: the first it is on that the user has not
        // hidden. An event on a hidden calendar and a visible one is still on screen, and
        // painting it in the hidden calendar's colour names a calendar the user has just
        // taken out of their day.
        const shownOn =
          calendarIds.find((id) => !hidden.has(hiddenKey(accountId, id))) ??
          calendarIds[0] ??
          primaryEmail;

        // An event's colour is its calendar's colour, from the metadata extracted out of
        // the account's own view. That is what Google itself paints: every event chip
        // sampled from a live view carried the exact hex the sidebar shows for its
        // calendar, including events whose wire tuple held a non-zero `[81]` or `[82]`.
        // Neither index predicts the painted colour, so neither is read.
        // The event's own colour first, where it has overridden its calendar's. That is
        // the only colour the wire states outright; everything below it is the colour of
        // the calendar the event is drawn as.
        // Scoped to the account: the same calendar id is Birthdays in every account, so a
        // flat lookup would paint this account's events in another account's colour.
        const colors = calendarColorMap.get(accountId);
        const names = calendarNameMap.get(accountId);
        const colorHex =
          event.colorHex ||
          colors?.get(shownOn) ||
          (shownOn === primaryEmail ? colors?.get('primary') : undefined) ||
          accountFallbackColor;

        const calendarName =
          names?.get(shownOn) || event.calendarName || friendlyCalendarName(shownOn);

        const myResponseStatus =
          event.myResponseStatus === 'notInvited' ? -1 : Number(event.myResponseStatus);

        const startTime = event.startTime.getTime();
        const endTime = event.endTime.getTime();
        // Discard NaN or corrupt epoch timestamps outside the 1900–2100 century span
        if (
          Number.isNaN(startTime) ||
          Number.isNaN(endTime) ||
          startTime < -2208988800000 ||
          endTime > 4102444800000
        ) {
          continue;
        }

        // Bounded to the tray's visible date window, avoiding serializing thousands of events
        // across the whole baseline poll window when only a few months are visible.
        if (endTime < windowStart || startTime > windowEnd) {
          continue;
        }

        serializedEvents.push({
          id: event.id,
          accountId,
          calendarIds: calendarIds.length > 0 ? calendarIds : [shownOn],
          calendarName,
          summary: event.summary || uiString('notification.noTitle'),
          startTime,
          endTime,
          isAllDay: event.isAllDay,
          eventType: event.eventType,
          isCompleted: event.isCompleted,
          colorHex,
          conferenceUrl: event.conferenceUrl,
          location: event.location,
          myResponseStatus,
          organizerEmail: event.organizerEmail,
          webUrl: event.webUrl,
          deepLink: buildEventLink(event, accountId),
        });
      }
    }

    serializedEvents.sort((a, b) => a.startTime - b.startTime);

    // ── 3. Build account list ───────────────────────────────────────────────
    const serializedAccounts: SerializedTrayAccount[] = this.cachedAccounts.map((a) => ({
      id: a.id,
      name: a.name,
      color: a.color,
      email: a.email || '',
      unreadCount: pendingByAccount.get(a.id) ?? 0,
      needsAuth: this.health.get(a.id) === 'signed-out',
    }));

    // No account at all is not offline; it is an app nobody has signed into yet, and the
    // popover says so already.
    //
    // Every account, not any: while one account still reads, its agenda is live, and a
    // band across the whole popover saying the network is gone would be false for the
    // half the user is looking at.
    const isOffline =
      this.cachedAccounts.length > 0 &&
      this.cachedAccounts.every((a) => this.health.get(a.id) === 'offline');

    // The oldest successful read among accounts that have stopped reading, so the banner
    // names the worst case rather than an average nothing experienced. An account that is
    // reading normally is left out; one that has never read contributes nothing, because
    // there is no age to state and the sign-in or offline banner already covers it.
    const stalled = this.cachedAccounts.filter((a) => {
      const health = this.health.get(a.id);
      return health !== undefined && health !== 'ok';
    });
    const syncedAt = stalled
      .map((a) => this.lastSyncedAt.get(a.id))
      .filter((at): at is number => at !== undefined);
    const lastSyncedAt = syncedAt.length > 0 ? Math.min(...syncedAt) : undefined;

    const activeAccountId = this.getAccountsManager()?.getActiveAccountId?.();

    const payload = {
      accounts: serializedAccounts,
      calendars: serializedCalendars,
      events: serializedEvents,
      activeAccountId,
      isCalendarCollapsed: Boolean(settings.isCalendarCollapsed),
      isOffline,
      // A tenant policy refusal is not the network and not a sign-in the user can
      // perform, so the popover draws it as its own band. Carried app-wide rather than
      // per account because the copy can say what happened without naming a tenant.
      isRestricted: this.cachedAccounts.some((a) => this.health.get(a.id) === 'restricted'),
      ...(lastSyncedAt !== undefined ? { lastSyncedAt } : {}),
      menuBarDisplayMode: settings.menuBarDisplayMode,
      showMenuBarAccountColor: Boolean(settings.showMenuBarAccountColor),
      hiddenCalendars,
      showCompletedTasks: Boolean(settings.showCompletedTasks),
    };

    const payloadJson = JSON.stringify(payload);
    if (payloadJson !== this.lastPayloadJson) {
      this.lastPayloadJson = payloadJson;
      void Promise.resolve(sendToHelper('tray.update', payload)).then((result) => {
        if (result === null) {
          if (this.lastPayloadJson === payloadJson) {
            this.lastPayloadJson = null;
          }
          this.retryScheduler.schedule(() => {
            this.pushUpdate(true);
          });
        } else {
          this.retryScheduler.resetAttempts();
        }
      });
    }

    const isFocusActive = isFocusFilterActive();
    const silencedCalendars = isFocusActive
      ? getSilencedCalendars(serializedCalendars, this.cachedAccounts)
      : [];

    this.refreshWidgets({
      events: serializedEvents,
      calendars: serializedCalendars,
      accounts: serializedAccounts,
      hiddenCalendars,
      activeAccountId,
      isFocusActive,
      silencedCalendars,
    });
  }

  /**
   * Re-evaluates the widget cache against the active Focus filter and pushes an update.
   */
  public applyFocusFilter(): void {
    this.pushUpdate();
  }

  /**
   * Hand the same events to the widget extension, which cannot be sent to.
   *
   * Unfiltered by calendar, unlike the popover's copy. Each widget holds its own choice
   * of calendars in its configuration, which only the extension can read, so the snapshot
   * carries every event, the calendars to choose from and the popover's filter for a
   * widget that has never been configured. Finished tasks are dropped when the global
   * toggle is off.
   *
   * Timelines reload only when the snapshot actually changed. The poller runs
   * every five minutes on mains whether or not the diary moved, and WidgetKit
   * throttles an extension that asks for reloads it did not need.
   */
  private refreshWidgets(input: Omit<WidgetCacheInput, 'now'>): void {
    // A demo must not overwrite the cache the real install's widgets read. The App Group is
    // shared whatever profile is in use, and this snapshot is an invented diary.
    if (isDemoMode()) return;

    const settings = loadSettings();
    const events = settings.showCompletedTasks
      ? input.events
      : input.events.filter((event) => !event.isCompleted);
    const cache = buildWidgetCache({ ...input, events, now: Date.now() });

    if (writeWidgetCache(cache, appGroupContainerPath)) {
      reloadNativeWidgets();
    }
  }

  public handleEvent(method: string, params: Record<string, unknown>): boolean {
    switch (method) {
      case 'tray.openApp': {
        const win = this.getMainWindow();
        if (win) {
          win.show();
          win.focus();
        } else {
          this.onOpenApp?.();
        }
        return true;
      }

      case 'tray.openQuickAdd': {
        const accountId = typeof params.accountId === 'string' ? params.accountId : undefined;
        this.onNewEvent(accountId);
        return true;
      }

      case 'tray.openSettings': {
        this.onOpenSettings();
        return true;
      }

      case 'tray.quit': {
        app.quit();
        return true;
      }

      // Opened through `CalendarService.joinCall`, not by rewriting the URL here. That is
      // where `alwaysJoinInBrowser` is read, and every surface has to go through it or the
      // preference works on a banner and nowhere else.
      case 'tray.joinCall': {
        const url = typeof params.url === 'string' ? params.url : '';
        const accountId = typeof params.accountId === 'string' ? params.accountId : undefined;
        const service = this.getCalendarService();
        if (url && service) {
          // The scheme alone, never the URL: a meeting link is a credential to anyone
          // holding it, and this file is written to disk.
          log.info(`Joining a call via ${url.split(':')[0]}`);
          if (accountId) {
            void service.joinCall(url, accountId);
          } else {
            void service.joinCall(url);
          }
        }
        return true;
      }

      // Handed to the same `openDeepLink` a meeting banner goes through, so both surfaces
      // share one set of measured fallbacks: route the document rather than load it, keep
      // the user's view mode, refuse to move out from under an open editor, and open the
      // event's own panel. `openDeepLink` also picks the link form, so an event with no
      // resolvable `eid` still opens the right day.
      case 'tray.focusEvent': {
        const accountId = typeof params.accountId === 'string' ? params.accountId : '';
        const eventId = typeof params.eventId === 'string' ? params.eventId : '';
        const service = this.getCalendarService();
        const event = (this.cachedEvents.get(accountId) ?? []).find((e) => e.id === eventId);

        if (service && event) {
          log.info(`Revealing ${eventId} in ${accountId}`);
          service.openDeepLink(buildEventLink(event, accountId));
        } else if (accountId) {
          // Nothing cached to name, so there is no event to reveal. Showing the account is
          // still closer to the ask than doing nothing.
          log.warn(`No cached event ${eventId} on ${accountId}; showing the account instead`);
          this.getAccountsManager()?.switchAccount(accountId);
        }

        // `show()` and `focus()` raise the window within Magical; they do not take focus
        // from whichever app has it. Clicking a menu bar popover means another app always
        // does, so the app itself has to be brought forward too.
        const win = this.getMainWindow();
        if (win) {
          app.focus({ steal: true });
          win.show();
          win.focus();
        }
        return true;
      }

      case 'tray.deleteEvent': {
        const accountId = typeof params.accountId === 'string' ? params.accountId : '';
        const eventId = typeof params.eventId === 'string' ? params.eventId : '';
        const service = this.getCalendarService();
        if (service && accountId && eventId) {
          log.info(`Deleting ${eventId} from ${accountId}`);
          void service.deleteEvent(accountId, eventId);
        }
        return true;
      }

      case 'tray.setTaskCompleted': {
        const accountId = typeof params.accountId === 'string' ? params.accountId : '';
        const eventId = typeof params.eventId === 'string' ? params.eventId : '';
        // Absent means complete, so an older helper that only ever ticked tasks off
        // still does that rather than reopening them.
        const completed = typeof params.completed === 'boolean' ? params.completed : true;
        const service = this.getCalendarService();
        if (service && accountId && eventId) {
          log.info(`Marking ${eventId} on ${accountId} ${completed ? 'complete' : 'open'}`);
          void service.setTaskCompleted(accountId, eventId, completed);
        }
        return true;
      }

      case 'tray.rsvp': {
        const accountId = typeof params.accountId === 'string' ? params.accountId : '';
        const eventId = typeof params.eventId === 'string' ? params.eventId : '';
        // The answer arrives as the word, not a code. It used to be a number, and the
        // numbering collided with the `myResponseStatus` codes the poller reports — `2` is
        // tentative there and meant declined here — so the popover's Maybe button declined
        // the meeting. Nothing downstream is numeric: this ends at a click on Google's own
        // Yes, No or Maybe button, so there was never anything for a code to carry.
        const raw = params.response;
        const responseStr: RsvpResponse | null =
          raw === 'yes' || raw === 'no' || raw === 'maybe' ? raw : null;
        if (!responseStr) {
          log.warn(`Ignoring an RSVP with no recognisable answer on ${accountId}`);
          return true;
        }

        const service = this.getCalendarService();
        if (service && accountId && eventId) {
          log.info(`Answering ${responseStr} to ${eventId} on ${accountId}`);
          void service.answerRsvp(accountId, eventId, responseStr);
        }
        return true;
      }

      case 'tray.showAccount': {
        const accountId = typeof params.accountId === 'string' ? params.accountId : '';
        if (!accountId) return true;

        const manager = this.getAccountsManager();
        if (!manager) {
          // No window to switch in, so one is opened on that account.
          this.onOpenApp?.(accountId);
          return true;
        }

        manager.switchAccount(accountId);
        const win = this.getMainWindow();
        if (win) {
          win.show();
          win.focus();
        }
        return true;
      }

      case 'tray.ensureRange': {
        const targetDateMs = typeof params.targetDateMs === 'number' ? params.targetDateMs : null;
        if (targetDateMs) {
          const target = new Date(targetDateMs);
          const start = new Date(target);
          start.setDate(start.getDate() - 60);
          const end = new Date(target);
          end.setDate(end.getDate() + 60);

          const startMs = start.getTime();
          const endMs = end.getTime();
          this.visibleRangeStartMs =
            this.visibleRangeStartMs !== null
              ? Math.min(this.visibleRangeStartMs, startMs)
              : startMs;
          this.visibleRangeEndMs =
            this.visibleRangeEndMs !== null ? Math.max(this.visibleRangeEndMs, endMs) : endMs;

          const service = this.getCalendarService();
          if (service) {
            void service.ensureRange(start, end);
          }
          this.pushUpdate();
        }
        return true;
      }

      case 'tray.setCalendarCollapsed': {
        const isCollapsed = Boolean(params.isCollapsed);
        saveSetting('isCalendarCollapsed', isCollapsed);
        return true;
      }

      case 'tray.setShowCompletedTasks': {
        const show = Boolean(params.showCompletedTasks);
        saveSetting('showCompletedTasks', show);
        this.pushUpdate();
        return true;
      }

      // Persisted here rather than in the helper, which is restarted freely; a filter that
      // forgets itself on every rebuild reads as broken.
      case 'tray.setHiddenCalendars': {
        const raw = params.hiddenCalendars;
        const hidden = Array.isArray(raw)
          ? raw.filter(
              (entry): entry is CalendarRef =>
                typeof entry === 'object' &&
                entry !== null &&
                typeof (entry as CalendarRef).accountId === 'string' &&
                typeof (entry as CalendarRef).calendarId === 'string',
            )
          : [];
        saveSetting('hiddenCalendars', hidden);
        log.info(`${hidden.length} calendar(s) hidden in the popover`);
        return true;
      }

      case 'tray.search': {
        const query = typeof params.query === 'string' ? params.query : '';
        const accountId = typeof params.accountId === 'string' ? params.accountId : undefined;
        if (query) {
          log.info(`Search requested from tray${accountId ? ` in ${accountId}` : ''}`);
          this.onSearch?.(query, accountId);
        }
        return true;
      }

      case 'tray.popoverOpened': {
        this.visibleRangeStartMs = null;
        this.visibleRangeEndMs = null;
        this.getCalendarService()?.refreshIfStale();
        return true;
      }

      case 'tray.refresh': {
        this.getCalendarService()?.pollNow();
        return true;
      }

      default:
        return false;
    }
  }

  public isCreated(): boolean {
    return this.trayCreated;
  }
}
