/**
 * ics-file.ts
 *
 * Reads just enough of an iCalendar file to describe it to the user.
 *
 * Deliberately not a parser. Google parses the file — every `VEVENT`, every `RRULE`,
 * every `VTIMEZONE` — and getting that right is the whole reason the import is driven
 * through Calendar's own pane rather than reconstructed over the wire. All this needs to
 * answer is what the account picker and the notification say: how many events are in
 * there, and what the first one is called.
 *
 * Nothing here decides whether the import goes ahead. An unreadable file still reaches
 * Google, which is the only opinion on validity that matters.
 */
import { uiString } from './strings.js';

export interface IcsSummary {
  /** `VEVENT` blocks in the file. Zero means nothing recognisable was found. */
  eventCount: number;
  /** The first event's `SUMMARY`, for naming the import in the picker and the banner. */
  title?: string;
  /** The first event's start, as written. Absent when it is unparseable. */
  startsAt?: Date;
}

/**
 * Joins continuation lines back onto the line they belong to.
 *
 * RFC 5545 folds any line over 75 octets by breaking it and prefixing the remainder with
 * a single space or tab. A long `SUMMARY` therefore arrives in pieces, and reading the
 * file line by line would truncate every title that needs this most.
 */
function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if (/^[ \t]/.test(raw) && lines.length > 0) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  return lines;
}

/**
 * Splits `SUMMARY;LANGUAGE=en:Dentist` into its name and its value.
 *
 * The parameters between the name and the colon are discarded: they qualify the value's
 * encoding and language, and neither changes what a one-line description says.
 */
function property(line: string): { name: string; value: string } | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const name = line.slice(0, colon).split(';')[0].trim().toUpperCase();
  return name ? { name, value: line.slice(colon + 1) } : null;
}

/** Undoes the escaping iCalendar applies to text values. */
function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .trim();
}

/**
 * Reads an iCalendar `DATE` or `DATE-TIME` value.
 *
 * Local and UTC forms only. A `TZID` names an Olson zone this does not resolve, so the
 * time is taken at face value — it is off by the zone's offset at worst, in a line of
 * text that exists to help the user recognise the file they just opened.
 */
export function parseIcsDate(value: string): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!match) return undefined;

  const [, year, month, day, hour, minute, second, utc] = match;
  const parts = [year, month, day, hour ?? '00', minute ?? '00', second ?? '00'].map(Number);
  const date = utc
    ? new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]))
    : new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);

  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Describes an iCalendar file's contents. Never throws; an unrecognisable file reads as zero events. */
export function summariseIcs(text: string): IcsSummary {
  let eventCount = 0;
  let depth = 0;
  let title: string | undefined;
  let startsAt: Date | undefined;

  for (const line of unfold(text)) {
    const parsed = property(line);
    if (!parsed) continue;
    const { name, value } = parsed;

    // Counted on BEGIN rather than END so a truncated file still reports the event it
    // was part-way through writing, which is what the user will see in Google's own count.
    if (name === 'BEGIN' && value.trim().toUpperCase() === 'VEVENT') {
      eventCount++;
      depth++;
      continue;
    }
    if (name === 'END' && value.trim().toUpperCase() === 'VEVENT') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    // Only from inside the first VEVENT. A calendar-level SUMMARY names the whole feed,
    // and taking it would label a 200-event subscription with the feed's own name.
    if (depth === 0 || eventCount !== 1) continue;
    if (name === 'SUMMARY' && title === undefined) title = unescapeText(value) || undefined;
    if (name === 'DTSTART' && startsAt === undefined) startsAt = parseIcsDate(value);
  }

  return { eventCount, title, startsAt };
}

/**
 * The line under "Import into", naming what is about to be imported.
 *
 * The first event's title carries a single invitation, which is the common case by a
 * long way. A file holding several is described by its count instead: listing them would
 * outgrow the alert, and the titles are not what the user is choosing between.
 */
export function describeIcs(summary: IcsSummary, fileName: string): string {
  if (summary.eventCount > 1) {
    return uiString('dialog.ics.describe.multiple', {
      count: summary.eventCount,
      file: fileName,
    });
  }

  const title = summary.title ?? fileName;
  if (!summary.startsAt) return uiString('dialog.ics.describe.titled', { title });

  const when = summary.startsAt.toLocaleString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
  return uiString('dialog.ics.describe.titledWhen', { title, when });
}
