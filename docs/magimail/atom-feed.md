# Gmail Atom feed

Magimail reads unread counts and message snippets from Gmail's authenticated Atom XML feed over each
account's own session. This page covers the feed and the poller; what happens once an unread arrives
is in [`notifications.md`](notifications.md).

## Why the Atom feed

Magimail polls the Gmail Atom feed (`https://mail.google.com/mail/feed/atom`) from the Electron main
process, using each account's isolated partition session (`persist:magimail_<accountId>`). Background
sync then needs nothing outside the app: no OAuth client, no app password, no external service. The
project holds no OAuth client anywhere, which the Gmail API and IMAP IDLE would both require, and
which is the constraint that settles the choice; see
[`../shared/sessions-and-security.md`](../shared/sessions-and-security.md#why-neither-app-holds-an-oauth-client).

## Feed mechanics

### Endpoint and authentication

- **Default feed URL**: `https://mail.google.com/mail/feed/atom`
- **Label and category feeds**:
  - All unread: `https://mail.google.com/mail/feed/atom/unread`
  - Important unread: `https://mail.google.com/mail/feed/atom/important`
  - Primary category: `https://mail.google.com/mail/feed/atom/primary`

Electron's session-scoped `ses.fetch` sends the partition's own cookies, so the request
authenticates itself and there is no token to hold:

```ts
import { session } from 'electron';

export async function fetchAtomFeed(accountId: string, category = ''): Promise<string> {
  const ses = session.fromPartition(`persist:magimail_${accountId}`);
  const url = category
    ? `https://mail.google.com/mail/feed/atom/${category}`
    : 'https://mail.google.com/mail/feed/atom';

  // ses.fetch, not net.fetch: the session *is* the receiver, which is what
  // carries the partition's cookie jar.
  const response = await ses.fetch(url, {
    // The same identity the views present, so the feed is not a second browser
    // (see ../shared/sessions-and-security.md).
    headers: { 'User-Agent': DEFAULT_CLEAN_USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`Atom feed HTTP ${response.status}`);
  }

  return response.text();
}
```

### Payload structure

Gmail returns an XML document:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <title>Gmail - Inbox for user@example.com</title>
  <tagline>New messages in your Gmail inbox</tagline>
  <fullcount>4</fullcount>
  <link rel="alternate" href="https://mail.google.com/mail" type="text/html"/>
  <modified>2026-09-05T11:40:00Z</modified>
  <entry>
    <title>Q3 Strategy Planning &amp; Deck</title>
    <summary>Hey team, please review the attached slides before our sync tomorrow...</summary>
    <link rel="alternate" href="https://mail.google.com/mail?account_id=...&amp;message_id=..." type="text/html"/>
    <modified>2026-09-05T11:39:12Z</modified>
    <issued>2026-09-05T11:39:12Z</issued>
    <id>tag:gmail.google.com,2004:1800000000001</id>
    <author>
      <name>Sarah Connor</name>
      <email>sarah@cyberdyne.com</email>
    </author>
  </entry>
</feed>
```

## Polling

### Intervals and power awareness

- **On mains power**: `pollIntervalSeconds` in settings sets the interval, and defaults to 60
  seconds.
- **On battery**: `pollIntervalBatterySeconds` in settings sets the interval, and defaults to 180
  seconds. `powerMonitor.isOnBatteryPower()` decides which of the two applies.
- **Hidden categories, window in front**: `getEffectiveInterval()` drops to 5s (10s on battery) when
  the window is focused and an active category is missing from the sidebar, so triage in that
  category still shows up quickly. Blurred, minimised, or with every active category in the sidebar,
  it uses the configured background interval.
- **Sleep and resume**: the loop pauses on `powerMonitor.on('suspend')` and fetches immediately on
  `powerMonitor.on('resume')`.

### Sidebar observer and dual-source counts

Unread counts come from two sources: Gmail's own sidebar while the window is in front, and the Atom
feed the rest of the time.

1. **Foreground, real-time scalar badge.** A scoped `MutationObserver` in `apps/magimail/src/preload.ts`
   watches Gmail's left navigation sidebar (`div[role="navigation"]`) while the Gmail window is
   visible and active. It reads the numbers off child badge elements or ARIA labels for `#inbox` and
   `#category/...` (`updates`, `promotions`, `social`, `forums`), so triage updates the badge
   synchronously, with no network request. It dispatches `IPC_CHANNELS.DOM_UNREAD_UPDATE` with the
   category counts it found, `presentCategories`, `hasCategoriesSection` and `isLoaded`.
2. **Category counts and offline cache.** When offline mail is enabled in Gmail settings
   (`#settings/offline`), Gmail synchronises an IndexedDB cache (`_xdb`). Category unread counts are
   sourced directly from this cache, which counts true unread messages in the inbox (`^i` + `^u`),
   excluding archived mail. When offline mail is disabled (the default for Gmail accounts), Magimail
   shows an in-app banner prompting the user to enable offline mail, and automatically falls back to
   Atom category sub-feeds (`^smartlabel_*`) for category counts and root feed entries for tray and
   widget previews.
3. **Background counts, snippets and fallback.** The Atom feed is the authority for message
   snippets (`subject`, `summary`, `author`), which the menu bar popover and the widgets display, and
   for unread counts while the window is minimised or the machine is asleep. Standard label paths
   (e.g. `/mail/feed/atom/promotions`) map to custom user labels in Gmail and return
   `<fullcount>0</fullcount>`, so category feeds use Gmail's internal system smartlabels instead:
   - Promotions: `^smartlabel_promo` (`/mail/feed/atom/%5Esmartlabel_promo`)
   - Social: `^smartlabel_social` (`/mail/feed/atom/%5Esmartlabel_social`)
   - Updates: `^smartlabel_notification` (`/mail/feed/atom/%5Esmartlabel_notification`)
   - Forums: `^smartlabel_group` (`/mail/feed/atom/%5Esmartlabel_group`)
   - Primary: `^smartlabel_personal` (`/mail/feed/atom/%5Esmartlabel_personal`)

   When categories are folded away or hidden under "More labels", or when the local cache is absent,
   `AccountsManager` marks them `absentCategories` and pulls their counts from the accelerated 5s
   in-focus poller. The count is the same either way; putting a category back in the sidebar only
   moves its updates from the 5-second poll to the synchronous DOM observer.

   **Folding keeps the rows visible in the DOM.** Gmail's fold deletes the category rows, and those
   rows are where the sidebar observer reads its counts. The preload swallows the click on the fold
   control and hides the rows in CSS instead, so the rows stay in the DOM and a folded section counts
   as fast as an open one. Gmail never records the fold, so the state is Magimail's, kept per account
   partition in `localStorage`. Where this does not engage (a sidebar Gmail lays out differently, or
   a non-English UI, since the control has no role or label and is found by position), Gmail folds as
   it always did and the last known count below covers the number.

   **Last known count per category.** `AccountsManager` keeps the last number it saw for each of the
   five categories, whichever source reported it, and falls back to that rather than to zero. Neither
   source covers all five on its own: the sidebar drops a category the instant it is folded away, and
   the poller fetches a sub-feed only when it has to. Without the remembered number, folding
   Categories would count every row inside it as zero until the first sub-poll came back, and the
   badge would drop to the Primary count and climb again seconds later.

   **Anti-bounce rule.** A completed Atom poll leaves the DOM counts for the categories present in
   the sidebar alone, so a stale edge-cached Atom response cannot overwrite what triage has just
   changed.

### Decoupled from the views

The underlying `WebContentsView` can be suspended or unloaded from RAM entirely, because requests go
through the partition session with `ses.fetch()` rather than through the view. Notifications and
badge counts keep updating while it is gone.

### Recent messages

The feed lists only unread mail, which is the only signal a poll has that a thread was dealt with —
and it cannot tell a thread that was read from one that was archived or deleted. When Gmail's offline
mail is enabled, the menu bar and the widget read Gmail's own `_xdb` IndexedDB cache in the account's
renderer: `gmail-cache-reader.ts` decodes the cached thread protobuf and returns the newest Inbox
rows with their real read state, labels and category. A deleted thread leaves the popover as soon as
Gmail's data worker drops it, and a restart paints from data already on disk.

When offline mail is disabled or the cache database has not yet been created, the menu bar and
widgets fall back to the newest entries from the Atom feed. An account whose view is not ready answers
with an empty list, and the menu bar fills in on the next pull.

### What a failed poll reports

A poll has three outcomes and `AtomPollResult.status` names which one, because two of them are
indistinguishable from good news if you only look at the number.

| `status`        | Cause                                                      | What changes                                                      |
| --------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `ok`            | A feed parsed                                              | Count, notifications, `needsAuth` and `restricted` cleared        |
| `auth_required` | HTTP 401, or a 200 that is not a feed or policy page       | `needsAuth` raised on the account; count held                     |
| `restricted`    | HTTP 403, or a 200 HTML page naming an administrator block | The popover draws its policy banner; count held, no sign-in offer |
| `network_error` | Any other HTTP status, or `fetch` itself threw             | Nothing on the account; the tray is told it is offline            |

**A missing `<fullcount>` is not a count of zero.** Gmail answers an expired session with a sign-in
page served as HTTP 200, so `parseAtomXml` returns `fullCount: null` when the tag is absent, and the
poller reads that as "this response is not a feed" rather than as a number.

**Incomplete arrivals and unresolvable message IDs.** When an Atom entry cannot yield a message ID
(for example, if the `<id>` or `<link>` tags drift or fail to parse), the poller logs a warning
omitting private mail content to maintain log redaction invariants, and flags `arrivalsIncomplete: true`
on `AtomPollResult`. Callers can identify that the arrival batch is partial rather than silently
dropping incoming messages into a void.

**Every failure path replays the last good count.** The count is state; a poll that failed is an
absence of news, not news that the mail has gone. Reporting `0` on a dropped connection would empty
the badge and the widgets on every flaky network. `lastReportedUnread` is what a failed poll
re-sends.

The one place a missing count is still coerced to `0` is `fetchCategoryCounts`, which subtracts
off-category mail from the total: a sub-feed that failed should subtract nothing, and the total it is
subtracted from has already been validated.

`auth_required` is what raises `needsAuth`, which surfaces in three places (the toolbar segment's
warning symbol, the tray popover's sign-in banner, and the Settings account row's Sign In button), all
of which route back to `switchAccount()` so the user lands on the Gmail login for that partition.

`restricted` is the tenant refusing to serve Gmail's Atom feed, generally through an administrator
policy. It is not `auth_required`, because the credentials are valid and signing in again will not
help, and it is not `network_error`, because the network is fine and calling it offline sends the
user after the wrong problem. The tray draws a dedicated banner with no button. A `403` is treated as
this state, and a `200` HTML page is read as a policy block when its wording names an administrator
block; no live tenant has yet produced one, so the exact response shape remains provisional.
