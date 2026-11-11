# Calendar protocol handlers

Opening a `.ics` file and subscribing to `webcal://` and `ical://` feeds are supported. Import
extensions, sub-calendar selection and queueing an offline import, are
[`ics-import-extensions.md`](ics-import-extensions.md).

## Feed subscriptions

A `webcal://` link is a subscription to a feed, not a file to import, and the difference decides the
implementation. Importing copies events once; subscribing hands Google a URL that Google re-fetches
on its own schedule.

Magical claims the schemes before `whenReady`:

```ts
app.setAsDefaultProtocolClient('webcal');
app.setAsDefaultProtocolClient('ical');
```

Handling one drives Google Calendar's **From URL** pane (`/settings/addbyurl`) in a background view
via plain DOM scripting without CDP, falling back to revealing the pane with the URL pre-populated
if Google requires manual intervention. Subscriptions can also be triggered via `magical://subscribe?url=...`.

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
