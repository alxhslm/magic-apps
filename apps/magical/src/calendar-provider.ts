import type { WebContentsView } from 'electron';
import { viewIsAlive } from '@magimail/core';
import type { CalendarMeta } from './accounts.js';
import type { NormalizedCalendarEvent } from './calendar-decoder.js';

export interface DateRange {
  start: Date;
  end: Date;
}

/**
 * Pluggable provider interface for calendar metadata (names, colors, visibility).
 * Designed so that Magical can effortlessly swap between:
 * 1. DOM / semantic accessibility attributes from the live session (`DOMCalendarMetadataProvider`)
 * 2. Official Google Calendar API v3 with OAuth (`OAuthCalendarMetadataProvider`)
 * 3. Future providers (e.g. Apple EventKit or Microsoft Graph).
 */
export interface CalendarMetadataProvider {
  readonly kind: 'dom-session' | 'oauth-v3' | 'mock';
  fetchCalendars(): Promise<CalendarMeta[]>;
}

/**
 * Pluggable provider interface for reading calendar events.
 * Swappable between session cookie poller (`sync.prefetcheventrange`),
 * OAuth 2.0 API v3, or DOM extraction.
 */
export interface CalendarEventProvider {
  readonly kind: 'google-session' | 'oauth-v3' | 'dom-extraction' | 'eventkit';
  fetchRange(range: DateRange): Promise<NormalizedCalendarEvent[]>;
}

/**
 * Extracts authentic calendar names, colors, and visibility flags
 * from Google Calendar's live semantic sidebar DOM elements (`div[data-id]`).
 *
 * Uses standard ARIA attributes (`aria-label`, `input[type="checkbox"].checked`)
 * and `--checkbox-color` custom property, making it robust against internal class name changes.
 */
export class DOMCalendarMetadataProvider implements CalendarMetadataProvider {
  public readonly kind = 'dom-session' as const;

  constructor(private readonly view: WebContentsView) {}

  public async fetchCalendars(): Promise<CalendarMeta[]> {
    if (!viewIsAlive(this.view)) return [];

    try {
      const results = await this.view.webContents.executeJavaScript(
        CALENDAR_METADATA_EXTRACT_SCRIPT,
      );
      return Array.isArray(results) ? results : [];
    } catch {
      return [];
    }
  }
}

/**
 * What runs inside the account's own page to read its calendar list.
 *
 * A module constant rather than a string built inside `fetchCalendars`, so it can be run
 * against a document in a test. Everything a colour, a name or the filter's ids depend on
 * is decided in here, and a mocked `executeJavaScript` exercises none of it.
 */
export const CALENDAR_METADATA_EXTRACT_SCRIPT = `
        (() => {
          const results = [];
          const seen = new Set();

          // 1. Semantic DOM elements in active sidebar
          const rows = Array.from(document.querySelectorAll('div[data-id]'));
          for (const div of rows) {
            const base64Id = div.getAttribute('data-id');
            if (!base64Id) continue;
            let id = base64Id;
            try {
              id = atob(base64Id);
            } catch {
              continue;
            }
            if (!id || !id.includes('@')) continue;

            const checkbox = div.querySelector('input[type="checkbox"]');
            const name = checkbox?.getAttribute('aria-label') || (div.innerText || div.textContent || '').trim().split('\\n')[0];

            let color = '';
            for (const el of [div, ...div.querySelectorAll('*')]) {
              const style = el.getAttribute('style') || '';
              const match = style.match(/--checkbox-color:\\s*([^;]+)/i);
              if (match) {
                color = match[1].trim();
                break;
              }
              const cs = window.getComputedStyle(el);
              const varVal = cs.getPropertyValue('--checkbox-color')?.trim();
              if (varVal) {
                color = varVal;
                break;
              }
            }

            if (!seen.has(id)) {
              seen.add(id);
              results.push({ id, name: name || id, color: color || '#4285f4' });
            }
          }

          // 2. Fallback to server-hydrated <script id="initialdata"> if DOM isn't ready
          if (results.length === 0) {
            try {
              const scriptEl = document.getElementById('initialdata');
              if (scriptEl && scriptEl.textContent) {
                const data = JSON.parse(scriptEl.textContent);
                const list = data?.[39]?.[1]?.[2]?.[1];
                if (Array.isArray(list)) {
                  for (const item of list) {
                    const calData = item?.[1];
                    if (!Array.isArray(calData)) continue;
                    const id = calData[0];
                    if (typeof id !== 'string' || !id.includes('@')) continue;

                    const customTitle = calData[2]?.[0];
                    const summary = calData[1]?.[0];
                    const ownerName = typeof calData[14] === 'string' ? calData[14] : undefined;
                    const name = customTitle || ownerName || summary || id;

                    const rawColor = calData[2]?.[5];
                    let colorInt = null;
                    if (typeof rawColor === 'number') {
                      colorInt = rawColor;
                    } else if (typeof rawColor === 'string') {
                      const trimmed = rawColor.trim();
                      if (/^#?[0-9a-fA-F]{6}$/.test(trimmed)) {
                        colorInt = parseInt(trimmed.replace(/^#/, ''), 16);
                      } else {
                        const parsed = parseInt(trimmed, 10);
                        if (!isNaN(parsed)) colorInt = parsed;
                      }
                    }
                    const color = colorInt !== null
                      ? '#' + (colorInt >>> 0).toString(16).padStart(6, '0').slice(-6)
                      : '#4285f4';

                    if (!seen.has(id)) {
                      seen.add(id);
                      results.push({ id, name, color });
                    }
                  }
                }
              }
            } catch {}
          }

          return results;
        })()
      `;

/**
 * Drop-in OAuth 2.0 provider for Google Calendar API v3 (`GET /calendar/v3/users/me/calendarList`).
 * If an OAuth client/token is configured, Magical can plug this in with zero changes to downstream consumers.
 */
export class OAuthCalendarMetadataProvider implements CalendarMetadataProvider {
  public readonly kind = 'oauth-v3' as const;

  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  public async fetchCalendars(): Promise<CalendarMeta[]> {
    const url = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';
    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Google Calendar API v3 returned HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      items?: Array<{
        id: string;
        summary: string;
        backgroundColor?: string;
      }>;
    };

    if (!Array.isArray(data.items)) return [];

    return data.items.map((item) => ({
      id: item.id,
      name: item.summary,
      color: item.backgroundColor || '#4285f4',
    }));
  }
}
