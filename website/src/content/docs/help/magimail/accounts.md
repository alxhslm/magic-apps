---
title: Multiple Accounts
description: How account isolation, switching and background memory management work in Magimail.
---

Magimail lets you run multiple Google accounts side by side without browser tab switching or profile switching.

## Adding Accounts

To add additional accounts:

1. Open **Preferences** with <kbd>⌘,</kbd>, or choose **Magimail → Preferences…** from the menu.
2. Select the **Accounts** tab.
3. Click the **+** (Add Account) button.
4. Sign in to your second Google account in the sheet.
5. Choose an account name and accent colour.

## Switching Accounts

You can switch between accounts instantly:

- **Toolbar Tabs**: Click the account tabs located in the top toolbar. Each tab shows the account name, assigned accent colour dot, and unread count.
- **Keyboard Shortcuts**: Press <kbd>⌘1</kbd> for your first account, <kbd>⌘2</kbd> for your second, and so on up to <kbd>⌘9</kbd>.
- **Menu Bar**: Select an account from the **Accounts** menu.

## Account Separation

Each account runs in its own session, so signing out of one, resetting it, or letting its Google session expire has no effect on the others. Accounts never share cookies, so your personal, work and client inboxes cannot leak into each other.

Each account also keeps its own label and accent colour, which is what tells you at a glance which inbox you are reading.

## Paused in the Background

An account you are not looking at is released after five minutes, which is what stops a second or third account from costing a second or third window's worth of memory. It keeps checking for mail and sending notifications while it is paused, and switching back reloads the inbox from the local cache.

**Settings → Advanced → Memory**, in the [Settings Reference](/help/magimail/settings/), changes the wait or turns it off.

## Working Offline

Gmail's own offline mode is what lets Magimail show unread counts and recent mail without a connection, and it has to be turned on once per account. [Getting Started](/help/magimail/getting-started/) has the steps.
