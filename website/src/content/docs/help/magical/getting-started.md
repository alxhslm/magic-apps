---
title: Getting Started
description: System requirements, installation, and initial setup for Magical.
---

Magical is a native macOS Google Calendar client for macOS 14 Sonoma or later on Apple silicon Macs.

## Installation

### Via Homebrew (Recommended)

Install Magical using the official Homebrew tap:

```sh
brew install --cask alxhslm/magic-apps/magical
```

Or tap the repository first:

```sh
brew tap alxhslm/magic-apps
brew install --cask magical
```

### Direct Download (DMG)

1. Download the signed [`Magical.dmg`](https://updates.macmagic.app/magical/Magical.dmg) disk image.
2. Drag **Magical** into your `/Applications` folder.
3. Launch Magical from Applications or Spotlight.

## Adding Your First Account

On initial launch, Magical opens directly to Google sign-in:

1. Sign in with your Google Workspace or personal Google account.
2. Complete any required 2-factor authentication.
3. Magical loads your calendar schedule and synchronises your calendar events locally.

With a second account, [Multiple Accounts](/help/magical/accounts/) covers adding it and what each one keeps separate.

## Menu Bar & Desktop Modes

Magical operates in two complementary modes:

- **Full Window**: Standard desktop window with day, week, month and agenda views, a [customisable toolbar](/help/magical/toolbar/) and the account switcher.
- **Menu Bar Assistant**: A menu bar icon showing a countdown to your next meeting, opening into the [calendar popover](/help/magical/menu-bar/) with video call join shortcuts.

---

## Working Offline

Magical keeps a local copy of your calendar so your schedule is always available:

- **Always Visible**: Even when your Mac has no Wi-Fi or is in airplane mode, your upcoming meetings, agenda and tasks remain visible in the menu bar popover and desktop widgets. [Google Tasks](/help/magical/tasks/) covers the tasks half.
- **Meeting Reminders Still Fire**: Alerts are armed from the local copy of your calendar, so reminders arrive on time even when you are disconnected. See [Meeting Alerts and Invitations](/help/magical/notifications/).
- **Instant Launch**: The app opens straight to your schedule without waiting for a connection to load.

---

What the notification permission enables, and what happens without it, is in [Meeting Alerts & Invitations](/help/magical/notifications/).

## System Permissions & Startup

- **Notifications**: Granting notification permission enables meeting countdown alerts and 1-click RSVP buttons.
- **Launch at Login**: Enable this in **Settings → General** so your menu bar agenda and meeting countdown are ready as soon as you log into your Mac. See [Settings Reference](/help/magical/settings/).
- **Calendar Files**: Set Magical as the handler for `.ics` files in **Settings → General**, so a calendar invitation you download opens in Magical, which asks which account to add it to. macOS has no single default-calendar role, so this is claimed per file type. See [Settings Reference](/help/magical/settings/).
