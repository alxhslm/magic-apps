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

### Opening links

Which browser opens links that leave the app.

- **The Mac's default browser is preselected and marked `(default)`.** Picking a row pins that
  browser, so the app keeps using it if the Mac's default changes later.
- **Only installed browsers are listed.** Picking one sends every link through that browser. If it
  is a Chromium browser, links also open in the account's profile; see
  [Chromium profiles](#chromium-profiles).
- **Universal links can open in their app instead.** Some links belong to a desktop app, and apps
  installed on your Mac appear below with three choices:
  - `Open in the app`, so a Notion or Slack link opens in that app.
  - `Ask each time`, which shows a dialog naming both destinations. Its "don't ask again" box
    writes this same row.
  - `Use the browser`, so the link takes the account's profile like everything else.

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

If you use a Chromium browser such as Google Chrome, Brave or Edge, an account can send its links
to a particular profile, so a work link opens as you at work.

Each account names its profile on the **Accounts** tab. Its row shows the profile that will be
used:

- **The profile signed in as the account's address is selected automatically.** A profile name,
  such as `Work`, means links open in that profile, and choosing a name pins the account to it.
- **`None`** opens the link in whatever browser window is already there. An account also shows
  `None` when its address matches no profile.

:::note[Chromium browsers only]
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
