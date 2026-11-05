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

### Open links in

Which browser opens links that leave the app.

- **Only installed browsers are listed**, and the row macOS opens links with is marked `(default)`.
- **Every link uses the chosen browser**, so the account's Chromium profile applies to it.
- **Except the apps named in the link table**: Notion, Linear, Todoist, Figma, Slack, Asana, Loom,
  Miro and Dropbox links open in their desktop app, because those apps own the link.

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
- **Menu bar status**: Chooses what appears beside the icon.
  - `Menu bar icon only`: Just the Magimail glyph.
  - `Unread status dots`: One coloured dot per account, filled when that account has unread mail and ringed when it does not.
  - `Unread count`: One cell per account, in the account's colour, with a dimmed `0` for a quiet inbox.
    The item keeps its width as mail arrives or is read. [Menu Bar & Popover](/help/magimail/menu-bar/) shows examples of all three.
- **Show verification codes**: Toggles the hero card banner at the top of the menu bar popover whenever a one-time verification code arrives.
- **Keep in menu bar for**: Sets how long the verification code hero card remains pinned before expiring (`5 minutes`, `10 minutes`, `15 minutes`, or `30 minutes`).

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
