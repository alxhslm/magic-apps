# `.ics` import extensions

Opening a `.ics` file and the Import pane it is driven through ship;
[`ics-import.md`](../../docs/magical/ics-import.md) owns them. This spec covers two extensions: the
sub-calendar picker and the offline queue.

## Choosing a sub-calendar on import

The account picker asks which account. Which calendar within that account is left to Google's own
default, the primary calendar.

The Import pane already carries the control: an **Add to calendar** combobox whose `li[role="option"]`
entries hold the calendar name in `aria-label` and a base64 calendar id in `data-value`. Selecting
one is a click on the option before the Import button is pressed.

The cost is in the picker, not the pane. A second dropdown means the native alert cannot be used
(`dialog.showMessageBox` has buttons and nothing else), so it means a real sheet from the Swift
helper, the native-UI rule
[`native-ui.md`'s Who draws what](../../docs/shared/native-ui.md#who-draws-what) sets out, with an
account list and a calendar list that repopulates when the account changes. That sheet is the work;
driving the combobox afterwards is a few lines.

```plain text
┌─────────────────────────────────────────────────────────┐
│ [ Calendar Icon ]                                       │
│ Import Calendar Event                                   │
│ "Dentist Appointment"                                   │
│ Friday, 18 September 2026 · 14:00 - 15:00               │
│                                                         │
│ Import into:                                            │
│ [ Personal (taylor@example.com) ▾ ]                         │
│                                                         │
│ Target Calendar:                                        │
│ [ [●] Personal Appointments ▾ ]                         │
│                                                         │
│             [ Cancel ]   [ Import to Calendar ]         │
└─────────────────────────────────────────────────────────┘
```

`Esc` cancels and `Enter` imports, so the keyboard alone works.

## Importing while offline

An import driven through Google's pane needs Google. Offline, the pane does not load and the user is
told the import could not be confirmed, which is true but useless: the file is on disk and nothing
is retrying it.

Queue the path in the local store, flush it when `CalendarPoller` next reaches Google, and report
the outcome then. Keep the file path rather than a copy of its contents, and check the file still
exists at flush time: an invite imported from a mail attachment may have been in a temporary
directory that is gone by morning.
