# Adaptive sidebar

The companion drawer is not built. The menu bar popover it shares its presentation with ships, and
[`menu-bar.md`](../../docs/magical/menu-bar.md) owns it.

## What the drawer follows

Google Calendar has five timeframes: Day (`D`), Week (`W`), 4 Days or Custom (`X`), Month (`M`) and
Schedule (`A`). The drawer changes what it shows to match the active one. A drawer that ignored the
timeframe fails in one of two ways: a seven-column week in a 280px drawer leaves 35px per column,
too narrow for an event title, and a generic agenda beside Google Calendar's own agenda repeats it,
while independent scrollbars make cross-account free/busy impossible to compare.

- **Day and Week views align to the pixel**: the hour grid and the scroll position lock to Google
  Calendar's.
- **The red current-time line runs across both panes**, from the drawer into Google Calendar's grid.
- **The drawer is read-only.** It duplicates none of Google Calendar's editing: no drag-to-resize,
  no inline rescheduling, no second event creator. Clicking an event there focuses it in Google
  Calendar. Event creation belongs to Google Calendar's web canvas or the Quick Add shortcut
  ([`quick-add.md`](quick-add.md)).
- **One view of every account**: the work Google Calendar, the personal one and a local Apple or
  iCloud calendar sit together, so a clash between them is visible at once.

The window's native `NSToolbar` ships, with its sidebar toggle (`Cmd+\`); the toolbar is
[`native-ui.md`'s The toolbar](../../docs/shared/native-ui.md#toolbar) and the mode-aware item
sets are
[`google-tasks-ui.md`'s Mode-aware toolbar](google-tasks-ui.md#mode-aware-toolbar).

## Cross-account event transfer

Cross-account moves live in a native context menu on the drawer, not in buttons injected into Google
Calendar's web DOM.

- **Right-clicking an event block or agenda row** selects it and offers `Move to <account>`,
  `Copy to <account>`, `Copy Event Description` and `Export as .ics…`. `Copy Event Description` puts
  the event's title, time, location, video link and description on the clipboard as clean text or
  markdown, and `Export as .ics…` saves it through a native `NSSavePanel`. Both hide when the click
  lands on empty space.
- **Right-clicking an empty slot** offers `New Event at 14:00…`, which pre-fills Google Calendar.
- **The transfer runs through the poller**: `CalendarPoller` POSTs the event into the target
  partition over the authenticated session and deletes the source copy on a move. Nothing on that
  path touches Google Calendar's DOM.

## Docking

The drawer anchors to the right edge by default. Google Calendar's own navigation sits on the left
(hamburger, mini month, calendar list) and its Keep and Tasks drawers on the far right, so a
right-hand dock collides with neither. `Appearance → Sidebar Position` offers `Right`, the default,
or `Left`.

```ts
function updateLayout(
  win: BaseWindow,
  sidebarView: WebContentsView,
  calendarView: WebContentsView,
  visible: boolean,
  position: 'left' | 'right',
) {
  const { width, height } = win.getBounds();
  const TOOLBAR_OFFSET = 52; // Clears native NSToolbar
  const SIDEBAR_WIDTH = visible ? 280 : 0;

  if (!visible) {
    sidebarView.setVisible(false);
    calendarView.setBounds({ x: 0, y: TOOLBAR_OFFSET, width, height: height - TOOLBAR_OFFSET });
    return;
  }

  sidebarView.setVisible(true);
  if (position === 'right') {
    calendarView.setBounds({
      x: 0,
      y: TOOLBAR_OFFSET,
      width: width - SIDEBAR_WIDTH,
      height: height - TOOLBAR_OFFSET,
    });
    sidebarView.setBounds({
      x: width - SIDEBAR_WIDTH,
      y: TOOLBAR_OFFSET,
      width: SIDEBAR_WIDTH,
      height: height - TOOLBAR_OFFSET,
    });
  } else {
    sidebarView.setBounds({
      x: 0,
      y: TOOLBAR_OFFSET,
      width: SIDEBAR_WIDTH,
      height: height - TOOLBAR_OFFSET,
    });
    calendarView.setBounds({
      x: SIDEBAR_WIDTH,
      y: TOOLBAR_OFFSET,
      width: width - SIDEBAR_WIDTH,
      height: height - TOOLBAR_OFFSET,
    });
  }
}
```

## Week and 4-day views

Seven columns do not fit a narrow drawer, so the week view pairs a top day selector with one aligned
timeline.

- **Top day selector**, pinned level with Google Calendar's date headers: seven segments in Week mode
  and four in 4-Day mode, with a high-contrast active pill, a multi-colour source dot under each day,
  and `1`–`7` (or `[` / `]`) to jump days.
- **Aligned all-day band** beneath it, matching Google Calendar's all-day band height.
- **Vertical time grid in lockstep**: the same hour height (`--hour-height: 48px`), bidirectional
  vertical scroll, and the live red time line spanning both panes.

### Hover scrubbing

Hover, because a click already means something. In Google Calendar a click on an empty slot creates
an event and a click on an event opens its details, so the drawer previews a day with a passive
`mousemove` listener that interferes with neither. Moving the cursor over Friday lights the `[ F 11 ]`
pill and cross-fades the timeline to Friday, while the scroll and hour position stay locked, so 2 PM
on every day of the week reads without scrolling. Clicking a day pill pins that day.

## Month view

The month view uses the same components as the menu bar popover.

- **Mini-month grid**: month and year with `< >` navigation, a 7×5 or 7×6 day matrix, and
  multi-colour source dots under each day showing event density across every account. A dot takes
  the calendar's colour or the event's own `colorId` tint, so the drawer matches Google Calendar.
  The selected day carries a solid pill.
- **Day agenda**: the selected date, a hero card for the next meeting with a one-click
  `[ Join Call ]` for Meet, Zoom or Teams, then the day's events in order with source-coloured pills,
  times, location and calendar badges.
- **Footer**: a calendar-source filter and a settings shortcut.

Clicking a day in the mini-month jumps Google Calendar to it. Clicking a day in Google Calendar's
35-day grid selects it here and updates the agenda.

## Day view

Day view makes the drawer an adjacent companion column.

Google Calendar renders one account while the drawer renders another or a combined overlay. Both
share one vertical ruler, so a personal appointment at 13:00 overlapping a work call reads as an
overlap without switching account. The hour gutter, the red current-time line and the bidirectional
scroll stay in lockstep. All-day and multi-day events pin to a header row above the 0:00–24:00 ruler,
keeping the hourly timeline aligned 1:1 with Google Calendar's grid. The drawer is an internal
`WebContentsView` docked in Magical's primary `BaseWindow`, never a detached window, so it holds
across monitors, display scaling, Spaces and native fullscreen (`Cmd+Ctrl+F`). `Cmd+\` collapses it.

## Schedule view

Line-for-line alignment cannot work here. Google Calendar collapses all empty time to 0px, so empty
hours and days take no height and row heights vary with title length. The accounts diverge as well:
viewing Work, Work may have an empty Wednesday afternoon where Personal has an event. The drawer
synchronises by date instead:

1. An `IntersectionObserver` on Google Calendar's date headers (`Wednesday, September 16`) makes the
   header pinned to the top the active date anchor.
2. The drawer renders a unified multi-account agenda and scrolls to the matching date, with Personal
   and Apple events filling the gaps where Work has none.
3. Clicking a date in the agenda calls `scrollIntoView()` on Google Calendar's matching section.

## Year view

The drawer keeps its standard width in Year view. Collapsing and resizing it makes the window and
its content jump. It shows a placeholder:

> **Year View**
> _Select a date or switch to Day, Week, or Month view to inspect events._

Clicking a date in Google Calendar's 12-month matrix navigates to Day or Week view and brings the
timeline back.

## Reading Google Calendar without scraping it

The drawer never reads minified class names. Week view resolves the hovered day by arithmetic and
Month view by ARIA:

```ts
// apps/magical/src/preload/gcal-observer.ts
const weekGrid = document.querySelector('[role="grid"]');
const gridRect = weekGrid.getBoundingClientRect();
const columnWidth = gridRect.width / 7;

weekGrid.addEventListener(
  'mousemove',
  (e) => {
    const colIndex = Math.floor((e.clientX - gridRect.left) / columnWidth);
    const clampedCol = Math.max(0, Math.min(6, colIndex));

    const hoveredDate = new Date(baseDate);
    hoveredDate.setDate(baseDate.getDate() + clampedCol);

    ipcRenderer.send('gcal:day-hover', hoveredDate.toISOString().slice(0, 10));
  },
  { passive: true },
);
```

```ts
monthGrid.addEventListener(
  'mousemove',
  (e) => {
    const cell = (e.target as HTMLElement).closest('[role="gridcell"]');
    if (!cell) return;
    const label = cell.getAttribute('aria-label'); // "Saturday, September 12, 2026"
    if (label) {
      ipcRenderer.send('gcal:month-cell-hover', parseAriaDate(label));
    }
  },
  { passive: true },
);
```

Vertical scroll uses a programmatic-scroll flag, or each pane scrolls the other forever:

```ts
let isProgrammaticScroll = false;

// When Google Calendar scrolls:
scrollContainer.addEventListener(
  'scroll',
  () => {
    if (isProgrammaticScroll) {
      isProgrammaticScroll = false;
      return;
    }
    ipcRenderer.send('gcal:scroll-y', scrollContainer.scrollTop);
  },
  { passive: true },
);

// When the drawer orders a scroll:
ipcRenderer.on('sidebar:apply-scroll-y', (_event, scrollTop: number) => {
  isProgrammaticScroll = true;
  scrollContainer.scrollTop = scrollTop;
});
```

## Constraints

1. **Semantic DOM access only**: preload scripts use semantic ARIA attributes (`[role="gridcell"]`,
   `[role="grid"]`, `[aria-label]`) and arithmetic coordinates, never minified Google class names.
2. **Passive, debounced listeners**: mouse listeners are registered `{ passive: true }` and debounced
   at 30–50 ms, so hover scrubbing does not jank.
3. **Echo-free lockstep**: vertical scroll synchronisation uses programmatic scroll flags.
4. **Read-only**: never mount event-editing popovers, drag-to-resize listeners or forms duplicating
   Google Calendar's creation; a drawer action focuses or navigates to the event in Google Calendar.

## Workspace features waiting on the drawer

The wire format already carries these; the drawer is where they would be drawn, and the colour work
also needs the settings surface. [`calendar-wire-format.md`](../../docs/magical/calendar-wire-format.md)
says what the payload carries and which field holds the colour itself.

- **Out of Office**: diagonal striping and an auto-decline badge.
- **Focus Time**: the headphone or focus badge.
- **Working Locations**: a "Working from home" or "Office" pill for each day.
- **Event colour**: an event inherits its calendar's colour unless `colorId` overrides it with one of
  Google's eleven event tints. The drawer draws both; the resolution it paints by is
  [`menu-bar.md`'s Event colours](../../docs/magical/menu-bar.md#event-colours).
  Settings offers Google Calendar's 24-swatch calendar palette as presets beside the standard macOS
  colour picker.

## Sharing presentation with the menu bar popover

The drawer and the popover share `MiniMonthGrid` (the 7×5 matrix with density dots), `AgendaList` (a
day's events with conference pills and RSVP status) and `useCalendarStore`, the single store
`CalendarPoller` hydrates. The drawer draws them in Electron beside Google Calendar's
`WebContentsView`, and the popover draws them in SwiftUI in the Swift helper
([`menu-bar.md`'s Where it runs, and how big it is](../../docs/magical/menu-bar.md#where-it-runs-and-how-big-it-is)),
so the two cannot show different things. The popover's grid and agenda ship
([`Mini-month grid`](../../docs/magical/menu-bar.md#mini-month-grid),
[`Agenda`](../../docs/magical/menu-bar.md#agenda)).
