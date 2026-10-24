import { colourForId } from './google-colours.js';
import type { CalendarMeta } from './accounts.js';
import { CALENDARS_WITH_NO_BLOCK, friendlyCalendarName } from './calendars.js';

/**
 * calendar-list.ts
 *
 * What an account's calendars are, read from the response its own view already fetches.
 *
 * `sync.sync` is the web client's own sync channel, and its full response states every
 * calendar the account has: the name Google shows, the colour it paints, and the
 * notification times it applies by default. Nothing else carries all three.
 * `secondarycalendars` returns a subset -- three of eight on a measured account, omitting
 * the primary, the holidays and a group calendar under "My calendars" -- and
 * `sync.prefetcheventrange` carries no calendar metadata at all.
 *
 * Whether a calendar is ticked in Google's sidebar is deliberately not read. No field
 * here was measured to hold it: the one that looked like it reported a ticked calendar as
 * unticked. What a calendar shows in is Magical's own filter, which the user sets in the
 * popover; see `docs/magical/menu-bar.md#calendar-filter-and-focus`.
 *
 * It is read from `initialdata`, the script tag Google embeds in the page itself, which
 * carries the list on every load. The same list is in a `sync.sync` response, but only in
 * a full sync: a client holding a usable sync token asks for a delta instead, and a delta
 * carries no calendars. That endpoint also cannot be asked for -- it answers 403 without
 * the opaque token the web client builds -- so a response would have to be intercepted,
 * and most of the ones intercepted would be empty.
 */

/** One calendar as the page states it, before any colour is resolved. */
export interface RawCalendar {
  id: string;
  name: string;
  /** Index into Google's palette, when the calendar uses a preset colour. */
  colourIndex: number | null;
  /** The colour as a packed RGB integer. Only meaningful for a custom colour. */
  colourValue: number | null;
  /**
   * `2` when the colour is one of Google's presets, `1` when it is a custom one.
   *
   * The distinction matters because the packed value is the preset's colour in Google's
   * *old* palette: Peacock reads `#9FE1E7` where Google paints `#039BE5`. Read without
   * the flag, every preset calendar comes out the wrong colour.
   */
  colourKind: number | null;
  /** Minutes before the event, for the notifications this calendar applies by default. */
  defaultReminderMinutes: number[];
}

/** A calendar with its colour resolved to what Google paints. */
export interface ResolvedCalendar extends Omit<
  RawCalendar,
  'colourIndex' | 'colourValue' | 'colourKind'
> {
  colourHex: string | null;
}

const COLOUR_PRESET = 2;
const COLOUR_CUSTOM = 1;
/** Notifications delivered on screen; an email reminder is not one this app can show. */
const REMINDER_NOTIFICATION = 2;

function parseColourKind(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseColourValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
      return Number.parseInt(trimmed.slice(1), 16);
    }
    if (/^0x[0-9a-fA-F]{6}$/i.test(trimmed)) {
      return Number.parseInt(trimmed.slice(2), 16);
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Pulls the calendar list out of the parsed contents of the `initialdata` script tag.
 *
 * Every index is guarded, and a page that carries no list returns nothing rather than
 * throwing: this runs in a preload against a document Google controls, and an exception
 * there would cost the account its calendars for the whole session.
 */
export function extractRawCalendarList(parsed: unknown): RawCalendar[] {
  const list = Array.isArray(parsed) ? parsed[39]?.[1]?.[2]?.[1] : null;
  if (!Array.isArray(list)) return [];

  const calendars: RawCalendar[] = [];
  for (const entry of list) {
    const calendar = Array.isArray(entry) ? entry[1] : null;
    if (!Array.isArray(calendar) || typeof calendar[0] !== 'string') continue;

    const meta = Array.isArray(calendar[1]) ? calendar[1] : [];
    const colour = Array.isArray(calendar[2]) ? calendar[2] : [];
    const reminders = Array.isArray(calendar[4]) ? calendar[4] : [];

    const index = Number.parseInt(String(colour[4]), 10);
    // Three fields can name a calendar and Google shows the first of them that is set.
    // `[14]` names the account's own calendar; `[2][0]` is the name the user gave any
    // other, sitting in the same block as its colour; `[1][0]` is the one Google
    // generated, which for a subscribed feed is the URL it was added from.
    const named = [calendar[14], colour[0], meta[0]].find(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
    );
    calendars.push({
      id: calendar[0],
      name: named ?? calendar[0],
      colourIndex: Number.isFinite(index) ? index : null,
      colourValue: parseColourValue(colour[5]),
      colourKind: parseColourKind(colour[7]),
      defaultReminderMinutes: reminders
        .filter(
          (r: unknown): r is [number, number] =>
            Array.isArray(r) && r[0] === REMINDER_NOTIFICATION && typeof r[1] === 'number',
        )
        .map((r) => r[1]),
    });
  }
  return calendars;
}

/**
 * Extracts the user's Gaia ID from initialdata.
 *
 * Position [52] is the scalar Gaia ID, and position [0][1] holds the same ID
 * beside the user's base64 and plaintext email.
 */
export function extractGaiaId(parsed: unknown): string | null {
  if (!Array.isArray(parsed)) return null;
  const candidate52 = parsed[52];
  if (typeof candidate52 === 'string' && /^\d+$/.test(candidate52)) {
    return candidate52;
  }
  const root0 = parsed[0];
  if (Array.isArray(root0) && typeof root0[1] === 'string' && /^\d+$/.test(root0[1])) {
    return root0[1];
  }
  return null;
}

/**
 * Google's public browser API key, out of the page's `WIZ_global_data` script.
 *
 * `WIZ_global_data` is the page's own configuration object, embedded in a `<script>` tag
 * and carrying exactly one `AIza...` value: the key Google's web client sends on its
 * internal RPCs, including the Tasks sync. It is read by shape rather than by the
 * obfuscated field name, which moves between builds. A page that carries no key returns
 * `null`, and the poller then omits the header rather than sending an empty one.
 */
export function extractGoogleApiKey(scriptText: string | null | undefined): string | null {
  if (!scriptText) return null;
  const match = scriptText.match(/AIza[0-9A-Za-z_-]{35}/);
  return match?.[0] ?? null;
}

/**
 * The colour Google paints a calendar.
 *
 * A preset resolves through the palette, because the number beside it is that colour in
 * Google's old palette and would paint the wrong thing. A custom colour has no preset to
 * resolve to and the number is the colour itself; measured by setting a live calendar to
 * `#03E596`, which arrived as `255382` with the custom flag and an index naming the
 * nearest preset, which is not the colour and is ignored.
 */
export function resolveCalendarColour(raw: RawCalendar): string | null {
  if (raw.colourKind === COLOUR_CUSTOM && raw.colourValue !== null) {
    return `#${(raw.colourValue >>> 0).toString(16).padStart(6, '0').slice(-6).toUpperCase()}`;
  }
  if (raw.colourKind === COLOUR_PRESET && raw.colourIndex !== null) {
    return colourForId(raw.colourIndex);
  }
  if (
    raw.colourKind === null &&
    raw.colourValue !== null &&
    (raw.colourIndex === null || !colourForId(raw.colourIndex))
  ) {
    return `#${(raw.colourValue >>> 0).toString(16).padStart(6, '0').slice(-6).toUpperCase()}`;
  }
  return null;
}

/** The calendar list with each colour resolved to the hex Google paints. */
export function resolveCalendarList(raw: RawCalendar[]): ResolvedCalendar[] {
  return raw.map(({ colourIndex, colourValue, colourKind, ...rest }) => ({
    ...rest,
    colourHex: resolveCalendarColour({ colourIndex, colourValue, colourKind, ...rest }),
  }));
}

/**
 * The account's calendars, as the sync response leaves them.
 *
 * What the account already held decides two things the response does not. A colour this
 * build cannot resolve keeps the one it had, because an unresolved colour means the
 * palette has moved rather than that the calendar has none. And the tick in Magical's own
 * settings is the user's, so it survives untouched.
 */
export function mergeCalendarList(
  existing: CalendarMeta[],
  incoming: ResolvedCalendar[],
  accountColour: string,
): CalendarMeta[] {
  const held = new Map(existing.map((c) => [c.id, c]));

  const listed = incoming.map((cal) => ({
    id: cal.id,
    // A subscribed feed is named after the URL it was subscribed from, which is what
    // Google stores rather than what it shows. The rendered sidebar has the name the user
    // sees, so a URL here means "no name" and leaves whatever that put there.
    name: /^https?:\/\//.test(cal.name)
      ? (held.get(cal.id)?.name ?? friendlyCalendarName(cal.id))
      : cal.name,
    color: cal.colourHex ?? held.get(cal.id)?.color ?? accountColour,
    ...(cal.defaultReminderMinutes.length > 0
      ? { defaultReminderMinutes: cal.defaultReminderMinutes }
      : {}),
  }));

  // Birthdays and Tasks appear in Google's sidebar and never in this list, because Google
  // does not serve them as calendars. Dropping what the list omits would take them off the
  // account, and a contact's birthday is filed on one of them -- so it would lose its name
  // and its colour and fall back to the account's.
  const named = new Set(incoming.map((c) => c.id));
  const unlisted = existing.filter((c) => !named.has(c.id) && CALENDARS_WITH_NO_BLOCK.has(c.id));

  return [...listed, ...unlisted];
}
