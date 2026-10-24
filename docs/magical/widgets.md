# Widgets

Seeing what is next needs Magical open, or a click on its menu bar item. These widgets answer the
same question on the desktop without either.

## Six widgets, three questions

**Each widget answers one question, and the size changes how much of the answer fits rather than what
the answer is.** Six entries across three questions cost the reader one decision instead of two: pick
the question, then pick how much room to give it.

| Widget      | Families      | The question it answers         |
| :---------- | :------------ | :------------------------------ |
| **Up next** | Small, medium | What is now, and can I join it? |
| **Agenda**  | Medium, large | What is left of my day?         |
| **Month**   | Medium, large | Where am I in the month?        |

Each is one `AppIntentConfiguration` declaring both of its families, not one widget per family.
Magimail declares a single family per widget because Unread, Quick Actions, Recents and Inbox
Dashboard are four different questions that each suit one size; Up next at small and at medium is one
question at two densities. The configuration is what puts the calendar picker in Edit Widget; [Which
calendars a widget shows](#which-calendars-a-widget-shows) has it.

Every widget opens with the same header, laid out as Magimail's is: the brand mark and the app's name
together on the leading edge, the month on the trailing edge, then Quick Add
([Quick Add, Join, and opening an event](#quick-add-join-and-opening-an-event)). The mark never sits
directly beside the date or the month, where it reads as an icon for that content rather than as the
app it belongs to. The small family carries the name and no month; there is room for one of them.

### Up next

The tile itself is the hero. A countdown pill leads, then the event's title against its calendar's
colour bar, the time, the conference service and a Join button.

The countdown pill is one colour for its fill and its text: green while the meeting is running,
secondary before it starts, because a meeting three hours out in the same green reads as something to
drop everything for. This is the hero band's rule from [`menu-bar.md`'s Hero band](menu-bar.md#hero-band),
and the Join button is the same verb alone; the service belongs in the metadata line beside the time.

Medium keeps that hero on the left and puts what follows it today down the right, as compact cards
with a start time. The hero is the next meeting in the snapshot, not the next one today, so a Sunday
evening shows Monday's first meeting rather than an empty tile.

**All-day entries and completed tasks never become the hero, but all-day entries are still shown.** A
countdown to something filling the whole day says nothing about when to stop what you are doing, so
`nextEvent` skips all-day entries and completed tasks. With nothing timed left, the date becomes the
subject at the size the hero had, and today's all-day entries sit under it as cards, so a birthday
still fills the tile.

### Agenda

The day number and its weekday sit in a left gutter, and the day's events stack beside it as cards.
Medium holds two and picks up a `TOMORROW` eyebrow once today runs out; large runs to three days, with
room on each card for the time and the conference service under the title.

**An all-day entry is filed on the date it starts**, the same rule as the popover's agenda, so a
holiday running since the 17th keeps its own `THURSDAY 17` heading while it is still on rather than
being pulled onto today; anything finished has dropped out, and a timed entry that began before today
and has not ended is shown under today.

The day column is the gutter the popover's agenda uses, not a full-width pinned header. A header
costs a row of height per day and takes the date out of the line the cards are read on.

### Month

The mini-month grid, with up to four dots under each day, one per distinct calendar with something on
it. Medium puts the grid on the left and today's events down the right; large runs the grid full width
with the day underneath.

Dots are calendar colours and they stop at four, so a day with nine calendars on it still reads as
busy rather than as a smear. **An event marks every day it covers**, not only the day it starts. Today
is a solid blue disc with white numerals. Weeks start on Monday whatever the locale says, which is
what the popover's grid does.

A widget cannot select a day, so the selection the popover tracks does not exist here: the day shown
beside the grid is always today. Each day cell is a `Link` of its own, so clicking the 23rd opens
Magical on the 23rd rather than wherever the widget as a whole points.

**That day is a view of today's date, not of the agenda's first day.** The panel leads with every
all-day entry whose covered range includes today, then today's timed entries, so a still-running
holiday shows under `TODAY` even though the agenda files it on its own earlier date; a one-day entry
on today is in both and appears once.

## How an event is drawn

The shared card rule and the typography, colour and surface tokens are in
[`../shared/widgets.md`](../shared/widgets.md). Magical draws a day as a set of cards rather than a
feed, and the accent bar is the calendar's colour.

A conference link shows as `video.fill` and the service's name, never the service's own mark, because
a brand logo in full colour outranks the title. Tasks show a `circle` glyph when open, and
`checkmark.circle` when completed; completed tasks draw their title in `.secondary` and reduce card
opacity to `0.6`.

**A card is as tall as its two lines, and a medium family shows two of them.** `AccentBar` is an
overlay rather than a view in the stack: `Color` is greedy on both axes, so a `Color.clear` bounded
only in width swallows every spare point its row is offered. With that fixed, 155pt holds a header and
two cards; a third is drawn with its second line through the bottom edge, which reads as a rendering
fault rather than as a list that continues.

## Brand mark

The brand mark is compiled into the extension by reference, and the box it uses is the status item's;
the rule and the glyph grid are in [`../shared/widgets.md`](../shared/widgets.md) and
[`../shared/brand-and-icons.md`](../shared/brand-and-icons.md).

## Quick Add, Join, and opening an event

**Every button is a `Link`. The extension declares no App Intents at all**, which is what Magimail's
does too.

The Join destination is the conference URL, and Magical is not the registered handler for `https`,
`zoommtg` or `msteams`, so the app that comes forward is Zoom, Teams or the browser, which is the
whole requirement. An `AppIntents`-based intent would give the same behaviour at the cost of linking
`AppIntents` into an `APPLICATION_EXTENSION_API_ONLY` target and finding a way to open a URL from
inside an app extension, where `NSWorkspace` is unavailable.

The snapshot carries the launch URL already converted by `toNativeMeetingUrl` rather than the raw
meeting link, because the extension cannot reach `calendar-service.ts` to convert it.

Join is drawn as the hero band draws it, `Label("Join", systemImage: "video.fill")` in a filled
rounded rect, so the glyph leads the verb. **Only the hero carries one.** The popover puts a Join on
an agenda row too, but only while the pointer is over it, and a widget has no hover.

**Quick Add is `magical://quick-add`**, and it draws `calendar.badge.plus`, unfilled, which is the
icon and the presentation the popover's header already uses. A bare `+` names an action that could add
anything, and a widget header has no other label to say what.

**A card opens the event.** `menubar-manager.ts` builds the tray payload where the raw event still
carries its `eid`, so each event reaches the snapshot with `buildEventLink`'s answer already on it:
`magical://event?account=…&eid=…&at=…` where Google named the event, and `magical://date?account=…`
where it did not. A day cell in the grid uses the second shape with the snapshot's `activeAccountId`,
because a day belongs to no account and `magical://date` needs one.

`magical://quick-add` and `magical://open` name no event and carry no account, so `parseEventLink`
refuses them by design. `main.ts` answers both in `handleWidgetLink` before the link reaches
`openDeepLink`.

## App Group container and the snapshot

The App Group container, its resolution and the atomic snapshot write are the shared mechanism in
[`../shared/widgets.md`](../shared/widgets.md).

## Which calendars a widget shows

**A widget's calendars are chosen in Edit Widget, not in Settings.** `CalendarSelectionIntent` is a
`WidgetConfigurationIntent` carrying one parameter, so right-clicking a widget and choosing Edit
Widget offers every calendar the accounts hold, each with its own colour. The choice belongs to that
widget: two Agenda widgets can carry different calendars, and neither has to carry what the menu bar
popover carries. A widget is glanceable and the popover is where the whole day is checked, so a
calendar worth keeping out of one is often worth keeping in the other.

**A new widget starts with the calendars the popover shows.** `init()` seeds the parameter from the
snapshot minus the popover's hidden set, because the picker renders whatever the parameter holds: an
empty parameter offers a list with nothing ticked while the widget draws a full day. Seeding from the
popover rather than from every calendar keeps a calendar switched off there from reappearing the
moment a widget is added. The tie is a starting point and not a subscription, so a widget keeps the
list it was given and later changes to the popover's filter leave it alone.

**An empty list means an empty widget.** There is no second empty answer standing for never asked,
because `init()` always seeds one.

`WidgetCalendarQuery` builds the list from the snapshot, which is the only thing about Magical this
extension can see. A row is identified by its account and its calendar joined by a `|`, as the Focus
filter's picker identifies one: a Google calendar id does not name a calendar on its own, since
Birthdays, Tasks and each locale's holidays carry the same id in every account. `CalendarDot` draws
the colour swatch, and lives in `app-intents-extension/Sources/` because both pickers compile it.

**A choice is stored as what to show and applied as what to hide.** An account's own view names
calendars the picker never offered, and a calendar nobody could tick must not disappear for want of a
tick; the popover's filter leaves those alone for the same reason. An event goes only when every
calendar holding it is hidden, which is again the popover's rule.

**Focus silencing is composed with the per-widget choice in `WidgetCache.showing(_:)`.** The method
unions the per-widget hidden set with `silencedCalendars` from the snapshot before filtering events
and density dots. A calendar the widget has unticked and a calendar silenced by Focus are both taken
out at the same step; neither overrides the other. When `isFocusActive` is true, at least one calendar
is silenced, and the post-filter event list is empty while the pre-filter list was not, `showing(_:)`
sets `isSilencedByFocus = true` on the returned cache. Views read that flag to show "Silenced by
Focus" rather than "Nothing left today" or "Nothing scheduled".

`isSilencedByFocus` is transient: it is computed once by `showing(_:)` inside the extension process
and is not `Codable`. `WidgetCache.CodingKeys` excludes it, so it is never written to or read from
`widget-cache.json`.

## Refreshing the timeline

The reload must come from the Electron main process, and the snapshot-changed comparison that gates
it, are the shared mechanism in [`../shared/widgets.md`](../shared/widgets.md).

## Building and packaging

```bash
pnpm --filter magical run build:widgets   # xcodebuild, stamp the version, sign
```

How the version and the build number are stamped is the same for every extension in the project;
[`../shared/process-model-and-ipc.md`'s Extension build number](../shared/process-model-and-ipc.md#extension-build-number)
has it, and read it before wondering why a rebuilt widget still behaves like the last one.

`scripts/build-app.sh` builds the extension and refuses to package without it, then checks it reached
`Contents/PlugIns/`. electron-builder downgrades a missing `extraFiles` entry to a warning and
packages anyway, and an app installed without the `.appex` shows no widgets in the gallery at all.
