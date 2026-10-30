# Magimail

A native macOS desktop client for Gmail. Gmail itself runs in an isolated Chromium partition per
account; the surfaces around it are native: an AppKit `NSToolbar`, a SwiftUI settings window and menu
bar popover, `UNUserNotificationCenter` banners, a Share Sheet in both directions, and WidgetKit
widgets.

Magimail signs in with the existing web session cookies, so it holds no Google Cloud project, no
OAuth scope and no CASA audit. Unread counts come from the mailbox source, which reads Gmail's
authenticated Atom feed and local cache rather than an API.

## What's in this folder

| Document                                               | Covers                                                                    |
| :----------------------------------------------------- | :------------------------------------------------------------------------ |
| [`overview.md`](overview.md)                           | The tree, window architecture, sessions and styling                       |
| [`process-model-and-ipc.md`](process-model-and-ipc.md) | Magimail's channels on top of the shared process model                    |
| [`unread-counts.md`](unread-counts.md)                 | The unread count, its inputs, and how the badge total is composed         |
| [`notifications.md`](notifications.md)                 | Notification dispatch, categories, and the dock badge                     |
| [`actions.md`](actions.md)                             | Acting on a message or thread, the two dispatch paths, and read state     |
| [`widgets.md`](widgets.md)                             | WidgetKit families, the snapshot cache, and the timeline reloader         |
| [`dark-mode.md`](dark-mode.md)                         | The page-invert filter and every selector it exempts                      |
| [`menu-bar.md`](menu-bar.md)                           | Menu bar glyph, SwiftUI popover, and list aging                           |
| [`share-and-handlers.md`](share-and-handlers.md)       | Inbound Share Sheet, synthesised drag, PDF export, and `mailto:` handling |
| [`deep-links.md`](deep-links.md)                       | `magimail://` route taxonomy, thread triage, search and parameters        |
| [`focus-filters.md`](focus-filters.md)                 | App Intents Focus Filters, account suppression, and dimming               |
| [`quick-compose.md`](quick-compose.md)                 | Global ⌥⌘C shortcut, detached compose window, and account picker          |
