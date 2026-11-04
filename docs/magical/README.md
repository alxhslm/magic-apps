# Magical

A native macOS menu bar and desktop client for Google Calendar.

Magical keeps everything Google Workspace Calendar does (Find a Time, room booking, out-of-office
auto-declines, working locations, focus time) and adds Mac ergonomics for power users: a Dock icon
that live-renders today's date, a menu bar tray, a native toolbar, desktop widgets and macOS Focus
Filters.

It shares [`@magimail/core`](../../packages/core) with Magimail for session partition isolation, a
consistent browser identity, theming, and window configuration; it is the same foundation pointed at
Google Calendar instead of Gmail.

## What's in this folder

| Document                                             | Covers                                                                          |
| :--------------------------------------------------- | :------------------------------------------------------------------------------ |
| [`overview.md`](overview.md)                         | System overview, window, lazy accounts, toolbar and decoder                     |
| [`actions.md`](actions.md)                           | Acting on an event, an invitation or a task: the action set, tray RPC and links |
| [`dock-icon.md`](dock-icon.md)                       | Dock tile: Core Graphics date drawing, midnight rollover and the badge          |
| [`rsvp.md`](rsvp.md)                                 | Invitations awaiting a reply: the outstanding set, the badge and the dropdown   |
| [`calendar-sync.md`](calendar-sync.md)               | Session cookie poller, polling loop and account suspension                      |
| [`calendar-wire-format.md`](calendar-wire-format.md) | The raw payload, the decoder and the measured indices                           |
| [`google-tasks.md`](google-tasks.md)                 | The Tasks poller, its wire protocol and completion state                        |
| [`notifications.md`](notifications.md)               | Meeting alerts, invitation watching and banners                                 |
| [`menu-bar.md`](menu-bar.md)                         | Status item title, search field, mini-month grid, hero band and agenda          |
| [`sidebar.md`](sidebar.md)                           | Native companion sidebar: layout, animated folding, and adaptive view modes     |
| [`conference-links.md`](conference-links.md)         | Resolving a meeting URL, native schemes and the join controls                   |
| [`widgets.md`](widgets.md)                           | The six widgets, the App Group snapshot, the calendar picker, links and build   |
| [`deep-links.md`](deep-links.md)                     | `magical://` route taxonomy, event reveal, actions and search                   |
| [`ics-import.md`](ics-import.md)                     | `open-file` queueing, the account picker, Google's pane and the default claim   |
| [`focus-filters.md`](focus-filters.md)               | What a Focus silences, the App Intents extension and how it reaches the app     |

Unbuilt work is specified in [`../../specs/magical/`](../../specs/magical/).
