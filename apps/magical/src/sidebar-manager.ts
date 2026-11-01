import { BaseWindow, shell } from 'electron';
import { createLogger } from '@magimail/core/logger';
import { loadAddon } from './native-addon.js';
import { loadSettings, saveSetting } from './settings-store.js';
import { loadAccounts, type CalendarAccount } from './accounts.js';
import type { NormalizedCalendarEvent } from './calendar-decoder.js';
import { buildSerializedCalendars, friendlyCalendarName } from './calendars.js';
import { uiString } from './strings.js';
import { buildEventLink, extractEid } from './event-links.js';
import type { AccountsManager } from './accounts-manager.js';
import type { CalendarService } from './calendar-service.js';
import { CALENDAR_MIN_HEIGHT, SIDEBAR_WIDTH, windowMinWidth } from './window-layout.js';

const log = createLogger('SidebarManager');

function hiddenKey(accountId: string, calendarId: string): string {
  return `${accountId}:${calendarId}`;
}

export class SidebarManager {
  private attachedWindow: BaseWindow | null = null;
  private isVisible: boolean;
  private position: 'left' | 'right';
  private cachedAccounts: CalendarAccount[] = [];
  private cachedEvents = new Map<string, NormalizedCalendarEvent[]>();
  private activeTimeframe = 'month';
  private activeDateStr?: string;

  constructor(
    private readonly getMainWindow: () => BaseWindow | null,
    private readonly getAccountsManager: () => AccountsManager | null,
    private readonly getCalendarService?: () => CalendarService | null | undefined,
  ) {
    const settings = loadSettings();
    this.isVisible = settings.sidebarVisible ?? true;
    this.position = settings.sidebarPosition ?? 'right';
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
      addon.sidebarSetViewMode?.(this.activeTimeframe, this.activeDateStr);
      addon.sidebarSetTransparency?.(settings.transparentBackground ?? true, true);
      this.pushData();
    } catch (err) {
      log.warn('Could not attach native sidebar:', err);
    }
  }

  public toggleSidebar(): void {
    this.isVisible = !this.isVisible;
    saveSetting('sidebarVisible', this.isVisible);
    this.updateWindowMinSize();

    try {
      loadAddon().sidebarSetVisible?.(this.isVisible, true);
    } catch (err) {
      log.warn('Could not set sidebar visible:', err);
    }

    // Resize Google Calendar's view
    this.getAccountsManager()?.updateLayout();
  }

  public setVisible(visible: boolean): void {
    if (this.isVisible === visible) return;
    this.isVisible = visible;
    saveSetting('sidebarVisible', this.isVisible);
    this.updateWindowMinSize();
    try {
      loadAddon().sidebarSetVisible?.(this.isVisible, true);
    } catch (err) {
      log.warn('Could not set sidebar visible:', err);
    }
    this.getAccountsManager()?.updateLayout();
  }

  public updateAccounts(accounts: CalendarAccount[]): void {
    this.cachedAccounts = accounts;
    this.pushData();
  }

  public updateEvents(eventsByAccount: Map<string, NormalizedCalendarEvent[]>): void {
    this.cachedEvents = eventsByAccount;
    this.pushData();
  }

  public setTimeframe(timeframe: string, dateStr?: string): void {
    this.activeTimeframe = timeframe;
    this.activeDateStr = dateStr;
    try {
      loadAddon().sidebarSetViewMode?.(timeframe, dateStr);
    } catch (err) {
      log.warn('Could not set sidebar view mode:', err);
    }
  }

  public setTransparency(transparent: boolean, isDark: boolean): void {
    try {
      loadAddon().sidebarSetTransparency?.(transparent, isDark);
    } catch (err) {
      log.warn('Could not set sidebar transparency:', err);
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
        if (value && /^https?:\/\//i.test(value)) {
          void shell.openExternal(value);
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
    }
  }

  private pushData(): void {
    try {
      const addon = loadAddon();
      if (!addon.sidebarUpdateData) return;

      const settings = loadSettings();
      const hiddenCalendars = settings.hiddenCalendars ?? [];
      const hidden = new Set(hiddenCalendars.map((c) => hiddenKey(c.accountId, c.calendarId)));

      const accountsList = this.getAccounts();
      const {
        calendars: serializedCalendars,
        calendarColorMap,
        calendarNameMap,
      } = buildSerializedCalendars(accountsList, this.cachedEvents);

      const serializedEvents: Array<Record<string, unknown>> = [];
      const now = Date.now();
      const windowStart = now - 30 * 86_400_000;
      const windowEnd = now + 90 * 86_400_000;

      for (const [accountId, events] of this.cachedEvents.entries()) {
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
        const canonicalise = (id: string): string =>
          id === primaryEmail || id === 'primary' || id === accountId ? primaryEmail : id;

        for (const event of events) {
          const calendarIds = [...new Set(event.calendarIds.map(canonicalise))];
          const shownOn =
            calendarIds.find((id) => !hidden.has(hiddenKey(accountId, id))) ??
            calendarIds[0] ??
            primaryEmail;
          if (
            calendarIds.length > 0 &&
            calendarIds.every((id) => hidden.has(hiddenKey(accountId, id)))
          ) {
            continue;
          }

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
