import type { CalendarAccount } from './accounts.js';
import type { NormalizedCalendarEvent } from './calendar-decoder.js';
import { uiString } from './strings.js';

export interface SerializedTrayCalendar {
  id: string;
  accountId: string;
  name: string;
  colorHex: string;
}

export interface CalendarResolution {
  calendars: SerializedTrayCalendar[];
  /**
   * Colour and name per account, then per calendar id.
   *
   * Nested rather than flat, because a calendar id does not identify a calendar on its
   * own: Google gives Birthdays, Tasks and each locale's holidays the same id in every
   * account, so a flat map let whichever account was processed last paint both accounts'
   * events in its colour and name.
   */
  calendarColorMap: Map<string, Map<string, string>>;
  calendarNameMap: Map<string, Map<string, string>>;
}

export const GOOGLE_CALENDAR_DEFAULT_SWATCHES: string[] = [
  '#039be5', // Peacock (Blue)
  '#33b679', // Sage (Green)
  '#f6bf26', // Banana (Yellow)
  '#d81b60', // Cherry Blossom (Pink)
  '#8e24aa', // Grape (Purple)
  '#f4511e', // Tangerine (Orange)
  '#0b8043', // Basil (Dark Green)
  '#3f51b5', // Blueberry (Indigo)
  '#b39ddb', // Wisteria (Light Purple)
  '#e67c73', // Flamingo (Coral)
  '#4285f4', // Cobalt
  '#ef6c00', // Pumpkin
];

/**
 * Produces a human-readable display name for a Google Calendar ID.
 *
 * Google Calendar IDs for imported/subscribed calendars look like:
 *   imported_feed_sample_01@import.calendar.google.com
 *   en.uk#holiday@group.v.calendar.google.com
 *   abcdef1234567890@group.calendar.google.com
 */
export function friendlyCalendarName(calId: string): string {
  if (calId.includes('contacts@group.v.calendar.google.com') || calId.includes('birthdays')) {
    return uiString('calendar.birthdays');
  }
  if (calId.startsWith('family') || calId.includes('family')) {
    return uiString('calendar.family');
  }
  if (calId.includes('#holiday@group.v.calendar.google.com')) {
    const locale = calId.split('#')[0];
    const country = locale.split('.').pop()?.toUpperCase() ?? '';
    return country
      ? uiString('calendar.holidays', { country })
      : uiString('calendar.holidaysGeneric');
  }
  if (calId.includes('@import.calendar.google.com')) {
    const prefix = calId.split('@')[0];
    return prefix.length > 20 ? uiString('calendar.imported') : prefix.replace(/_/g, ' ');
  }
  if (calId.includes('@') && !calId.includes('@group.') && !calId.includes('@import.')) {
    const namePart = calId.split('@')[0].replace(/[._]/g, ' ');
    return namePart
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  if (
    calId.includes('@group.v.calendar.google.com') ||
    calId.includes('@group.calendar.google.com')
  ) {
    return uiString('calendar.shared');
  }
  return calId;
}

export function resolvePrimaryEmail(account: CalendarAccount | undefined): string {
  if (!account) return '';
  return (
    account.email ||
    (account.calendarIds || []).find(
      (id) => id.includes('@') && !id.includes('@group.') && !id.includes('@import.'),
    ) ||
    account.id
  );
}

/**
 * Calendar ids Google does not serve as calendars, however they got onto an account.
 *
 * `sync.prefetcheventrange` answers either of these with an empty payload even when it is
 * the only calendar named, so asking for them costs a slot in every poll and returns
 * nothing. Their entries arrive inside the primary calendar's block instead, marked by
 * `IDX.eventType`.
 */
export const CALENDARS_WITH_NO_BLOCK = new Set([
  'tasks@tasks.google.com',
  'birthdays@birthdays.google.com',
]);

/**
 * Whether a calendar id is somebody's mailbox rather than a calendar in its own right.
 *
 * Group, imported, holiday and resource calendars all carry a suffix that says what they
 * are; a person's calendar is just their address.
 */
function isPersonalAddress(calendarId: string): boolean {
  if (!calendarId.includes('@')) return false;
  return !(
    calendarId.includes('@group.') ||
    calendarId.includes('@import.') ||
    calendarId.includes('@resource.') ||
    calendarId.includes('#holiday@') ||
    CALENDARS_WITH_NO_BLOCK.has(calendarId)
  );
}

/**
 * Whether the account's own calendar list has to name a calendar before it is worth
 * polling.
 *
 * A colleague and a meeting room reach the account the same way: search for the one or
 * book the other, and Google's client names it in a range request, from where it is
 * unioned onto the account and polled for ever after. Neither is on the user's calendar
 * list, and a room brings every booking anybody makes in it. One work account was
 * polling a room it had booked once, which put 282 of somebody else's meetings a poll
 * into the agenda, under the room's raw id and with no colour, because a calendar the
 * list does not name has no name or colour to draw.
 */
function needsSubscription(calendarId: string): boolean {
  return isPersonalAddress(calendarId) || calendarId.includes('@resource.');
}

/**
 * The calendars worth asking Google for on this account's behalf.
 *
 * `calendarIds` is a record of every calendar the account's own view has ever named in a
 * range request, and Google's web client names more than the user subscribes to: open
 * "Meet with" or search for a colleague and their calendar goes into a request, from
 * where it is unioned onto the account and polled for ever after. One work account had
 * accumulated five colleagues that way, and they accounted for 65% of the events it
 * cached.
 *
 * That is not merely wasted work. An event sitting on several calendars comes back once
 * under each, so polling a colleague's calendar changes which copies of the user's own
 * meetings arrive, and the account's own colours and names go missing from the result.
 *
 * A colleague's calendar, and a meeting room, are dropped unless the account's own
 * calendar list names it, which is what tells a calendar the user subscribes to apart
 * from one they once looked at or booked. Nothing else in the response distinguishes
 * them: both are that person's or that room's calendar, and both flag it as the owner.
 */
export function pollableCalendarIds(account: CalendarAccount): string[] {
  const known = account.calendarIds ?? [];
  // An account whose view has never loaded knows no calendars, and a guess is worse than
  // nothing here: the range endpoint answers an unknown calendar with an empty payload,
  // so it would read as "you have no meetings" rather than as an error.
  if (known.length === 0) return [];

  const useless = (id: string) => CALENDARS_WITH_NO_BLOCK.has(id);

  // The account's own calendars, which is what separates a colleague's calendar the user
  // subscribes to from one they merely looked at. Nothing in a response distinguishes
  // them -- both are that person's calendar, and both name that person as its owner.
  const own = new Set((account.calendars ?? []).map((c) => c.id));
  // With no list to judge against, only the calendars that cannot answer are dropped.
  if (own.size === 0) return known.filter((id) => !useless(id));

  return known.filter((id) => {
    if (id === account.id || id === 'primary') return true;
    if (useless(id)) return false;
    if (needsSubscription(id)) return own.has(id);
    return true;
  });
}

export function resolveCanonicalCalendarId(
  calendarId: string,
  account: CalendarAccount | undefined,
): string {
  if (!account) return calendarId;
  const primaryEmail = resolvePrimaryEmail(account);
  const isPrimaryMatch =
    calendarId === primaryEmail || calendarId === 'primary' || calendarId === account.id;

  return isPrimaryMatch ? primaryEmail : calendarId;
}

/**
 * The key a per-account alert mute is stored under: `accountId|calendarId`.
 *
 * The account as well as the calendar, because Google gives Birthdays, Tasks and each
 * locale's holidays the same id in every account, and muting one account's must not
 * silence another's. A bare calendar id is the older shape and still matches in every
 * account, so a mute saved before this change keeps working.
 */
export function calendarAlertKey(accountId: string, calendarId: string): string {
  return `${accountId}|${calendarId}`;
}

/**
 * Builds the canonical list of calendars across all configured accounts, enriching names
 * and colours from discovered metadata or events.
 */
export function buildSerializedCalendars(
  accounts: CalendarAccount[],
  eventsMap?: Map<string, NormalizedCalendarEvent[]>,
): CalendarResolution {
  const serializedCalendars: SerializedTrayCalendar[] = [];
  const calendarColorMap = new Map<string, Map<string, string>>();
  const calendarNameMap = new Map<string, Map<string, string>>();

  for (const account of accounts) {
    const primaryEmail = resolvePrimaryEmail(account);
    // Scoped to the account. A calendar id is not unique across accounts -- Birthdays,
    // Tasks and each locale's holidays share one -- so a set carried between accounts
    // would drop the second account's copy of a calendar the first had already named.
    const seenCalendars = new Set<string>();
    const colors = new Map<string, string>();
    const names = new Map<string, string>();
    calendarColorMap.set(account.id, colors);
    calendarNameMap.set(account.id, names);

    seenCalendars.add(account.id);
    seenCalendars.add(primaryEmail);
    seenCalendars.add('primary');

    if (account.calendars && account.calendars.length > 0) {
      for (const cal of account.calendars) {
        const isPrimary =
          cal.id === primaryEmail ||
          cal.id === account.id ||
          cal.id === 'primary' ||
          (Boolean(account.email) && cal.id === account.email);

        const canonicalId = isPrimary ? primaryEmail : cal.id;
        seenCalendars.add(cal.id);
        seenCalendars.add(canonicalId);

        colors.set(cal.id, cal.color);
        colors.set(canonicalId, cal.color);
        names.set(cal.id, cal.name);
        names.set(canonicalId, cal.name);

        if (isPrimary) {
          colors.set('primary', cal.color);
          colors.set(account.id, cal.color);
          names.set('primary', cal.name);
          names.set(account.id, cal.name);
        }

        serializedCalendars.push({
          id: canonicalId,
          accountId: account.id,
          name: cal.name,
          colorHex: cal.color,
        });
      }
    } else {
      const primaryDisplayName =
        account.email || (primaryEmail.includes('@') ? primaryEmail : account.name);
      const primaryColor = account.color;

      colors.set(primaryEmail, primaryColor);
      colors.set('primary', primaryColor);
      colors.set(account.id, primaryColor);
      names.set(primaryEmail, primaryDisplayName);
      names.set('primary', primaryDisplayName);
      names.set(account.id, primaryDisplayName);

      serializedCalendars.push({
        id: primaryEmail,
        accountId: account.id,
        name: primaryDisplayName,
        colorHex: primaryColor,
      });

      let secondaryIdx = 0;
      for (const calId of account.calendarIds || []) {
        if (!seenCalendars.has(calId)) {
          seenCalendars.add(calId);
          const secondaryColor =
            GOOGLE_CALENDAR_DEFAULT_SWATCHES[
              secondaryIdx % GOOGLE_CALENDAR_DEFAULT_SWATCHES.length
            ];
          secondaryIdx++;

          const friendlyName = friendlyCalendarName(calId);
          colors.set(calId, secondaryColor);
          names.set(calId, friendlyName);

          serializedCalendars.push({
            id: calId,
            accountId: account.id,
            name: friendlyName,
            colorHex: secondaryColor,
          });
        }
      }
    }
  }

  if (eventsMap) {
    for (const [accountId, events] of eventsMap.entries()) {
      const account = accounts.find((a) => a.id === accountId);
      const primaryEmail = resolvePrimaryEmail(account);
      const names = calendarNameMap.get(accountId);

      for (const event of events) {
        if (!event.calendarName?.trim() || account?.calendars?.length) continue;
        // A name describes one calendar, and an event held by several does not say which
        // of them it names, so only an event on a single calendar may rename one.
        if (event.calendarIds.length !== 1) continue;

        const calendarId = event.calendarIds[0];
        const isPrimaryMatch =
          calendarId === primaryEmail || calendarId === 'primary' || calendarId === accountId;
        const wanted = isPrimaryMatch ? primaryEmail : calendarId;

        // Found by account as well as by id: the same id is Birthdays in every account,
        // and a name read from one account's event must not rename another's calendar.
        const existing = serializedCalendars.find(
          (c) => c.accountId === accountId && c.id === wanted,
        );
        if (!existing) continue;

        existing.name = event.calendarName;
        names?.set(existing.id, event.calendarName);
      }
    }
  }

  return {
    calendars: serializedCalendars,
    calendarColorMap,
    calendarNameMap,
  };
}
