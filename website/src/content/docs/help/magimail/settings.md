---
title: Settings Reference
description: Detailed guide to every preference pane, background optimisation, and customisation option in Magimail.
---

Magimail's preferences window (<kbd>⌘,</kbd> or **Magimail → Preferences…**) has five tabs: **General**, **Accounts**, **Appearance**, **Notifications** and **Advanced**.

## General

The General tab controls startup behaviour, default app registration, and message composition:

### Launch at Login

- **Launch Magimail at login**: Automatically starts Magimail when you log into your Mac.
  - **Why turn it on**: Your menu bar unread counter, [desktop widgets](/help/magimail/widgets/) and incoming email notifications are active from startup, without launching the app by hand each day.
  - **Silent startup**: Starts quietly in the background without popping open windows or interrupting your work.

### Default Email Reader (`mailto:`)

- **Default email reader**: Sets Magimail as your Mac's default email client.
  - **Everyday use**: Whenever you click an email link in Safari, Chrome, Slack, Apple Notes, Word, or PDFs, Magimail opens a new compose window with the recipient pre-filled.
  - **Sending account choice**: Under **Compose account**, choose whether Magimail automatically drafts from your currently active account or prompts you with a quick account picker so you can select which email address to send from.
  - **System Settings**: You can also set this in macOS **System Settings → Desktop & Dock → Default web browser / Mail**.

### Global Quick Compose Shortcut

- **Quick compose hotkey**: Sets a system-wide keyboard shortcut that opens a compose window from any app, even in full-screen. See [Quick Compose](/help/magimail/quick-compose/):
  - Options: `Off`, `⌥⌘C`, `⌃⌘C`, `⇧⌘C`, or `⌃⌥⌘C`.

---

## Accounts

The Accounts tab manages your connected Google accounts:

- **Account List**: Displays each logged-in account with its custom colour swatch, user-defined display name, and authentication status.
- **Custom Swatch & Renaming**:
  - Click any colour swatch to pick a distinctive tint for that account. This colour accents account tabs, notification banners, menu bar items, and widgets.
  - Click the account name, edit it (for example "Work", "Personal" or "Consulting"), then press Return or click away to save.
- **Reordering**: Drag and drop accounts up or down in the list to reorder them. The order determines the account tab sequence and keyboard shortcuts (`Cmd+1`, `Cmd+2`, etc.).
- **Add & Remove**:
  - Click **`+`** to add another Google Workspace or Gmail account.
  - Click **`–`** to delete the selected account.
- **Reset Session…**:
  - If a Google Workspace session expires or triggers an authentication error, click **Reset Session…** to clear the account's authentication cookies and log back in without losing other accounts.

---

## Appearance

The Appearance tab customises the look and behaviour of the window, Gmail interface, Dock, and menu bar:

### Theme & Window

- **Theme**: Choose between `System Default` (automatically switches with macOS Dark Mode), `Light`, or `Dark`.
- **Transparent background**: Gives the window a modern, translucent macOS appearance.

### Gmail Interface

- **Hide inbox ads**: Automatically filters out top-of-inbox promotional ad banners.
- **Hide app sidebar**: Hides the Google Workspace side rail (Chat, Spaces, Meet icons) to maximise screen space for email threads.

### Dock & Menu Bar

- **Dock badge**:
  - `All unread messages`: Shows the aggregate unread message counter across all active accounts.
  - `New messages only`: Badges only when new unread messages arrive since you last opened the app.
  - `Off`: Keeps the Dock icon clean without numbers.
- **Show menu bar tray**: Displays the Magimail status item in the macOS menu bar.
- **Show unread count**: Shows a numeric unread counter directly in the menu bar next to the icon.
- **Show colour dots**: Displays colour-coded dots corresponding to accounts that have unread mail.
- **Show unread only in the popover**: Filters the menu bar popover list to show only unread message threads.

---

## Notifications

The Notifications tab offers granular per-category alert controls:

### Category Notification Levels

Unlike standard web notifications that buzz for every incoming email, Magimail allows setting independent notification levels for each Gmail category:

- **Primary**: Email directly to you.
- **Updates**: Confirmations, bills, and automated updates.
- **Promotions**: Marketing emails and newsletters.
- **Social**: Social media notifications.
- **Forums**: Mailing lists and group discussions.

Each category supports four alert levels:

- `Loud`: Displays a native macOS notification banner with sound.
- `Silent`: Displays a notification banner without playing a chime.
- `Badge only`: Increments the unread count on the Dock and menu bar without showing a banner.
- `Off`: Completely ignores new messages in this category.

### Focus Filters

Integrates with Apple Focus modes. Click **Open Focus Settings…** to configure which email accounts are visible during specific Focus modes (e.g., mute work accounts during "Personal" focus). See the [Focus Filters guide](/help/magimail/focus-filters/) for details.

---

## Advanced

The Advanced tab controls background resource usage, battery optimisation, and diagnostics:

### Fetch Frequency

To balance battery life with freshness, Magimail adjusts background feed checks based on power state:

- **On power adapter**: Choose a polling interval (`Every 30 seconds`, `Every minute`, `Every 2 minutes`, `Every 5 minutes`, or `Every 15 minutes`).
- **On battery**: Select a battery-conserving interval (`Every minute`, `Every 2 minutes`, `Every 3 minutes`, `Every 5 minutes`, `Every 10 minutes`, or `Every 15 minutes`).

### Memory

- **Unload inactive after**: Conserves system RAM by freezing background account web views that have not been viewed recently.
  - Options: `1 minute`, `5 minutes`, `10 minutes`, `30 minutes`, `1 hour`, or `Never`.
  - When an inactive tab is selected again, it restores instantly from memory or local cache without interrupting work.

### Diagnostics

**Collect Diagnostics…** writes an archive of application logs, system environment details and crash traces, with personal data removed, for a bug report. See [Diagnostics & Troubleshooting](/help/general/troubleshooting/).
