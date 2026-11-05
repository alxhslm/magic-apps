# Times, dates and the Mac's locale

Every time and date Magical draws follows the Mac's own clock and locale. Nothing in the app has a
preferred 12- or 24-hour clock, and nothing has a preferred date order: both come from macOS, and a
change to either reaches a running app without a relaunch.

The region and the 12/24-hour switch are separate macOS settings. The region is `AppleLocale`
(`en_GB`); the switch writes `AppleICUForce24HourTime` when 24-hour is on and
`AppleICUForce12HourTime` when it is off, so either region can be on either clock.

## Where the setting is read

`mac-clock.ts` reads both clock keys in `app.whenReady()`, next to `setUiLocale`, and
`readMacLocale()` reads `AppleLocale`. 24-hour wins when set, then 12-hour, then the locale's own
`hourCycle` from `Intl`. A key set to `1` forces that clock and `0` forces nothing, so the value
decides rather than its presence. Reading only the 24-hour key is not enough: turning 24-hour off
writes the 12-hour key instead, so an `en_GB` Mac set to 12-hour has the 24-hour key absent and
would otherwise fall back to a 24-hour region.

The keys are not honoured from the NSUserDefaults argument domain, so `-AppleICUForce24HourTime 1`
on a launch changes Electron's reading but not Foundation's; it is useful for testing the read
path, not for pretending to be the system setting.

The Swift helper cannot lean on Foundation here. `Locale.current` folds both the region and the
switch in once at launch and never refreshes, so neither a region change nor a clock change ever
arrives. `TimeDisplay` reads both keys and `AppleLocale` on every access and rebuilds the locale
from the stored identifier with the cycle forced. Rebuilding from the identifier also keeps the off
state honest on a Mac that launched with a different setting: the inherited cycle does not survive
into the fresh locale.

## Following a change without a relaunch

macOS posts no notification when either setting changes, so nothing can be observed. Both
processes re-read instead:

- **Electron** re-reads both clock keys and the region on a 30-second timer. The banner and the ICS
  dialog are built on demand, so the next one after a change uses the new clock or date order.
- **The Swift helper** reads them in `TimeDisplay` on each access, and a five-second watcher in the
  helper posts an internal change notification when the value moves. `TrayModel` and `SidebarModel`
  observe it, so an already-drawn popover, sidebar or agenda redraws within five seconds, and a
  region change reaches date labels the same way. The AppKit menu bar title follows on its own
  30-second tick, and a widget at its next timeline render.

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
