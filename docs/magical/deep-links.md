# Deep links

Magical handles custom URL schemes via `magical://`. The shared protocol registration, cold-start
buffering, and second-instance architecture are documented in
[`../shared/deep-links.md`](../shared/deep-links.md).

A cold launch from one of these links opens the account the link names; without a link the last active
account is restored. See
[`../shared/deep-links.md#cold-launch-account-selection`](../shared/deep-links.md#cold-launch-account-selection).

## Route taxonomy

| Route                 | Parameters                       | Action performed                                             |
| :-------------------- | :------------------------------- | :----------------------------------------------------------- |
| `magical://event`     | `account`, `eid`, `at`, `action` | Reveals the event in the calendar or executes an action.     |
| `magical://date`      | `account`, `at`                  | Opens Google Calendar on the specified date.                 |
| `magical://search`    | `q`, `query`, `account`          | Runs calendar search query or focuses search in target view. |
| `magical://quick-add` | _None_                           | Prompts the new event composer.                              |
| `magical://open`      | _None_                           | Surfaces and focuses the main calendar window.               |

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

An `eid` names one occurrence, not the series it belongs to. Google's grid labels each chip with the
occurrence's own id, so a link carrying a series id routes to the right day and then matches no chip,
opening nothing. `buildEventLink` is what spells the occurrence out.

An occurrence the wire returned already carries its own `eid`, and that is used as it is. An
occurrence this app expanded from the series' own schedule inherits the `webUrl` of the record it
copied its fields from, which is the series' newest materialised instance or the master when none is
placed, so that `eid` names a different occurrence entirely. For those the link is rebuilt as the
series id, the occurrence's slot in UTC, and the calendar id: `<seriesId>_20260918T084000Z` for a timed
occurrence and `<seriesId>_20260918` for an all-day one. An occurrence whose inherited `eid` was
already right rebuilds to the same bytes. This is the common case for the menu bar and for banners,
because the event being revealed is usually a recurring meeting.

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

### Widget shortcuts (`magical://quick-add`, `magical://open`)

Emitted by WidgetKit widgets and the menu bar popover:

- **`magical://quick-add`**: Prompts the account picker (if multiple accounts) and opens event creation.
- **`magical://open`**: Raises and focuses the main window.

## Outbound links

External links clicked in Google Calendar views, event descriptions and tasks pass through `openExternalUrl`
in `links.ts`. Magical unwraps Google tracking redirectors via `@magimail/core`, routing recognised
destinations to native desktop applications (such as Todoist, Notion, Linear, Figma, and Slack) via
macOS Universal Links. See [`../shared/third-party-links.md`](../shared/third-party-links.md). Meeting
links (Zoom and Microsoft Teams) are rewritten to custom URL schemes; see
[`conference-links.md`](conference-links.md).
