import { describe, expect, it, vi } from 'vitest';
import type { CalendarMeta } from '../src/accounts.js';
import {
  CALENDAR_METADATA_EXTRACT_SCRIPT,
  DOMCalendarMetadataProvider,
  OAuthCalendarMetadataProvider,
} from '../src/calendar-provider.js';

describe('calendar-provider', () => {
  describe('DOMCalendarMetadataProvider', () => {
    it('returns empty array when view is destroyed', async () => {
      const mockView = {
        webContents: {
          isDestroyed: vi.fn().mockReturnValue(true),
          executeJavaScript: vi.fn(),
        },
      } as any;

      const provider = new DOMCalendarMetadataProvider(mockView);
      const results = await provider.fetchCalendars();
      expect(results).toEqual([]);
      expect(mockView.webContents.executeJavaScript).not.toHaveBeenCalled();
    });

    // Pass-through only: the page is mocked, so this says nothing about what the scrape
    // reads. `the calendar list scrape` below runs the real script against a document.
    it('carries back whatever the page returned, unchanged', async () => {
      const mockCalendars = [
        { id: 'primary@example.com', name: 'Primary', color: '#c19a00' },
        {
          id: 'team@group.calendar.google.com',
          name: 'Team',
          color: '#7cb342',
        },
      ];

      const mockView = {
        webContents: {
          isDestroyed: vi.fn().mockReturnValue(false),
          executeJavaScript: vi.fn().mockResolvedValue(mockCalendars),
        },
      } as any;

      const provider = new DOMCalendarMetadataProvider(mockView);
      const results = await provider.fetchCalendars();
      expect(results).toEqual(mockCalendars);
    });

    it('handles script errors gracefully by returning empty array', async () => {
      const mockView = {
        webContents: {
          isDestroyed: vi.fn().mockReturnValue(false),
          executeJavaScript: vi.fn().mockRejectedValue(new Error('Script timeout')),
        },
      } as any;

      const provider = new DOMCalendarMetadataProvider(mockView);
      const results = await provider.fetchCalendars();
      expect(results).toEqual([]);
    });
  });

  describe('OAuthCalendarMetadataProvider', () => {
    it('fetches and maps Google Calendar API v3 calendarList correctly', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [
            {
              id: 'primary@example.com',
              summary: 'Primary Calendar',
              backgroundColor: '#4285f4',
              selected: true,
            },
            {
              id: 'team@group.calendar.google.com',
              summary: 'Engineering Team',
              backgroundColor: '#0b8043',
              selected: false,
            },
          ],
        }),
      });

      const provider = new OAuthCalendarMetadataProvider('mock-token-xyz', mockFetch as any);
      const results = await provider.fetchCalendars();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://www.googleapis.com/calendar/v3/users/me/calendarList',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer mock-token-xyz',
            Accept: 'application/json',
          },
        }),
      );

      expect(results).toEqual([
        {
          id: 'primary@example.com',
          name: 'Primary Calendar',
          color: '#4285f4',
        },
        {
          id: 'team@group.calendar.google.com',
          name: 'Engineering Team',
          color: '#0b8043',
        },
      ]);
    });

    it('throws when API returns an error response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });

      const provider = new OAuthCalendarMetadataProvider('expired-token', mockFetch as any);
      await expect(provider.fetchCalendars()).rejects.toThrow(
        'Google Calendar API v3 returned HTTP 401',
      );
    });
  });

  // The script is what reads the sidebar; `fetchCalendars` only carries back what it
  // returns. So the decisions every event's colour, every card's label and every id in
  // the popover's filter rest on are all made inside the string, and a mocked
  // `executeJavaScript` exercises none of them. It is run here against a document shaped
  // like the one Google renders.
  describe('the calendar list scrape', () => {
    interface FakeElement {
      getAttribute(name: string): string | null;
      querySelector(selector: string): FakeElement | null;
      querySelectorAll(selector: string): FakeElement[];
      innerText?: string;
      textContent?: string;
      /** What `getComputedStyle` reports for `--checkbox-color` on this element. */
      computedColour?: string;
    }

    interface FakeDocument {
      querySelectorAll(selector: string): FakeElement[];
      getElementById(id: string): { textContent: string } | null;
    }

    function checkbox(label: string | undefined): FakeElement {
      return {
        getAttribute: (name) => (name === 'aria-label' ? (label ?? null) : null),
        querySelector: () => null,
        querySelectorAll: () => [],
      };
    }

    /** One row of the calendar list: a base64 `data-id`, a labelled checkbox, a colour. */
    function sidebarRow(options: {
      id: string;
      label?: string;
      inlineColour?: string;
      computedColour?: string;
      text?: string;
      /** For a `data-id` that is not base64 of a calendar address. */
      rawDataId?: string;
      withCheckbox?: boolean;
    }): FakeElement {
      const box = options.withCheckbox === false ? null : checkbox(options.label);
      return {
        getAttribute: (name) => {
          if (name === 'data-id') {
            return options.rawDataId ?? Buffer.from(options.id, 'utf8').toString('base64');
          }
          if (name === 'style') {
            return options.inlineColour ? `--checkbox-color: ${options.inlineColour};` : '';
          }
          return null;
        },
        querySelector: () => box,
        querySelectorAll: () => (box ? [box] : []),
        innerText: options.text ?? '',
        textContent: options.text ?? '',
        computedColour: options.computedColour,
      };
    }

    function documentWith(rows: FakeElement[], hydrated?: unknown): FakeDocument {
      return {
        querySelectorAll: (selector) => (selector === 'div[data-id]' ? rows : []),
        getElementById: (id) =>
          id === 'initialdata' && hydrated !== undefined
            ? { textContent: JSON.stringify(hydrated) }
            : null,
      };
    }

    function scrape(document: FakeDocument): CalendarMeta[] {
      const window = {
        getComputedStyle: (element: FakeElement) => ({
          getPropertyValue: (property: string) =>
            property === '--checkbox-color' ? (element.computedColour ?? '') : '',
        }),
      };
      // Parenthesised: the script opens on a newline, and `return` followed by one is
      // `return;`.
      const run = new Function(
        'document',
        'window',
        `return (${CALENDAR_METADATA_EXTRACT_SCRIPT});`,
      ) as (d: FakeDocument, w: unknown) => CalendarMeta[];
      return run(document, window);
    }

    /** The shape the page hydrates its calendar list into: `data[39][1][2][1]`. */
    function hydratedPayload(entries: unknown[]): unknown {
      const data: unknown[] = [];
      data[39] = [null, [null, null, [null, entries]]];
      return data;
    }

    function hydratedCalendar(fields: {
      id: string;
      summary?: string;
      customTitle?: string;
      ownerName?: string;
      colour?: number;
    }): unknown {
      const calData: unknown[] = [];
      calData[0] = fields.id;
      calData[1] = [fields.summary ?? null];
      const titleBlock: unknown[] = [fields.customTitle ?? null];
      if (fields.colour !== undefined) titleBlock[5] = fields.colour;
      calData[2] = titleBlock;
      if (fields.ownerName) calData[14] = fields.ownerName;
      return [null, calData];
    }

    it('reads the id, name and colour out of a sidebar row', () => {
      // The id is base64 on the row and plain everywhere else, and it is what every
      // event's colour is looked up under; decoding it is most of the lookup working.
      const results = scrape(
        documentWith([
          sidebarRow({ id: 'taylor@example.com', label: 'Taylor Smith', inlineColour: '#7cb342' }),
          sidebarRow({
            id: 'family@group.calendar.google.com',
            label: 'Family',
            inlineColour: '#d81b60',
          }),
        ]),
      );

      expect(results).toEqual([
        { id: 'taylor@example.com', name: 'Taylor Smith', color: '#7cb342' },
        {
          id: 'family@group.calendar.google.com',
          name: 'Family',
          color: '#d81b60',
        },
      ]);
    });

    it('takes the colour from the computed property when no element carries it inline', () => {
      const results = scrape(
        documentWith([
          sidebarRow({ id: 'taylor@example.com', label: 'Taylor', computedColour: ' #0b8043 ' }),
        ]),
      );

      expect(results[0].color).toBe('#0b8043');
    });

    it('leaves a row nothing has coloured on the default rather than on no colour', () => {
      // An empty hex is not a colour the popover can draw; it reaches every card, dot and
      // menu swatch that calendar owns.
      const results = scrape(
        documentWith([sidebarRow({ id: 'taylor@example.com', label: 'Taylor' })]),
      );

      expect(results[0].color).toBe('#4285f4');
    });

    it('names a row from its own text when the checkbox carries no label', () => {
      const results = scrape(
        documentWith([
          sidebarRow({
            id: 'taylor@example.com',
            withCheckbox: false,
            text: 'Taylor Smith\nAll day',
          }),
        ]),
      );

      expect(results[0].name).toBe('Taylor Smith');
    });

    it('skips a row that is not a calendar, and keeps one copy of a repeated one', () => {
      // A calendar id is always an address, and `data-id` is not exclusive to the calendar
      // list; anything else would reach the filter as a calendar that turns nothing off.
      const results = scrape(
        documentWith([
          sidebarRow({ id: 'my-tasks-list', label: 'Tasks' }),
          sidebarRow({ id: 'taylor@example.com', label: 'Taylor', inlineColour: '#7cb342' }),
          sidebarRow({ id: 'taylor@example.com', label: 'Taylor again', inlineColour: '#000000' }),
          sidebarRow({ id: 'ignored', rawDataId: 'not base64 at all!!', label: 'Nope' }),
        ]),
      );

      expect(results.map((c) => c.id)).toEqual(['taylor@example.com']);
      expect(results[0].name).toBe('Taylor');
    });

    it('falls back to the hydrated payload when the list has not rendered yet', () => {
      // The sync runs a couple of seconds after load, which is not always long enough for
      // the list to exist. The same ids and colours have to come out either way.
      const results = scrape(
        documentWith(
          [],
          hydratedPayload([
            hydratedCalendar({
              id: 'taylor@example.com',
              summary: 'taylor@example.com',
              colour: 0x7cb342,
            }),
            hydratedCalendar({
              id: 'team@group.calendar.google.com',
              summary: 'Team',
              customTitle: 'Engineering',
              colour: 0x0b8043,
            }),
            hydratedCalendar({ id: 'not-a-calendar', summary: 'Tasks' }),
          ]),
        ),
      );

      expect(results).toEqual([
        { id: 'taylor@example.com', name: 'taylor@example.com', color: '#7cb342' },
        {
          id: 'team@group.calendar.google.com',
          // The name the user gave the calendar beats the one its owner gave it.
          name: 'Engineering',
          // A colour whose leading byte is zero still has to come out six digits wide;
          // unpadded it reads as `#b8043`, which matches no swatch.
          color: '#0b8043',
        },
      ]);
    });

    it('returns nothing rather than throwing when the payload is not what it expects', () => {
      expect(scrape(documentWith([], { 39: 'unexpected' }))).toEqual([]);
    });
  });
});
