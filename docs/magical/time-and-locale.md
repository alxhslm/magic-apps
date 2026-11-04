# Times, dates and the Mac's locale

Every time and date Magical draws follows the Mac's own clock and locale. Nothing in the app has a
preferred 12- or 24-hour clock, and nothing has a preferred date order: both come from macOS, and a
change to either reaches a running app without a relaunch.

The region and the 12/24-hour switch are separate macOS settings. The switch writes
`AppleICUForce24HourTime` and leaves the region at `en_GB` or `en_US`, so either region can be on
either clock, and reading one is not a substitute for reading the other.

## Where the setting is read

`mac-clock.ts` reads `AppleICUForce24HourTime` in `app.whenReady()`, next to `setUiLocale`. It
returns a definite `true` or `false`, or `undefined` when the user has never touched the switch: an
absent key reads as an empty string, and reading it as `false` would pin a 24-hour region to a
12-hour clock, which is the same bug in the other direction. `time-format.ts` then takes the forced
value if there is one and otherwise the locale's own `hourCycle` from `Intl`.

Presence of the key means on. macOS forces 24-hour time for any present value, whatever it is, and
removes the key when the switch is turned off rather than storing `false`. The key is not honoured
from the NSUserDefaults argument domain, so `-AppleICUForce24HourTime 1` on a launch changes
Electron's reading but not Foundation's; it is useful for testing the read path, not for pretending
to be the system setting.

The Swift helper cannot lean on Foundation here. `Locale.current` folds the switch in once at launch
and never refreshes, and a running process still asked for 24-hour after the key was deleted. So
`TimeDisplay` reads the raw key on every access and rebuilds the locale from its identifier with the
cycle forced. Rebuilding from the identifier also keeps the off state honest on a Mac that launched
with the switch on: the inherited cycle does not survive into the fresh locale.

## Following a change without a relaunch

macOS posts no notification when the switch changes, so nothing can be observed. Both processes
re-read instead:

- **Electron** re-reads the key on a 30-second timer. The banner and the ICS dialog are built on
  demand, so the next one after a change uses the new clock.
- **The Swift helper** reads the key in `TimeDisplay` on each access and rebuilds its cached
  formatters only when the value has changed. The menu bar picks that up on its next tick, the
  popover on its next open, and a widget at its next timeline render.

A popover already on screen keeps the old clock until it reopens, which is the one visible delay.

## Which formatter each surface uses

| Surface                                                           | Formatter                                        |
| :---------------------------------------------------------------- | :----------------------------------------------- |
| Alert subtitle, invitation line, ICS import dialog                | `formatTime` / `formatClock`                     |
| Menu bar event times, agenda, popover cards, hero, both now rules | `TimeDisplay.time`                               |
| Day grid hour gutter                                              | `TimeDisplay.hour` (`HH` or `ha`)                |
| Menu bar date, month headers, agenda headings, widget date        | `TimeDisplay.dateFormatter`                      |
| Widget times                                                      | `WidgetFormat.time`, the same `TimeDisplay.time` |

In the Electron main process, `formatTime` and `formatClock` in `time-format.ts` are the only
formatters for user-visible times: the alert subtitle in `buildAlertContent`, the invitation line in
`formatInviteLine` and the ICS import dialog in `describeIcs`. Passing `undefined` as the locale is
what broke this before, because it resolves to ICU's default rather than the Mac's setting.

The widget extension lists its sources in `MagicalWidgets.xcodeproj` rather than depending on the
`MagicalHelperLib` package target, so a new shared file has to be added to that target explicitly.
`swift test` compiles the package and cannot catch it.

## Dates

Dates are a locale decision as well as a clock one, and the two do not travel together: London reads
`3 March 2026`, New York `March 3, 2026`, and Tokyo `2026年3月3日`. Display labels therefore come from
a field set through `TimeDisplay.dateFormatter(template:)` or `Intl` options, which let Foundation
and ICU choose the order and punctuation. A literal pattern such as `d MMMM yyyy` fixes both.

The medium widget's 58pt gutter is the one place with no room for the full weekday, so it asks for
`EEE` and draws `WED 4` rather than wrapping `WEDNESDAY` over two lines. The large widget's day
headings have the width for the full name.

## Keys and log lines stay fixed

A fixed pattern belongs to anything whose value is compared or written down rather than read as a
clock. Those are deliberately independent of the user's clock and region, because changing either
must not change a key or an ordering:

- `calendar-recurrence.ts`'s `hourCycle: 'h23'` builds a sortable key in a fixed locale.
- The helpers' `yyyy-MM-dd` day keys name a day in a snapshot or a dots map.
- The `yyyy-MM-dd HH:mm:ss` log stamps exist to be read in a log.

## Timezone

The zone is the Mac's too: every native surface renders in `.current`, and Electron's process-local
zone is the Mac's, so a UTC offset change moves what every one of them shows at the same instant.

The companion sidebar is the one exception, because Google Calendar renders it and uses the Google
account's own timezone and locale. Magical does not rewrite that: pushing the Mac zone in with
`?ctz=` would leave Google believing it is in one zone while drawing another, and events created in
the sidebar would land in the wrong one.
