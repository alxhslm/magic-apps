# Adaptive sidebar

The companion drawer ships. [`docs/magical/sidebar.md`](../../docs/magical/sidebar.md) owns how it
works today: the view modes, the bounded range, the scroll and highlight behaviour, and the shared
event card.

This file keeps only what is still unbuilt: moving an event between accounts from the drawer, and
docking it to the left edge. Everything else the original spec described has graduated into the doc
above.

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

The drawer anchors to the right edge today. Google Calendar's own navigation sits on the left
(hamburger, mini month, calendar list) and its Keep and Tasks drawers on the far right, so a
right-hand dock collides with neither. Docking to the left would be a window-layout change, not a
new view: `window-layout.ts` and `SidebarBridge` already take the sidebar width from one constant
(340pt), and the AppKit host pins to the trailing edge. A left dock needs the calendar view's `x`
and the host's leading constraint to move together.

When both sections above ship, delete this file.
