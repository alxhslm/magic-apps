# Deep links

Magical handles custom URL schemes via `magical://`. The shared protocol registration, cold-start
buffering, and second-instance architecture are documented in
[`../shared/deep-links.md`](../shared/deep-links.md).

A cold launch from one of these links opens the account the link names; without a link the last active
account is restored. See
[`../shared/deep-links.md#cold-launch-account-selection`](../shared/deep-links.md#cold-launch-account-selection).

## Route taxonomy

| Route                 | Parameters                                        | Action performed                                                  |
| :-------------------- | :------------------------------------------------ | :---------------------------------------------------------------- |
| `magical://event`     | `account`, `eid`, `at`, `action`                  | Reveals the event in the calendar or executes an action.          |
| `magical://date`      | `account`, `at`                                   | Opens Google Calendar on the specified date.                      |
| `magical://search`    | `q`, `query`, `account`                           | Runs calendar search query or focuses search in target view.      |
| `magical://quick-add` | `account`, `text`, `dates`, `details`, `location` | Opens the new event composer, prefilled when fields are present.  |
| `magical://tasks`     | `account`                                         | Opens the full-screen Tasks view.                                 |
| `magical://navigate`  | `url`, `account`                                  | Navigates the account's view to an arbitrary Google Calendar URL. |
| `magical://open`      | `account`                                         | Surfaces and focuses the main calendar window.                    |
| `magical://subscribe` | `url`, `account`                                  | Subscribes the account to a `webcal` or `ical` calendar feed.     |
| `magical://import`    | `file`, `account`                                 | Imports a `.ics` calendar file into the account.                  |

### Event routing (`magical://event`)

Reveals a specific event or executes a response/deletion on it:

```text
magical://event?account=work-account&eid=c3RhdHVzX21lZXRpbmc=&at=2026-10-12T10:00:00.000Z&action=reveal
```

- **`eid`**: Google Calendar event identifier.
- **`at`**: ISO 8601 timestamp of the occurrence. Carried because an `eid` names an event but not where
  it sits, and revealing one means routing to its day before the chip exists to click.
- **`action`**: Defaults to `reveal`. Accepts `reveal`, `yes`, `no`, `maybe`, and `delete`.
- **Focus behaviour**: `reveal` raises and focuses the window before clicking the event chip. RSVP actions
  (`yes`, `no`, `maybe`) and `delete` execute silently against the view without focusing the window, matching
  notification triage semantics.
- An unknown action is rejected rather than silently opening the event.

#### Which occurrence the `eid` names

An `eid` names one occurrence, and the grid labels each chip with the occurrence's own id, so a series
id matches no chip.

- **From Google:** the event's `webUrl` already names the occurrence, so it is used as it is.
- **Expanded from a schedule:** the occurrence inherits the `webUrl` of the record it copied, which
  names a different one. The link is rebuilt from its own slot: `<seriesId>_20260918T084000Z` timed,
  `<seriesId>_20260918` all-day.
- **A task's chip id** is not an `eid` and passes through.

Answering, deleting and completing reuse this `eventEid`, so an action and the reveal it came
from address the same occurrence.

### Date fallback (`magical://date`)

Used when an event has no resolvable `eid` or when navigating directly to a calendar day:

```text
magical://date?account=work-account&at=2026-10-12
```

Opens the calendar view on that day. Date links take only `action=reveal`.

### Search (`magical://search`)

Navigates Google Calendar to a search query:

```text
magical://search?q=dentist&account=personal-account
```

- **`q`** or **`query`**: Search terms to execute. Loads `https://calendar.google.com/calendar/r/search?q=<query>`.
- If `q` is empty or omitted, Magical focuses the search input in the active view (or triggers the native
  search action).

### New events and tasks (`magical://quick-add`, `magical://tasks`)

Emitted by WidgetKit widgets, the menu bar popover and cross-app links:

- **`magical://quick-add`**: Opens event creation. With `text`, `dates`, `details`, `location` or `ctz`, it loads Google's add-to-calendar form in the account's view so the editor opens prefilled; without them it prompts the account picker if multiple accounts.
- **`magical://tasks`**: Opens the full-screen Tasks route for the account.
- **`magical://open`**: Raises and focuses the main window.
- **`magical://subscribe`**: Subscribes to an external feed URL (`url` parameter). Also claims incoming `webcal://` and `ical://` URLs, driving Google Calendar's **From URL** pane (`/settings/addbyurl`) in a background view without CDP.
- **`magical://import`**: Imports a local calendar file (`file` or `path` parameter) into an account using Google Calendar's Import pane.

## Outbound links

External links clicked in Google Calendar views, event descriptions and tasks pass through `openExternalUrl`
in `links.ts`. Magical unwraps Google tracking redirectors via `@magimail/core` and opens the result
in the chosen browser and account profile. Meeting links (Zoom and Microsoft Teams) and Todoist tasks
and projects are rewritten to custom URL schemes; see
[`conference-links.md`](conference-links.md) and
[`../shared/third-party-links.md`](../shared/third-party-links.md).

`toTodoistAppUrl` rewrites `app.todoist.com/app/task/<id>` to `todoist://task?id=<id>` and the
project form the same way. `openTodoistLinksInApp` (General, **Open Todoist links in the Todoist
app**) is on by default; off sends those links to the browser and account profile. A missing Todoist
client falls back to the browser through `hasApplicationForUrl`, like a meeting link.
