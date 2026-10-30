import { createLogger } from '@magimail/core/logger';
import { sendToHelper, isHelperAvailable } from './swift-helper.js';
import { uiString } from './strings.js';

const log = createLogger('NotificationManager');
import { allDayLocalDate } from './all-day.js';
import { buildEventLink } from './event-links.js';
import type { ScheduledAlert } from './alert-scheduler.js';

/**
 * notification-manager.ts
 *
 * Turns a fired alert into a native banner, and routes what the user presses back.
 *
 * The banner is posted by `MagicalHelper` rather than by Electron because Electron's
 * `Notification` cannot render action buttons on macOS, and the buttons are the reason
 * the feature is worth having. See
 * `docs/magical/notifications.md#posting-the-banner`.
 */

export type AlertActionKind = 'open' | 'join' | 'snooze' | `rsvp:${'yes' | 'maybe' | 'no'}`;

export interface AlertAction {
  key: string;
  accountId: string;
  eventId: string;
  /** `magical://` link to the event, for `open`. */
  deepLink: string;
  conferenceUrl?: string;
  action: AlertActionKind;
}

let onAction: ((action: AlertAction) => void) | null = null;
let onAuthorization: ((granted: boolean) => void) | null = null;

/**
 * Called once, with the outcome of the permission prompt.
 *
 * Denial is the failure mode worth hearing about: every later dispatch still succeeds,
 * no banner is drawn, and nothing in the app would otherwise notice.
 */
export function setAuthorizationHandler(handler: (granted: boolean) => void): void {
  onAuthorization = handler;
}

export function setAlertActionHandler(handler: (action: AlertAction) => void): void {
  onAction = handler;
}

/** Registers the notification categories and asks for permission, ahead of any meeting. */
export function prepareNotifications(): void {
  if (!isHelperAvailable()) return;
  void sendToHelper('notify.setup');
}

/** "in 5 minutes", or "now" when the lead time has collapsed to nothing. */
export function formatLead(leadMinutes: number): string {
  if (leadMinutes <= 0) return uiString('notification.lead.now');
  if (leadMinutes === 1) return uiString('notification.lead.minute');
  return uiString('notification.lead.minutes', { count: leadMinutes });
}

/**
 * The warning sign in front of a stale banner's body.
 *
 * U+26A0 carries the variation selector U+FE0E so macOS draws the monochrome text glyph
 * rather than the colour emoji, which matches the rest of the banner. An SF Symbols
 * codepoint would look more native still, but `UNMutableNotificationContent.body` is a
 * plain string with no guaranteed font, and an unresolved symbol draws as an empty box.
 */
const STALE_MARK = '\u26A0\uFE0E';

/**
 * How long ago the calendar behind an alert was last read, in words.
 *
 * Rounded to whole minutes and then to whole hours. The reader is deciding whether to
 * trust the banner, not timing anything, and "about 2 hours ago" answers that as well as
 * a figure to the minute would.
 */
export function formatSyncAge(ageMs: number): string {
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 60) return uiString('notification.syncAge.minutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  return hours === 1
    ? uiString('notification.syncAge.hour')
    : uiString('notification.syncAge.hours', { count: hours });
}

/**
 * The banner's three lines.
 *
 * macOS lays a banner out as title, subtitle, then body. The meeting's name is the title
 * because it is what identifies the alert at a glance; the countdown is the subtitle,
 * matching Calendar; and the location or call provider is the body.
 *
 * A stale source says so in the body, replacing the location or provider rather than
 * joining it. An alert fired from a calendar nothing has read for half an hour may be
 * announcing a meeting that has since moved or been cancelled, and the user acts on the
 * banner without opening the popover that carries the same warning. Where the meeting is
 * matters less than whether it is still happening.
 *
 * Nothing is added while a source is reading normally, which is almost always.
 */
export function buildAlertContent(
  alert: ScheduledAlert,
  staleForMs?: number,
): {
  title: string;
  subtitle: string;
  body: string;
} {
  const { event } = alert;
  const time = event.startTime.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

  let body = '';
  if (staleForMs !== undefined) {
    body = `${STALE_MARK} ${uiString('notification.stale', { age: formatSyncAge(staleForMs) })}`;
  } else if (event.conferenceUrl) {
    body = conferenceLabel(event.conferenceUrl);
  } else if (event.location) {
    body = event.location;
  }

  return {
    title: event.summary || uiString('notification.noTitle'),
    subtitle: `${formatLead(alert.leadMinutes)} · ${time}`,
    body,
  };
}

/**
 * Named only where the name earns its place.
 *
 * Meet, Zoom and Teams are the three anyone recognises on sight, and the three
 * `toNativeMeetingUrl` knows how to open in their own client. Everything else is a video
 * call, which is all the reader needs: the link works the same either way, and a provider
 * nobody can picture tells them nothing. `TrayEvent.conferenceServiceName` has to say the
 * same, or one meeting reads two ways.
 */
/**
 * Names the service a meeting URL belongs to.
 *
 * Exported because the widget snapshot carries the same name. `TrayModel.swift`
 * keeps its own copy for the popover, and all three have to agree: one meeting
 * reaching the user in a banner, in the popover and on a widget must not read
 * three ways.
 */
export function conferenceLabel(url: string): string {
  if (url.includes('meet.google.com')) return 'Google Meet';
  if (url.includes('zoom.us')) return 'Zoom';
  if (url.includes('teams.microsoft.com') || url.includes('teams.live.com'))
    return 'Microsoft Teams';
  return uiString('notification.videoCall');
}

/**
 * Posts one alert. Silently does nothing when the helper is absent, as under `pnpm dev`.
 *
 * `staleForMs` is how long the source has gone without a successful read, and is passed
 * only when that is long enough to matter; see `buildAlertContent`.
 */
export function dispatchAlert(alert: ScheduledAlert, accountId: string, staleForMs?: number): void {
  if (!isHelperAvailable()) {
    log.warn(`Helper unavailable; no banner for ${alert.event.id}`);
    return;
  }

  // The title, subtitle and body are calendar content and stay out of the log; whether a
  // banner was asked for, and whether it could offer a Join button, is the diagnosis.
  log.info(
    `Posting banner for ${alert.event.id}, join button ${alert.event.conferenceUrl ? 'yes' : 'no'}`,
  );

  const { title, subtitle, body } = buildAlertContent(alert, staleForMs);
  void sendToHelper('alert.dispatch', {
    key: alert.key,
    accountId,
    // Carried so the helper can drop the banner when a Focus filter silences every calendar
    // the event is on. The decision belongs there, at the moment of posting: an alert the
    // scheduler never armed cannot fire when the Focus ends five minutes later.
    calendarIds: alert.event.calendarIds,
    eventId: alert.event.id,
    title,
    subtitle,
    body,
    deepLink: buildEventLink(alert.event, accountId),
    // Absent rather than empty, so the helper can pick the category without a button it
    // cannot fulfil.
    ...(alert.event.conferenceUrl ? { conferenceUrl: alert.event.conferenceUrl } : {}),
  });
}

/**
 * When an invitation starts, for the line under its title.
 *
 * An all-day event is a calendar date, so its line is read from the date's UTC fields and
 * names the day the event is on rather than the machine's day before it. A timed event is an
 * instant and stays on the machine's clock, which is the hour the user is having.
 *
 * Lives here rather than beside its toolbar caller because the banner needs the same line and
 * cannot reach `calendar-service.ts`, which imports this module. One meeting must not be
 * worded two ways, the way `conferenceLabel` is shared for the same reason.
 */
export function formatInviteLine(start: Date, isAllDay: boolean, now = new Date()): string {
  const when = isAllDay ? allDayLocalDate(start) : start;
  const sameYear = when.getFullYear() === now.getFullYear();

  return isAllDay
    ? when.toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        ...(sameYear ? {} : { year: 'numeric' }),
      })
    : when.toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        ...(sameYear ? {} : { year: 'numeric' }),
        hour: 'numeric',
        minute: '2-digit',
      });
}

/**
 * Posts an invitation banner.
 *
 * Separate from `dispatchAlert` because it is a different notification: state-based
 * rather than time-based, and answered rather than acted on. The organiser is the title,
 * since who is asking is what decides the answer.
 *
 * `isAllDay` decides whether the body is a date or a date and a clock time, so an all-day
 * invitation does not announce an hour it does not have.
 */
export function dispatchInvite(invite: {
  key: string;
  accountId: string;
  calendarIds: string[];
  eventId: string;
  summary: string;
  organizerEmail?: string;
  startTime: Date;
  isAllDay: boolean;
  deepLink: string;
}): void {
  if (!isHelperAvailable()) return;

  void sendToHelper('alert.dispatch', {
    kind: 'invite',
    key: invite.key,
    accountId: invite.accountId,
    calendarIds: invite.calendarIds,
    eventId: invite.eventId,
    title: invite.summary || uiString('notification.noTitle'),
    subtitle: invite.organizerEmail
      ? uiString('notification.invite.from', { organizer: invite.organizerEmail })
      : uiString('notification.invite.generic'),
    body: formatInviteLine(invite.startTime, invite.isAllDay),
    deepLink: invite.deepLink,
  });
}

/**
 * Posts a banner reporting something that has already finished.
 *
 * No buttons, unlike an alert or an invitation: the work is done, so there is nothing
 * left to act on. Used by the `.ics` import to say what landed and where.
 */
export function dispatchNotice(notice: {
  key: string;
  accountId: string;
  title: string;
  subtitle?: string;
  body?: string;
}): void {
  if (!isHelperAvailable()) {
    log.warn(`Helper unavailable; no banner for ${notice.key}`);
    return;
  }

  void sendToHelper('alert.dispatch', {
    kind: 'notice',
    key: notice.key,
    accountId: notice.accountId,
    title: notice.title,
    ...(notice.subtitle ? { subtitle: notice.subtitle } : {}),
    ...(notice.body ? { body: notice.body } : {}),
  });
}

/** Pulls banners for meetings that were cancelled or moved after they were posted. */
export function withdrawAlerts(keys: string[]): void {
  if (!isHelperAvailable() || keys.length === 0) return;
  void sendToHelper('alert.withdraw', { keys });
}

/**
 * Handles an `alert.action` event from the helper.
 *
 * Returns whether the event was ours, so the caller can go on trying other handlers.
 */
export function handleNotificationEvent(method: string, params: Record<string, unknown>): boolean {
  if (method === 'notify.authorization') {
    onAuthorization?.(params.granted === true);
    return true;
  }
  if (method !== 'alert.action') return false;

  const conferenceUrl = typeof params.conferenceUrl === 'string' ? params.conferenceUrl : '';
  const key = String(params.key ?? '');
  const accountId = String(params.accountId ?? '');
  const action = (params.action as AlertActionKind) ?? 'open';
  // Logged on arrival, not only on the action that follows: a response the helper
  // never sends and one that arrives but opens nothing look identical otherwise.
  log.info(`Received alert.action: key=${key} account=${accountId} action=${action}`);
  onAction?.({
    key,
    accountId,
    eventId: String(params.eventId ?? ''),
    deepLink: String(params.deepLink ?? ''),
    conferenceUrl: conferenceUrl || undefined,
    action,
  });
  return true;
}
