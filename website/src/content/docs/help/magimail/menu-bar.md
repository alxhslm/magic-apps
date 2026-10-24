---
title: Menu Bar & Popover
description: Monitoring unread mail, filtering messages, and executing 1-click triage actions from the menu bar.
---

Magimail places a lightweight status icon in your macOS menu bar, allowing you to triage incoming email rapidly without keeping the main application window open.

## Status Icon Controls

In **Settings → Appearance** (under **Dock & Menu Bar**), which the [Settings Reference](/help/magimail/settings/) describes, four switches decide what the menu bar shows:

- **Show menu bar tray**: shows or hides the Magimail item itself.
- **Show unread count**: a numeric unread counter beside the icon.
- **Show colour dots**: a coloured dot for each account with unread mail.
- **Show unread only in the popover**: filters the popover list to unread threads.

With the count and the dots both off, the menu bar shows only the Magimail glyph.

## Popover

Clicking the menu bar icon opens a floating popover listing your most recent email threads:

- Each row shows the sender's name, subject line, relative timestamp, and an account colour dot.
- Left-click any thread to open it directly in the Magimail main window.
- The footer includes a direct **Open Inbox** button to raise Magimail with one click.
- The same feeds are on the desktop as [widgets](/help/magimail/widgets/), drawn from the same local copy of your mail.

![Magimail menu bar popover preview with multi-account message feeds](/assets/shot-popover.webp)

## Filtering & Multi-Account Search

The header of the menu bar popover contains quick-triage controls:

- <span class="sym sym-filter" aria-hidden="true"></span> **Filter Menu**:
  - **Unread Only**: Toggle on to hide already-read threads and focus exclusively on mail requiring action.
  - **Account Filter**: Switch between **All Accounts** (unified inbox stream) and individual accounts (e.g. Work, Personal, or Client).
- **Search Bar & Account Target**:
  - Type any search query directly in the popover header.
  - If you have multiple accounts, click the **magnifying glass icon** inside the search bar to target your query to a specific email account via a dropdown menu with colour dots.
  - Pressing <kbd>Return</kbd> brings Magimail to the front and runs the search in Gmail.
- **Quick Compose**: Click the pencil icon to open a clean compose window immediately.
- **Gear Menu**: Offers **Refresh Inbox** (or press <kbd>R</kbd> while the popover is open), **Preferences…**, and **Quit Magimail**.

What raises a banner, and what each of its buttons does, is in [Notifications & Badges](/help/magimail/notifications/).

## Status Banners

The popover provides instant feedback on the health of your accounts:

- **All Caught Up**: When there is no unread mail, the popover displays a clean "All caught up" indicator across your accounts.
- **Offline Indicator**: Appears if your Mac loses internet connection, confirming that cached data is being displayed.
- **Sign In Required**: If an account token expires or Google requests a password update, a warning banner appears with a 1-click **Sign In** button to re-authenticate without digging through settings.

## Right-Click Actions

You can triage messages on the fly without opening them. Right-click any email row in the popover to display instant actions:

- **Open in Magimail**: Brings the main window forward and displays the selected email.
- **Archive**: Archives the thread immediately and removes it from your unread list.
- **Mark as Read / Mark as Unread**: Toggles the read state without opening the message.
- **Delete**: Moves the email directly to Bin.
