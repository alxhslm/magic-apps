# WidgetKit widgets

The extension's process boundary, the App Group snapshot and the timeline reload are the shared
mechanism in [`../shared/widgets.md`](../shared/widgets.md). Magimail's own families and layouts are
below.

## Widget families and layouts

### Unread overview

- **Footprint**: 155 × 155pt, corner radius 22pt.
- **Target surface**: Notification Center and Desktop Widget Stack.
- **Layout**:
  - **Header**: branded Magimail icon and total unread count badge across all accounts.
  - **Account breakdown**: vertical list with account colour dot, account name, and individual
    unread counts (e.g. `Personal: 2`, `Work: 3`), up to three, which is what 155pt has room for
    below the total. Each row deep-links to `magimail://inbox?account=<id>`.
  - **Action**: clicking anywhere else opens the primary unread inbox.

### Quick actions

- **Footprint**: 324 × 155pt, corner radius 24pt.
- **Target surface**: Desktop and Notification Center.
- **Account tiles** (two accounts or fewer): side-by-side card tiles for each account partition:
  - A colour dot before the account name, as in the small and large widgets. It is a dot rather than
    an edge pill because the tile already carries a border, and a second vertical line beside it read
    as a second border rather than an accent.
  - Account name and a 1-tap compose launcher button (`square.and.pencil`) linking to
    `magimail://compose?account=<id>`.
  - Prominent unread count number and unit label.
  - The tile itself deep-links to `magimail://inbox?account=<id>`. The compose button is a nested
    link, and the innermost one under the pointer wins.
- **Account chips** (three or more): 324pt divided three ways leaves the stacked number nowhere to
  sit, so the tile folds onto one line (colour dot, name, unread count, compose button), two chips to
  a row. Nothing is dropped: the count keeps 18pt so it still leads the row, and one-tap compose
  survives because it is what this family exists for. Capped at four, which is two rows.

### Recents

- **Footprint**: 324 × 155pt, corner radius 24pt.
- **Target surface**: Desktop and Notification Center.
- **Header**: brand mark and a quick compose button. The button belongs to no account, so it links to
  a bare `magimail://compose`, which the app answers with the same account picker `mailto:` links
  use. `composeAccountPicker` does not apply: it means "the account you are looking at", and from a
  widget that is none of them.
- **Thread list**: unified inset group of the 3 most recent email threads.
- **Row elements**: leading 3pt account colour pill, sender name, relative date/timestamp, message
  subject/snippet preview, and the Gmail category as an SF Symbol on the trailing edge of the subject
  line, directly under the timestamp. [`menu-bar.md`'s category symbols](menu-bar.md#category-symbols-mapping)
  give the mapping. This extension keeps its own copy in `WidgetCache.swift`, because it shares no
  module with the helper.
- **Unread**: the same treatment the popover gives a row — a filled dot in the account's accent
  colour at the end of the subject line, semibold sender, subject and timestamp at full strength, and
  a faint accent wash over the row. A read thread loses the dot and drops to muted text on the
  group's own fill. The leading pill keeps its full strength either way: in a widget it says which
  account a thread came from, not whether it has been read. The widget draws every thread the
  snapshot carries unless it was set to unread only in Edit Widget — that is its own choice, not the
  popover's.
- **Interactivity**: clicking any row deep-links directly to `magimail://thread/<id>`.

### Inbox dashboard

- **Footprint**: 324 × 324pt, corner radius 26pt.
- **Target surface**: macOS Desktop.
- **Header**: brand title, total unread badge, and a compose button, the same bare
  `magimail://compose` the Recents header uses. The largest widget was otherwise the only one
  offering no way to write anything.
- **Account grid**: the same chips Quick Actions falls back to, two to a row, without the per-account
  compose. Every account appears, because an account at zero is information, and hiding it made the
  widget look like it had lost one. Capped at four.
- **Recent list**: inset group of the latest threads with the same read/unread treatment as Recents,
  and the same trailing category symbol. It shows as many as the chips above leave: five when they
  take one row, four when they take two. Those counts come
  from measuring the real layout. At three accounts, four threads end roughly 28pt clear of the
  bottom at a row pitch of ~38pt, and dropping a chip row returns the 42pt it cost, which is worth
  one more thread and no more. A full list shares that remaining slack between its rows so the group
  reaches the bottom edge; a short one keeps its natural height, since rows of air read worse than the
  gap they replace.
- **Deep links**: each row targets `magimail://thread/<id>`.

The family set itself is fixed by macOS. Widgets cannot host interactive text input (`NSTextField`),
so search stays in the menu bar popover; that is why there is no search widget. `ControlWidget`
quick compose is not built, macOS has no `systemExtraLarge` family, and Lock Screen accessory widgets
are iOS and iPadOS only.

## Which threads a widget shows

**Recents and the dashboard can be set to unread only in Edit Widget, not in Settings.**
`WidgetThreadFilterIntent` is a `WidgetConfigurationIntent` carrying one `Bool` parameter, so
right-clicking either widget and choosing Edit Widget offers an "Unread only" toggle. The choice
belongs to that widget: a Recents widget can show only what still needs an answer while the
dashboard beside it keeps the whole list, and neither has to match the popover's filter. This is
the shape Magical's per-widget calendar picker uses.

The filter is applied in the extension, not in the snapshot: the app writes every thread it has,
because the choice lives in each widget's configuration and only the extension can read that. The
totals, the account chips and the compose button are left alone — only the list is filtered — and a
list taken to empty draws the same "all caught up" state the popover shows, so an unread-only widget
with nothing left does not read as an account that has gone missing.

Unread and Quick Actions draw no list, so they stay `StaticConfiguration` and carry no choice.

## Typography, colour and surfaces

The shared card tokens, the feed-versus-card rule and the brand-mark rule are in
[`../shared/widgets.md`](../shared/widgets.md).

## Build and verification pipeline

An extension is built standalone and then bundled into `Contents/PlugIns/`; the rules, including why
`build-app.sh` refuses to package without it, are in
[`../shared/widgets.md`](../shared/widgets.md).

```bash
cd apps/magimail/widgets
./build.sh release
pnpm --filter magimail run build:widgets
```

`build.sh` stamps the version and the build number before signing, the same way every extension in
the project does.
