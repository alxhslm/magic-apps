import { BaseWindow } from 'electron';
import { createLogger } from '@magimail/core/logger';
import { loadAddon } from './native-addon.js';
import { loadSettings, saveSetting, type CalendarRef } from './settings-store.js';
import { loadAccounts, type CalendarAccount } from './accounts.js';
import type { NormalizedCalendarEvent } from './calendar-decoder.js';
import {
  buildSerializedCalendars,
  friendlyCalendarName,
  canonicaliseCalendarId,
  hiddenKey,
} from './calendars.js';
import { uiString } from './strings.js';
import { buildEventLink, extractEid } from './event-links.js';
import type { AccountsManager } from './accounts-manager.js';
import type { CalendarService } from './calendar-service.js';
import { CALENDAR_MIN_HEIGHT, windowMinWidth } from './window-layout.js';
import { GCAL_SCROLL_TO_HOUR_CHANNEL } from './constants.js';

const log = createLogger('SidebarManager');

export class SidebarManager {
  private attachedWindow: BaseWindow | null = null;
  private isVisible: boolean;
  private cachedAccounts: CalendarAccount[] = [];
  private cachedEvents = new Map<string, NormalizedCalendarEvent[]>();
  private activeTimeframe: string;
  private activeDateStr?: string;
  /**
   * The weekday Google Calendar's grid is starting its weeks on for the account on screen,
   * as Apple's `.weekday` number, or undefined until a grid has reported one.
   *
   * Kept here rather than in the helper because the helper is restarted freely and a week
   * start that forgets itself on a crash is the bug this exists to avoid; it is stored per
   * account in settings and re-read whenever the account changes.
   */
  private activeFirstWeekday?: number;
  /**
   * How far the agenda has asked for events beyond the default window.
   *
   * Schedule is a continuous feed, so scrolling forward has to widen the window the
   * sidebar serialises, not only what the poller fetches; otherwise the events arrive
   * in the cache and are filtered out on the way to the sidebar.
   */
  private visibleRangeStartMs: number | null = null;
  private visibleRangeEndMs: number | null = null;
  public onFilterChanged?: () => void;

  constructor(
    private readonly getMainWindow: () => BaseWindow | null,
    private readonly getAccountsManager: () => AccountsManager | null,
    private readonly getCalendarService?: () => CalendarService | null | undefined,
  ) {
    const settings = loadSettings();
    this.isVisible = settings.sidebarVisible ?? true;
    this.activeTimeframe = settings.lastTimeframe ?? 'day';
    this.activeDateStr = settings.lastDateStr;
  }

  public updateWindowMinSize(): void {
    const win = this.getMainWindow();
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
    const minW = windowMinWidth(this.isVisible);
    if (typeof win.setMinimumSize === 'function') {
      win.setMinimumSize(minW, CALENDAR_MIN_HEIGHT);
    }
  }

  public getAccounts(): CalendarAccount[] {
    if (this.cachedAccounts.length > 0) return this.cachedAccounts;
    const fromMgr = this.getAccountsManager?.()?.getAccounts();
    if (fromMgr && fromMgr.length > 0) return fromMgr;
    return loadAccounts();
  }

  public attach(window: BaseWindow): void {
    this.attachedWindow = window;
    this.updateWindowMinSize();
    try {
      const addon = loadAddon();
      const handle = window.getNativeWindowHandle();
      const settings = loadSettings();
      addon.sidebarAttach?.(handle);
      addon.sidebarSetVisible?.(this.isVisible, false);
      addon.sidebarSetViewMode?.(
        this.activeTimeframe,
        this.activeDateStr,
        this.resolveFirstWeekday(),
      );
      addon.sidebarSetTransparency?.(settings.transparentBackground ?? true, true);
      this.pushData();
    } catch (err) {
      log.warn('Could not attach native sidebar:', err);
    }
  }

  public toggleSidebar(): void {
    this.isVisible = !this.isVisible;
    saveSetting('sidebarVisible', this.isVisible);

    let targetWindowWidth = 0;
    let handledByAddon = false;
    try {
      const addon = loadAddon();
      if (typeof addon.sidebarSetVisible === 'function') {
        const res = addon.sidebarSetVisible(this.isVisible, true);
        if (typeof res === 'number') {
          targetWindowWidth = res;
        }
        handledByAddon = true;
      }
    } catch (err) {
      log.warn('Could not set sidebar visible:', err);
    }

    if (!handledByAddon) {
      this.updateWindowMinSize();
    }

    const accountsMgr = this.getAccountsManager();
    if (accountsMgr) {
      if (targetWindowWidth > 0 && typeof accountsMgr.beginWindowAnimation === 'function') {
        accountsMgr.beginWindowAnimation(targetWindowWidth, this.isVisible);
      } else if (
        handledByAddon &&
        targetWindowWidth === 0 &&
        typeof accountsMgr.animateContentResize === 'function'
      ) {
        accountsMgr.animateContentResize(this.isVisible, 250);
      } else if (!this.isVisible && handledByAddon) {
        // In a wide window that does not shrink, let the sidebar collapse out of sight
        // first (250ms), and then expand GCal to fill the window.
        setTimeout(() => {
          accountsMgr.updateLayout();
        }, 250);
      } else {
        accountsMgr.updateLayout();
      }
    }
  }

  public setVisible(visible: boolean): void {
    if (this.isVisible === visible) return;
    this.isVisible = visible;
    saveSetting('sidebarVisible', this.isVisible);

    let targetWindowWidth = 0;
    let handledByAddon = false;
    try {
      const addon = loadAddon();
      if (typeof addon.sidebarSetVisible === 'function') {
        const res = addon.sidebarSetVisible(this.isVisible, true);
        if (typeof res === 'number') {
          targetWindowWidth = res;
        }
        handledByAddon = true;
      }
    } catch (err) {
      log.warn('Could not set sidebar visible:', err);
    }

    if (!handledByAddon) {
      this.updateWindowMinSize();
    }

    const accountsMgr = this.getAccountsManager();
    if (accountsMgr) {
      if (targetWindowWidth > 0 && typeof accountsMgr.beginWindowAnimation === 'function') {
        accountsMgr.beginWindowAnimation(targetWindowWidth, this.isVisible);
      } else if (
        handledByAddon &&
        targetWindowWidth === 0 &&
        typeof accountsMgr.animateContentResize === 'function'
      ) {
        accountsMgr.animateContentResize(this.isVisible, 250);
      } else if (!this.isVisible && handledByAddon) {
        setTimeout(() => {
          accountsMgr.updateLayout();
        }, 250);
      } else {
        accountsMgr.updateLayout();
      }
    }
  }

  public updateAccounts(accounts: CalendarAccount[]): void {
    this.cachedAccounts = accounts;
    // The account on screen has its own Start of the week, so the previous account's value
    // goes and the new one's is read from settings. Its grid re-reports a moment later, but
    // the frame in between is drawn before that arrives.
    const previous = this.activeFirstWeekday;
    this.activeFirstWeekday = undefined;
    const resolved = this.resolveFirstWeekday();
    if (resolved !== previous) {
      try {
        loadAddon().sidebarSetViewMode?.(this.activeTimeframe, this.activeDateStr, resolved);
      } catch (err) {
        log.warn('Could not set sidebar view mode:', err);
      }
    }
    this.pushData();
  }

  public updateEvents(eventsByAccount: Map<string, NormalizedCalendarEvent[]>): void {
    this.cachedEvents = eventsByAccount;
    this.pushData();
  }

  public setTimeframe(timeframe: string, dateStr?: string, firstWeekday?: number): void {
    const previousFirstWeekday = this.activeFirstWeekday;
    if (firstWeekday !== undefined && firstWeekday !== previousFirstWeekday) {
      this.activeFirstWeekday = firstWeekday;
      this.rememberFirstWeekday(firstWeekday);
    }
    // A changed Start of the week is why this comparison looks at three things: Google
    // re-lays out its grid without moving the date, so the sidebar has to change with it.
    if (
      this.activeTimeframe === timeframe &&
      this.activeDateStr === dateStr &&
      previousFirstWeekday === this.activeFirstWeekday
    ) {
      return;
    }
    log.info(
      `Setting sidebar timeframe: ${timeframe} (date: ${dateStr}, first weekday: ${this.activeFirstWeekday})`,
    );
    this.activeTimeframe = timeframe;
    this.activeDateStr = dateStr;
    saveSetting('lastTimeframe', timeframe);
    if (dateStr) saveSetting('lastDateStr', dateStr);
    try {
      loadAddon().sidebarSetViewMode?.(timeframe, dateStr, this.activeFirstWeekday);
    } catch (err) {
      log.warn('Could not set sidebar view mode:', err);
    }
  }

  /**
   * The weekday Google's grid last reported for the account on screen.
   *
   * Undefined on the very first launch for an account, and in any view whose grid cannot
   * say which day a week starts on before that account has ever shown one. The helper
   * falls back to the Mac's first day for that frame.
   */
  private resolveFirstWeekday(): number | undefined {
    if (this.activeFirstWeekday !== undefined) return this.activeFirstWeekday;
    const accountId =
      this.getAccountsManager?.()?.getActiveAccountId?.() ?? loadSettings().lastActiveAccountId;
    if (!accountId) return undefined;
    // A settings file written before this key existed has no entry for anyone, and the
    // caller reads undefined as "this account has never reported one".
    return (loadSettings().firstWeekdayByAccount ?? {})[accountId];
  }

  /** Writes a reported weekday back to settings, so the next first frame already knows it. */
  private rememberFirstWeekday(firstWeekday: number): void {
    const accountId =
      this.getAccountsManager?.()?.getActiveAccountId?.() ?? loadSettings().lastActiveAccountId;
    if (!accountId) return;
    const stored = loadSettings().firstWeekdayByAccount ?? {};
    if (stored[accountId] === firstWeekday) return;
    saveSetting('firstWeekdayByAccount', { ...stored, [accountId]: firstWeekday });
  }

  public setTransparency(transparent: boolean, isDark: boolean): void {
    try {
      loadAddon().sidebarSetTransparency?.(transparent, isDark);
    } catch (err) {
      log.warn('Could not set sidebar transparency:', err);
    }
  }

  public setScrollPosition(
    hour: number,
    hourHeight: number,
    gridTop?: number,
    gridHeight?: number,
    cardTop?: number,
  ): void {
    if (!this.isVisible) return;
    try {
      loadAddon().sidebarSetScrollPosition?.(
        hour,
        hourHeight,
        gridTop ?? 148,
        gridHeight ?? 600,
        cardTop ?? 64,
      );
    } catch (err) {
      log.warn('Could not set sidebar scroll position:', err);
    }
  }

  public handleSidebarAction(action: string, value: string): void {
    switch (action) {
      case 'toggleSidebar':
        this.toggleSidebar();
        break;

      case 'sidebarSelectDate': {
        // Date selection updates sidebar view internally without forcing a web page reload.
        break;
      }

      case 'sidebarOpenEvent': {
        const eventId = value;
        const manager = this.getAccountsManager();
        const service = this.getCalendarService?.();
        if (!manager) return;
        for (const [accountId, events] of this.cachedEvents.entries()) {
          const evt = events.find((e) => e.id === eventId);
          if (evt) {
            manager.switchAccount(accountId);
            if (service) {
              service.openDeepLink(buildEventLink(evt, accountId));
            } else {
              const eid = extractEid(evt) ?? evt.chipEid ?? evt.id;
              void manager.revealEvent(accountId, eid, evt.startTime);
            }
            break;
          }
        }
        break;
      }

      case 'sidebarJoinCall': {
        // Through the service, so the call is opened the way every other Join is: native client
        // where there is one, and the account's own browser profile otherwise. The view sends the
        // account with the URL, since it knows which event the Join belongs to.
        const [accountId, url] = splitJoinValue(value);
        if (url && /^https?:\/\//i.test(url)) {
          void this.getCalendarService?.()?.joinCall(url, accountId);
        }
        break;
      }

      case 'sidebarDeleteEvent': {
        const colonIdx = value.indexOf(':');
        if (colonIdx > 0) {
          const accountId = value.slice(0, colonIdx);
          const eventId = value.slice(colonIdx + 1);
          log.info(`Deleting event ${eventId} from ${accountId}`);
          void this.getCalendarService?.()?.deleteEvent(accountId, eventId);
        }
        break;
      }

      case 'sidebarCompleteTask': {
        const parts = value.split(':');
        if (parts.length >= 3) {
          const accountId = parts[0];
          const eventId = parts[1];
          const completed = parts[2] === 'true';
          log.info(`Marking task ${eventId} on ${accountId} ${completed ? 'complete' : 'open'}`);
          void this.getCalendarService?.()?.setTaskCompleted(accountId, eventId, completed);
        }
        break;
      }

      case 'sidebarRsvp': {
        const parts = value.split(':');
        if (parts.length >= 3) {
          const accountId = parts[0];
          const eventId = parts[1];
          const raw = parts[2].toLowerCase();
          const responseStr = raw === 'yes' || raw === 'no' || raw === 'maybe' ? raw : null;
          if (responseStr) {
            const service = this.getCalendarService?.();
            if (service) {
              log.info(`Answering ${responseStr} to ${eventId} on ${accountId}`);
              void service.answerRsvp(accountId, eventId, responseStr);
            }
          }
        }
        break;
      }

      case 'sidebarRefresh': {
        log.info('Refreshing calendars from sidebar');
        this.getCalendarService?.()?.pollNow();
        break;
      }

      case 'sidebarFilterChanged': {
        try {
          const raw = JSON.parse(value);
          const hidden: CalendarRef[] = Array.isArray(raw)
            ? raw
                .filter(
                  (entry): entry is CalendarRef =>
                    typeof entry === 'object' &&
                    entry !== null &&
                    typeof (entry as CalendarRef).accountId === 'string' &&
                    typeof (entry as CalendarRef).calendarId === 'string',
                )
                .map((ref) => ({
                  accountId: ref.accountId,
                  calendarId: canonicaliseCalendarId(ref.calendarId),
                }))
            : [];
          saveSetting('hiddenCalendars', hidden);
          const revision = (loadSettings().hiddenCalendarsRevision ?? 0) + 1;
          saveSetting('hiddenCalendarsRevision', revision);
          log.info(`${hidden.length} calendar(s) hidden via sidebar (revision ${revision})`);
          this.onFilterChanged?.();
        } catch (err) {
          log.warn('Could not parse sidebarFilterChanged:', err);
        }
        break;
      }

      case 'sidebarSetShowCompletedTasks': {
        const show = value === 'true';
        log.info(`Show completed tasks changed via sidebar: ${show}`);
        saveSetting('showCompletedTasks', show);
        this.onFilterChanged?.();
        break;
      }

      case 'sidebarEnsureRange': {
        const targetMs = Number(value);
        if (!Number.isFinite(targetMs)) break;
        const target = new Date(targetMs);
        const start = new Date(target);
        start.setDate(start.getDate() - 60);
        const end = new Date(target);
        end.setDate(end.getDate() + 60);
        const startMs = start.getTime();
        const endMs = end.getTime();

        this.visibleRangeStartMs =
          this.visibleRangeStartMs !== null ? Math.min(this.visibleRangeStartMs, startMs) : startMs;
        this.visibleRangeEndMs =
          this.visibleRangeEndMs !== null ? Math.max(this.visibleRangeEndMs, endMs) : endMs;

        log.info(`Sidebar agenda asked for events around ${target.toISOString()}`);
        void this.getCalendarService?.()?.ensureRange(start, end);
        this.pushData();
        break;
      }

      case 'sidebarScroll': {
        const hour = parseFloat(value);
        if (!isNaN(hour) && hour >= 0 && hour <= 24) {
          this.scrollMainGridToHour(hour);
        }
        break;
      }
    }
  }

  private scrollMainGridToHour(hour: number): void {
    const manager = this.getAccountsManager();
    if (!manager) return;
    const view = manager.getActiveView();
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.send(GCAL_SCROLL_TO_HOUR_CHANNEL, { hour });
    }
  }

  /**
   * Sends only the filter fields, which the sidebar's `TrayModel.update` applies on its
   * own. A filter toggle should not wait on serialising every event to reach the pane the
   * user is watching.
   */
  public pushFilterState(): void {
    try {
      const addon = loadAddon();
      if (!addon.sidebarUpdateData) return;
      const settings = loadSettings();
      addon.sidebarUpdateData(
        JSON.stringify({
          hiddenCalendars: (settings.hiddenCalendars ?? []).map((c) => ({
            accountId: c.accountId,
            calendarId: canonicaliseCalendarId(c.calendarId),
          })),
          hiddenCalendarsRevision: settings.hiddenCalendarsRevision ?? 0,
          showCompletedTasks: Boolean(settings.showCompletedTasks),
        }),
      );
    } catch (err) {
      log.warn('Could not push the sidebar filter:', err);
    }
  }

  public pushData(): void {
    try {
      const addon = loadAddon();
      if (!addon.sidebarUpdateData) return;

      const settings = loadSettings();
      const hiddenCalendars = (settings.hiddenCalendars ?? []).map((c) => ({
        accountId: c.accountId,
        calendarId: canonicaliseCalendarId(c.calendarId),
      }));
      const hidden = new Set(hiddenCalendars.map((c) => hiddenKey(c.accountId, c.calendarId)));

      const accountsList = this.getAccounts();
      const eventsMap =
        this.cachedEvents.size > 0
          ? this.cachedEvents
          : (this.getCalendarService?.()?.getCachedEvents() ?? this.cachedEvents);
      if (this.cachedEvents.size === 0 && eventsMap.size > 0) {
        this.cachedEvents = eventsMap;
      }

      const {
        calendars: serializedCalendars,
        calendarColorMap,
        calendarNameMap,
      } = buildSerializedCalendars(accountsList, eventsMap);

      const serializedEvents: Array<Record<string, unknown>> = [];
      const now = Date.now();
      const defaultPastMs = 30 * 86_400_000;
      const defaultAheadMs = 90 * 86_400_000;
      const windowStart =
        this.visibleRangeStartMs !== null
          ? Math.min(this.visibleRangeStartMs, now - defaultPastMs)
          : now - defaultPastMs;
      const windowEnd =
        this.visibleRangeEndMs !== null
          ? Math.max(this.visibleRangeEndMs, now + defaultAheadMs)
          : now + defaultAheadMs;

      for (const [accountId, events] of eventsMap.entries()) {
        const accountColors = calendarColorMap.get(accountId);
        const accountNames = calendarNameMap.get(accountId);
        const account = accountsList.find((a) => a.id === accountId);
        const defaultColor = account?.color || '#039be5';
        const primaryEmail =
          account?.email ||
          (account?.calendarIds || []).find(
            (id) => id.includes('@') && !id.includes('@group.') && !id.includes('@import.'),
          ) ||
          accountId;
        const canonicalise = (id: string): string => {
          const canonical = canonicaliseCalendarId(id);
          return canonical === primaryEmail || canonical === 'primary' || canonical === accountId
            ? primaryEmail
            : canonical;
        };

        for (const event of events) {
          const calendarIds = [...new Set(event.calendarIds.map(canonicalise))];
          const shownOn =
            calendarIds.find((id) => !hidden.has(hiddenKey(accountId, id))) ??
            calendarIds[0] ??
            primaryEmail;

          const startTime = event.startTime.getTime();
          const endTime = event.endTime.getTime();
          if (endTime < windowStart || startTime > windowEnd) continue;

          const colorHex =
            event.colorHex ||
            accountColors?.get(shownOn) ||
            (shownOn === primaryEmail ? accountColors?.get('primary') : undefined) ||
            accountColors?.get(primaryEmail) ||
            defaultColor;
          const calendarName =
            accountNames?.get(shownOn) ||
            (shownOn === primaryEmail ? accountNames?.get('primary') : undefined) ||
            event.calendarName ||
            friendlyCalendarName(shownOn);

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
            myResponseStatus: event.myResponseStatus,
            organizerEmail: event.organizerEmail,
            webUrl: event.webUrl,
            deepLink: buildEventLink(event, accountId),
          });
        }
      }

      serializedEvents.sort((a, b) => (a.startTime as number) - (b.startTime as number));

      const payload = {
        accounts: accountsList.map((a) => ({
          id: a.id,
          name: a.name,
          color: a.color,
          email: a.email || '',
        })),
        calendars: serializedCalendars,
        hiddenCalendars: hiddenCalendars.map((c) => ({
          accountId: c.accountId,
          calendarId: c.calendarId,
        })),
        hiddenCalendarsRevision: settings.hiddenCalendarsRevision ?? 0,
        showCompletedTasks: Boolean(settings.showCompletedTasks),
        events: serializedEvents,
        activeAccountId: this.getAccountsManager()?.getActiveAccountId?.(),
        isCalendarCollapsed: Boolean(settings.isCalendarCollapsed),
      };

      addon.sidebarUpdateData(JSON.stringify(payload));
    } catch (err) {
      log.warn('Could not update sidebar data:', err);
    }
  }
}

/** `accountId|url`, as the sidebar sends it. */
function splitJoinValue(value: string | undefined): [string | undefined, string | undefined] {
  if (!value) return [undefined, undefined];
  const separator = value.indexOf('|');
  if (separator === -1) return [undefined, value];
  return [value.slice(0, separator), value.slice(separator + 1)];
}
