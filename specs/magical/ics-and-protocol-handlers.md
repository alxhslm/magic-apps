# Calendar protocol handlers

Opening a `.ics` file works today, and so does becoming the app macOS opens them with. Subscribing to
a feed does not. Import extensions, sub-calendar selection and queueing an offline import, are
[`ics-import-extensions.md`](ics-import-extensions.md).

## Feed subscriptions

A `webcal://` link is a subscription to a feed, not a file to import, and the difference decides the
implementation. Importing copies events once; subscribing hands Google a URL that Google re-fetches
on its own schedule. Importing a feed produces a snapshot that silently goes stale.

Claiming the schemes is one line each, registered before `whenReady` beside the existing `magical`
registration:

```ts
app.setAsDefaultProtocolClient('webcal');
app.setAsDefaultProtocolClient('ical');
```

Handling one means driving Google Calendar's **From URL** pane, a sibling of the Import pane already
driven in
[`ics-import.md`'s Import pane](../../docs/magical/ics-import.md#import-pane),
rather than its file input. The account picker and the hidden-view mechanism carry over unchanged;
only the control being worked and the confirmation being read differ, and both need reading off the
live page before anything is written against them.

## Deep links `magical://` does not carry yet

`event-links.ts` builds and parses `magical://event` and `magical://date`, which is what notification
banners need. The rest of the scheme is unbuilt:

| Deep link                           | Action                                              | Google Calendar route                       |
| :---------------------------------- | :-------------------------------------------------- | :------------------------------------------ |
| `magical://day/2026/09/18`          | Navigates to a specific day in Day view             | `/calendar/u/0/r/day/2026/9/18`             |
| `magical://week/2026/09/18`         | Navigates to the week containing that date          | `/calendar/u/0/r/week/2026/9/18`            |
| `magical://month/2026/09`           | Navigates to Month view                             | `/calendar/u/0/r/month/2026/9/1`            |
| `magical://today`                   | Jumps to the current day in the active view         | Focuses Today                               |
| `magical://quick-add?text=<str>`    | Opens the Quick Add HUD with text prefilled         | Dispatches the string to `chrono-node`      |
| `magical://share?url=<u>&title=<t>` | Opens Quick Add with a page title and link attached | Pre-populates title and attaches a URL note |
| `magical://join-call?id=<event_id>` | Joins Meet, Zoom or Teams without opening a window  | Extracts the video link and launches it     |

`quick-add` and `share` depend on [`quick-add.md`](quick-add.md);
`join-call` depends on
[`conference-links.md`](../../docs/magical/conference-links.md). Build the HUD before the links that
open it.

Route by `url.hostname`, as `parseEventLink` does. `new URL('magical://day/...')` parses `day` as the
host and not as the path, which is the trap in reading these by pathname.
