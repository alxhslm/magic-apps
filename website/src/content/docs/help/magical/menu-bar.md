---
title: Menu Bar & Popover
description: Using Magical's menu bar assistant, meeting countdown, and one-click conference joining.
---

Magical keeps your schedule in the menu bar, without a window in the way.

## Status Icon Display Modes

In **Settings → Appearance**, which the [Settings Reference](/help/magical/settings/) describes, you can customise how Magical appears in your macOS menu bar:

- **Next event**: Displays the title and countdown (e.g. `in 12m` or `NOW`) of your upcoming meeting.
- **Day of month**: Displays today's date number (e.g. `18`).
- **Day and month**: Displays the short date (e.g. `Oct 18`).
- **Icon only**: Shows a clean calendar glyph.

With **Next event** selected, **Colour by account** tints the countdown with the accent colour of the account hosting the meeting.

---

## Popover

Clicking the menu bar icon reveals your interactive day agenda, which is also what the [desktop widgets](/help/magical/widgets/) show:

- **Up Next Hero Card**: Highlights your ongoing or immediate next meeting with attendees, location, and conference platform.
- **Join Button**: 1-click video call join for Google Meet, Zoom, Microsoft Teams, and Webex.
- **Agenda Timeline**: Displays all scheduled events grouped chronologically, with current events highlighted and past events dimmed.
- **Mini Month View**:
  - Click the **chevron next to the month title** to expand or collapse a compact monthly grid with density dots for busy days.
  - Click the **Month Title** at any time to instantly jump the agenda back to **Today**.
  - Click any **date cell** in the mini month to smoothly scroll the agenda timeline straight to that day.
  - **Endless Scrolling**: As you scroll towards the bottom of your agenda, Magical automatically streams upcoming events for the next 90 days.
- <span class="sym sym-calendar-badge-plus" aria-hidden="true"></span> **Quick Add**: Opens the event composer from the header.
- **Footer Link**: A dedicated **Open Calendar** button at the bottom of the popover brings the main window forward.

![Magical menu bar popover showing day agenda, Up Next hero card, and one-click video conference joining](/assets/shot-popover-magical.webp)

---

## Filtering & Multi-Account Search

The popover header includes quick controls to keep your view focused:

- <span class="sym sym-filter" aria-hidden="true"></span> **Filter Menu**:
  - Shows all connected Google accounts and their sub-calendars (Primary, Team, Birthdays, Holidays, and subscribed calendars).
  - Toggle any calendar on or off with a single click to instantly declutter your agenda view.
- **Search Bar & Account Target**:
  - Type in the search box to find meetings by title, organiser, or location.
  - Click the **magnifier icon** in the search field to select a specific account or search across all accounts simultaneously.
- **Gear Menu**: Contains **Show Completed Tasks**, **Refresh Calendars** (or press <kbd>R</kbd> while the popover is open), **Preferences…**, and **Quit Magical**. See [Google Tasks](/help/magical/tasks/) for the toggle.

---

## Status Banners

If syncing is interrupted, the popover displays clear diagnostic alerts:

- **Sync Status**: Shows **Not up to date** and how long ago the account last synced, if network issues delay updates.
- **Offline Banner**: Indicates when your Mac has lost internet connection.
- **Sign In Required**: Appears if a Google session expires, providing a 1-click **Sign In** button.

---

## Invitations in the Popover

A meeting that is waiting for your reply is drawn as an outlined event card with a **Reply needed** badge and a question mark icon, so it reads differently from a meeting you have accepted. A tentative reply shows a dashed border and a **Maybe** chip.

![Magical menu bar popover highlighting pending meeting invitations with Reply Needed and Maybe status](/assets/shot-invitations-magical.webp)

Right-click the card to answer it from the popover. The count of invitations still awaiting a reply lives in the toolbar tray and the Dock badge. [Invitation Tray](/help/magical/invitation-tray/) covers those, and [Meeting Alerts and Invitations](/help/magical/notifications/) covers the banner that announces a new one.

---

## Right-Click Actions

Right-click any event card in the popover to perform instant actions:

- **Open in Magical**: Jumps directly to the event inside the main calendar window.
- **Join Meeting**: Launches the attached video call directly.
- **Copy Event Link**: Copies the Google Calendar event URL to your clipboard for sharing with colleagues.
- **RSVP**: Choose **Yes**, **Maybe**, or **No** from the submenu. A checkmark indicates your current response, and the answer reaches Google Calendar as it lands.
- **Mark Complete / Mark Incomplete**: Marks a Google Task done, or re-opens it, in Google Tasks. See [Google Tasks](/help/magical/tasks/).
- **Delete Event / Delete Task**: Deletes the event or task with a native confirmation dialogue. For a recurring event, it deletes the occurrence you are looking at rather than the series. See [Google Tasks](/help/magical/tasks/).
