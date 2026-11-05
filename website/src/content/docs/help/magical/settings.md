---
title: Settings Reference
description: Detailed guide to every preference pane, meeting alert configuration, and calendar option in Magical.
---

Magical's settings window (<kbd>⌘,</kbd> or **Magical → Settings…**) has five tabs: **General**, **Accounts**, **Appearance**, **Notifications** and **Advanced**.

## General

The General tab manages startup behaviour and default calendar file handling:

### Launch at Login

- **Launch Magical at login**: Automatically starts Magical when you log into your Mac.
  - **Why turn it on**: Keeps your menu bar meeting countdown, upcoming alerts, and desktop widgets active and on time all day long.
  - **Silent startup**: Runs quietly in the menu bar without opening full desktop windows on startup.

### Calendar Files (`.ics`)

- **Calendar files (.ics)**: Shows which app opens `.ics` calendar files, with a button to make Magical the one. Once Magical holds the type the button disappears, and the only way back is to name another app in Finder's Get Info panel.
  - **Opening .ics Files**: Double-clicking a `.ics` file from the web, from an email or from AirDrop opens Magical, which reads the file and asks which account to import into when you have more than one. Google Calendar imports it, and a notification names the account and says how it went: imported, rejected in Google's own words, or unconfirmed, which puts Google's import page in front of you with the file already loaded.
  - **Importing by hand**: **File → Import Calendar File…** (<kbd>⇧⌘I</kbd>) reaches the same flow for a file you have already found.
  - **New event account**: Choose whether new events are added to your currently active calendar account or prompt you to pick an account every time.

### Open links in

Which browser opens links that leave the app.

- **Only installed browsers are listed**, and the row macOS opens links with is marked `(default)`.
- **Every link uses the chosen browser**, so the account's Chromium profile applies to it.
- **Except the apps named in the link table**: Notion, Linear, Todoist, Figma, Slack, Asana, Loom,
  Miro and Dropbox links open in their desktop app, because those apps own the link.

**Links owned by an app** chooses what that exception does: `Always open in the app`, `Ask, and
remember`, or `Never, always use the browser`. Asking shows a dialog naming both destinations and
remembers the answer for that domain, so it asks once.

### Times and Dates

Magical's date and time formats follow your Mac.

- **12- or 24-hour clock**: the **24-Hour Time** switch in **System Settings → General → Date & Time**. On, a meeting reads `14:35`; off, `2:35 pm`.
- **Date order and language**: **System Settings → General → Language & Region**. A British Mac reads `18 Oct`, an American one `Oct 18`.

Relaunch Magical after changing either, so the menu bar, popover, sidebar, banners and widgets all pick it up together.

---

## Accounts

The Accounts tab manages your connected Google accounts and calendar access, which [Multiple Accounts](/help/magical/accounts/) covers in full:

- **Account List**: Lists all configured accounts with account colour dots, display names, and authentication state.
- **Colour Customisation & Renaming**:
  - Click any colour swatch to pick a unique colour for that account. This colour tints event cards in the agenda and widgets.
  - Click the account name, edit it, then press Return or click away to save.
- **Reordering**: Drag accounts up or down to adjust priority and tab ordering (`Cmd+1`, `Cmd+2`, etc.).
- **Add & Remove**:
  - Click **`+`** to connect another Google Workspace or Google Calendar account.
  - Click **`–`** to delete an account.
- **Reset Session…**:
  - Clears stored authentication cookies for an account and re-opens the Google login flow. Useful if a Google Workspace enterprise session expires.

### Chromium profiles

Each account chooses which browser profile its links open in, so a work link opens as you at
work rather than as you at home.

The control sits on the account's row in **Accounts**, and reads the profile that will be used:

- **A profile name**, such as `Alex`, means links open in that profile. Chrome, Brave and
  Edge can be told this; they read it when they start, so a profile that is not already open
  arrives in its own window.
- **`None`**, which is what an account shows when its address matches no profile, means the link
  opens in whatever window the browser already has.
- **Choosing a profile pins it.** Unticking it returns the account to matching.

:::note[Chromium browsers only, for now]
Chrome, Brave and Edge keep profiles in the same place and accept the same flag, which is what
makes this work. Safari has profiles but no supported way for another app to choose one, and
Firefox differs again. With any other browser the profile menu is greyed out.
:::

---

## Appearance

The Appearance tab customises the calendar view, Google Calendar web interface, Dock icon, and menu bar item:

### Theme & Window

- **Theme**: Choose `System Default`, `Light`, or `Dark`.
- **Transparent background**: Gives the main window a translucent macOS appearance.

### Google Calendar Interface

- **Hide app sidebar**: Hides the left navigation sidebar in Google Calendar to give more room to the week or month grid.
- **Hide Tasks tab**: Hides the Calendar and Tasks switcher at the top of the app. Tasks stays reachable from the sidebar. See [Google Tasks](/help/magical/tasks/).
- **Show completed tasks**: Toggles whether completed Google Tasks remain visible in the companion sidebar, the menu bar popover and the agenda widgets. It is the same setting as the one in the filter menu, and a change anywhere updates every surface immediately. See [Google Tasks](/help/magical/tasks/).

### Dock & Menu Bar

- **Dock badge**:
  - `All outstanding invitations`: Badges the Dock icon with the total number of meeting invites awaiting your response.
  - `Unread invitations`: Badges only when new, unread invitations have arrived.
  - How each mode counts, and what clears it, is in [Invitations & Badges](/help/magical/invitation-tray/).
- **Show menu bar icon**: Toggles the Magical status item in the macOS menu bar.
- **Menu bar display**:
  - `Next event`: Shows the name and countdown/time of your next upcoming meeting directly in the menu bar.
  - `Day of month`: Displays the current date number (e.g. "18").
  - `Day and month`: Displays the day and month (e.g. "Oct 18").
  - `Icon only`: Shows only the compact Magical calendar glyph.
- **Colour by account**: Tints the menu bar text with the colour of the account hosting the next event.

---

## Notifications

The Notifications tab manages meeting reminder alerts, RSVP options and video calling preferences. [Meeting Alerts & Invitations](/help/magical/notifications/) covers what a banner does:

### Meeting Alerts

- **Alert me before meetings start**: Toggles native macOS banner notifications prior to scheduled meetings.
- **Alert me**: Select how early alerts trigger:
  - `1 minute before`
  - `5 minutes before` (recommended)
  - `10 minutes before`
  - `15 minutes before`
  - `30 minutes before`

### Alerts by Calendar

Under **Alerts by Calendar**, you can toggle alerts on or off for individual calendars. For example, you can enable alerts for your primary work schedule while muting reminders from shared team holidays or secondary project calendars.

### Joining Video Calls

**Always open calls in the browser** sends a Google Meet, Zoom or Microsoft Teams link to your default browser instead of the desktop app.

### Focus Filters

Click **Open Focus Settings…** to link calendar schedules with Apple Focus modes, muting personal alerts during work hours and work alerts during personal time. See [Focus Filters](/help/magical/focus-filters/).

---

## Advanced

The Advanced tab manages resource optimisation and troubleshooting:

### Memory

- **Unload inactive after**: Automatically suspends background calendar tabs when inactive to save system RAM:
  - Options: `1 minute`, `5 minutes`, `10 minutes`, `30 minutes`, `1 hour`, or `Never`.
  - When returning to an unloaded account, the view reloads from the local encrypted cache.

### Diagnostics

**Collect Diagnostics…** writes an archive of application logs, sync timestamps and environment details, with personal data removed, for a bug report.
