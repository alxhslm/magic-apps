# Times, dates and the Mac's locale

Every time and date Magical draws follows the Mac's own clock and locale. Nothing in the app has a
preferred 12- or 24-hour clock, and nothing has a preferred date order: both come from macOS.

The region and the 12/24-hour switch are separate macOS settings. The region is `AppleLocale`
(`en_GB`); the switch writes `AppleICUForce24HourTime` when 24-hour is on and
`AppleICUForce12HourTime` when it is off, so either region can be on either clock.

A change to either takes effect when Magical is relaunched. Nothing polls, and no surface updates
ahead of another, so the menu bar, popover, sidebar and widgets cannot disagree about the clock or
the date order part-way through a session.

## Where the setting is read

The Swift surfaces use Foundation's `Locale.current`, which already carries both settings.
`TimeDisplay` builds a `timeStyle = .short` formatter from it, asks the `j` template whether the
clock is 24-hour, and derives date labels from templates. There is nothing to read from defaults,
and the only fixed patterns are the keys and log stamps below.

The Electron main process cannot use the same source: ICU's default locale is not the Mac's, and
`toLocaleTimeString(undefined, …)` therefore ignores both settings. `mac-clock.ts` reads them once
in `app.whenReady()`, next to `setUiLocale`. `readMacLocale()` reads `AppleLocale`, and the clock
comes from two keys: `AppleICUForce24HourTime` when 24-hour is on and `AppleICUForce12HourTime` when
it is off. 24-hour wins when set, then 12-hour, then the locale's own `hourCycle` from `Intl`.

Reading only the 24-hour key is not enough: turning 24-hour off writes the 12-hour key instead, so
an `en_GB` Mac set to 12-hour has the 24-hour key absent and would otherwise fall back to a 24-hour
region. A key set to `1` forces that clock and `0` forces nothing.

The keys are not honoured from the NSUserDefaults argument domain, so `-AppleICUForce24HourTime 1`
on a launch changes Electron's reading but not Foundation's; it is useful for testing the read
path, not for pretending to be the system setting.

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

Google Calendar's own web view is the exception: Google renders it and uses the Google account's
timezone and locale. Magical does not rewrite that. Pushing the Mac zone in with `?ctz=` would
leave Google believing it is in one zone while drawing another, and events created there would land
in the wrong one.
