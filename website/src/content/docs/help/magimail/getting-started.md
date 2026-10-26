---
title: Getting Started
description: System requirements, installation, and initial setup for Magimail.
---

Magimail is a native macOS Gmail client for macOS 14 Sonoma or later on Apple silicon Macs.

## Installation

### Via Homebrew (Recommended)

Install Magimail using the official Homebrew tap:

```sh
brew install --cask alxhslm/magic-apps/magimail
```

Or tap the repository first:

```sh
brew tap alxhslm/magic-apps
brew install --cask magimail
```

### Direct Download (DMG)

1. Download the signed [`Magimail.dmg`](https://updates.macmagic.app/magimail/Magimail.dmg) disk image.
2. Open the disk image and drag **Magimail** into your `/Applications` folder.
3. Open Magimail from your Applications folder or Spotlight.

## Adding Your First Account

When you launch Magimail for the first time, the window opens directly to Google's sign-in page:

1. Enter your Google email address and password.
2. Complete two-factor authentication if prompted.
3. Once signed in, Magimail loads your inbox with the native macOS toolbar and sidebar.

Two things are worth setting up next: [Multiple Accounts](/help/magimail/accounts/) if you have more than one Google account, and [Notifications & Badges](/help/magimail/notifications/) to decide what interrupts you.

## Working Offline

Magimail needs **Offline mail** turned on in Gmail so it can show your unread count and recent emails in the [menu bar](/help/magimail/menu-bar/) and [desktop widgets](/help/magimail/widgets/). Each account needs it once.

If it is not already turned on, Magimail displays a prompt at the top of your inbox:

:::note[What the banner says]
_"For accurate category badges and instant menu bar sync: enable offline mail in Gmail Settings."_
:::

### How to Turn It On

1. Click **Open Offline Settings** in the banner (or click the gear icon in Gmail → **See all settings** → **Offline**).
2. Tick **Enable offline mail**.
3. Select **Keep offline data on my computer**.
4. Click **Save Changes** at the bottom of the page.

Once enabled, your unread badges, menu bar previews and desktop widgets keep working without a connection.

---

## System Permissions & Startup

- **Notifications**: Magimail requests permission to send alerts. Allowing this enables background new mail alerts with quick actions (Archive and Mark Read).
- **Launch at Login**: Enable this in **Settings → General** so your menu bar unread count and widgets are ready as soon as you log into your Mac. See [Settings Reference](/help/magimail/settings/).
- **Default Email Client**: Set Magimail as your default email reader in **Settings → General** or macOS **System Settings → Desktop & Dock → Default web browser / Mail** to handle all `mailto:` links across macOS.
