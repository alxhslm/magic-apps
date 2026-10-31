import { BaseWindow, shell } from 'electron';
import { createLogger } from '@magimail/core/logger';
import { loadAddon } from './native-addon.js';
import { loadSettings, saveSetting } from './settings-store.js';
import type { CalendarAccount } from './accounts.js';
import type { NormalizedCalendarEvent } from './calendar-decoder.js';
import { buildSerializedCalendars } from './calendars.js';
import { uiString } from './strings.js';
import { buildEventLink } from './event-links.js';
import type { AccountsManager } from './accounts-manager.js';

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
  ) {
    const settings = loadSettings();
    this.isVisible = settings.sidebarVisible ?? true;
    this.position = settings.sidebarPosition ?? 'right';
  }

  public attach(window: BaseWindow): void {
    this.attachedWindow = window;
    try {
      const addon = loadAddon();
      const handle = window.getNativeWindowHandle();
      addon.sidebarAttach?.(handle);
      addon.sidebarSetVisible?.(this.isVisible, false);
      addon.sidebarSetViewMode?.(this.activeTimeframe, this.activeDateStr);
      this.pushData();
    } catch (err) {
      log.warn('Could not attach native sidebar:', err);
    }
  }

  public toggleSidebar(): void {
    this.isVisible = !this.isVisible;
    saveSetting('sidebarVisible', this.isVisible);

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

  public handleSidebarAction(action: string, value: string): void {
    switch (action) {
      case 'toggleSidebar':
        this.toggleSidebar();
        break;

      case 'sidebarSelectDate': {
        // value is YYYY-MM-DD
        const parts = value.split('-');
        if (parts.length === 3) {
          const y = parseInt(parts[0], 10);
          const m = parseInt(parts[1], 10);
          const d = parseInt(parts[2], 10);
          if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
            const date = new Date(y, m - 1, d);
            void this.getAccountsManager()?.navigateToDate(date);
          }
        }
        break;
      }

      case 'sidebarOpenEvent': {
        const eventId = value;
        const manager = this.getAccountsManager();
        if (!manager) return;
        for (const [accountId, events] of this.cachedEvents.entries()) {
          const evt = events.find((e) => e.id === eventId);
          if (evt) {
            void manager.revealEvent(accountId, eventId, evt.startTime);
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
    }
  }

  private pushData(): void {
    try {
      const addon = loadAddon();
      if (!addon.sidebarUpdateData) return;

      const settings = loadSettings();
      const hiddenCalendars = settings.hiddenCalendars ?? [];
      const hidden = new Set(hiddenCalendars.map((c) => hiddenKey(c.accountId, c.calendarId)));

      const {
        calendars: serializedCalendars,
        calendarColorMap,
        calendarNameMap,
      } = buildSerializedCalendars(this.cachedAccounts, this.cachedEvents);

      const serializedEvents: Array<Record<string, unknown>> = [];
      const now = Date.now();
      const windowStart = now - 30 * 86_400_000;
      const windowEnd = now + 90 * 86_400_000;

      for (const [accountId, events] of this.cachedEvents.entries()) {
        const accountColors = calendarColorMap.get(accountId);
        const accountNames = calendarNameMap.get(accountId);
        const account = this.cachedAccounts.find((a) => a.id === accountId);
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

          const colorHex = event.colorHex || accountColors?.get(shownOn) || defaultColor;
          const calendarName = accountNames?.get(shownOn) || event.calendarName || '';

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
        accounts: this.cachedAccounts.map((a) => ({
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
