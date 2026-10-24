# Focus filters

macOS Focus Filters let a Focus tell Magimail which of its accounts matter right now. Magimail vends
one from an App Intents extension. The intent, the state file and the distributed notification it
posts, the picker's constraints, the packaging and the worktree trap are all shared and in
[`../shared/focus-filters.md`](../shared/focus-filters.md). The filter silences an excluded
account and drops it from the surfaces that pull attention.

## What a Focus does

An account excluded by the active filter is always silenced and dropped from the surfaces whose job
is to pull attention. It stays on the surfaces you navigate with, every time.

| Surface          | Excluded account                     |
| :--------------- | :----------------------------------- |
| Notifications    | silenced                             |
| Dock badge       | not counted                          |
| Menu bar popover | not listed                           |
| Widgets          | not listed                           |
| Toolbar switcher | listed, dimmed dot, still selectable |
| Accounts menu    | listed, still selectable             |

`Prevent Access to Silenced Accounts` changes only the last two rows: the account is greyed out and
cannot be selected. It stays listed either way.

In code that is two lists, not one. `getFocusedAccounts()` holds what the filter includes, and feeds
the glanceable surfaces. `getVisibleAccounts()` holds every account, always, and feeds the switcher
and the menu. Focus state reaches the navigation surfaces as emphasis instead, through
`isExcludedByFocus` and `isDisabledByFocus`.

Why an excluded account is never removed from the switcher, and why the excluded state is a dimmed
dot rather than grey text, are in [`../shared/focus-filters.md`](../shared/focus-filters.md).

## How the filter reaches the app

The intent, the state file and the distributed notification are the shared mechanism in
[`../shared/focus-filters.md`](../shared/focus-filters.md). The banner is filtered by `MagimailHelper`,
the only thing that posts a Magimail banner, rather than by an `appContext` `NSPredicate` over each
notification: the helper checks the filter first, so the predicate could only agree or be out of date,
and the snapshot it would carry is taken when the filter is configured and so cannot name an account
added since. `appContext` therefore vends an empty context, as Magical's does.

A banner is silenced by the helper's `isAccountMuted` check at the moment it would be posted, and
nowhere else. The main process still holds a copy of the filter for the surfaces it owns — the dock
badge, the menu bar, widgets and the account switcher — but it hands every batch to the helper, which
reads `focus-filter.json` directly. That is the split Magical uses: one decision point, at the moment
of posting.

The main process's copy lives in `focus-filter-manager.ts` rather than in the account manager, which
belongs to the window. It therefore outlives the window, and a window built after the filter arrived
— the helper forwards one as soon as it reads it, which can be before the first window — takes the
copy at construction instead of starting unfiltered.
