# Focus filters

A Focus is the user telling macOS what they are doing. A filter is Magical being told, so that
turning on a Work Focus stops personal meetings interrupting without also hiding the calendar.

## What a filter silences

A filter asks two questions: which accounts you are working in, and then which of their calendars
matter. Both start with everything on, so a filter nobody has touched silences nothing. Turn an
account off and every calendar it has goes quiet; leave it on and you can still turn its calendars
off one at a time.

A silenced calendar loses these:

| Surface                 | Silenced calendar                          |
| :---------------------- | :----------------------------------------- |
| Meeting alerts          | no banner                                  |
| Invitation banners      | no banner                                  |
| Dock badge              | not counted                                |
| Menu bar title          | not counted                                |
| Popover agenda          | not shown                                  |
| Popover next-event card | not counted                                |
| Popover mini month      | no density dot                             |
| Popover calendar filter | listed, unticked, not tickable             |
| Widgets                 | not shown; "Silenced by Focus" when it did |

Every glanceable surface reads one list, so none of them can contradict another: a title counting
down to a lunch the agenda does not list reads as a bug whichever half is right, and a Focus that
quietens the popover while the title still announces the same meeting has not done what was asked.

An event sits on several calendars at once, and it goes quiet only when the filter silences every one
of them. A Work Focus that silences a recruiting calendar has not asked to lose an interview the user
is attending on their own calendar; see [`calendar-wire-format.md`](calendar-wire-format.md) for why
the event carries all of them.

An account is silenced when nothing it has is left on, whether because the filter turned the account
off or because its calendars went one by one. That is the only account-level state there is, because
a switcher segment is one account and cannot be half-disabled:

| Surface           | Silenced account                     | …and the filter blocks it |
| :---------------- | :----------------------------------- | :------------------------ |
| Toolbar switcher  | listed, dimmed dot, still selectable | greyed, not selectable    |
| Accounts menu     | listed, still selectable             | greyed, not selectable    |
| Google's own page | untouched                            | untouched                 |

`Prevent Access to Silenced Accounts` moves an account from the first column to the second, and it
never applies to the account you are looking at: a filter that silenced every account would otherwise
grey out all of them at once and leave the window with nowhere to go.

Everything else stays where it was. The account is still in the switcher, the calendar is still in
the popover's filter list, and the events are still polled, cached and scheduled.

## How the filter reaches the app

The intent, the state file and the distributed notification are the shared mechanism in
[`../shared/focus-filters.md`](../shared/focus-filters.md). The banner is filtered by `MagicalHelper`,
the only thing that posts a Magical banner, rather than by an `appContext` `NSPredicate` over each
notification: the helper checks the filter first, so the predicate could only agree or be out of date,
and the snapshot it would carry is taken when the filter is configured and so cannot name a calendar
created since.

The picker's constraints, the accounts-and-calendars model, the prefixing rule, the rule that a Focus
only ever silences, the scheduler being left unaware, the packaging requirements and the known
limitation are all shared and in [`../shared/focus-filters.md`](../shared/focus-filters.md).

Settings → Notifications shows the filter's current state and opens the macOS Focus settings, as
Magimail's does. `FocusFilterController` writes that line as the filter changes rather than having it
pushed from the main process, which only ever sees the helper's `focusFilter.changed` event.

### Picker behaviour when a calendar is added

The picker cannot hold a button, so "everything in this account" is a separate `Accounts` parameter
rather than a row among the calendars, where it would read as one more calendar. The calendar list is
deliberately not narrowed to the accounts still on: `IntentParameterDependency` would let
`MagicalCalendarQuery` read `Accounts` and filter itself, but making the entity set depend on another
parameter re-resolves it and loses the stored selection, so every calendar in a saved filter comes
back unticked on the next edit.
