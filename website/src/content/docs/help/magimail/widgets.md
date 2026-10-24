---
title: Desktop Widgets
description: Adding and configuring native macOS desktop and Notification Centre widgets for Gmail unread counts and recent threads.
---

Magimail includes native desktop widgets. They show the same mail the [menu bar popover](/help/magimail/menu-bar/) does, drawn from the copy of your inbox kept on this Mac.

## Available Widget Layouts

Magimail provides four widget sizes:

1. **Unread (Small)**:
   - Displays total unread count across all connected accounts with Magimail brand mark styling.
   - Clicking the widget opens Magimail straight to your inbox (`magimail://inbox`).
2. **Quick Actions (Medium)**:
   - Shows an unread breakdown per account with each account's custom colour indicator.
   - Includes 1-tap quick compose buttons for each account.
3. **Recents (Medium)**:
   - Lists recent email threads with sender names, subject lines, timestamps, and read/unread indicators.
4. **Dashboard (Large)**:
   - Combines an unread count summary across all accounts with a detailed list of the latest incoming message threads.

![Magimail desktop widgets in small, medium, and large sizes on macOS desktop](/assets/shot-widgets.webp)

## Adding & Configuring Widgets

You can place and configure widgets directly on your desktop or in Notification Centre:

1. Right-click any open space on your desktop and select **Edit Widgets…** (or open Notification Centre and click **Edit Widgets** at the bottom).
2. Locate **Magimail** in the widget gallery and drag your preferred size onto your desktop or into Notification Centre.
3. **Configuring Recents & Dashboard Widgets**:
   - Right-click the placed widget on your desktop.
   - Select **Edit "Magimail"…**.
   - Toggle **Unread only**:
     - _Off (default)_: Shows the latest incoming threads regardless of whether they have already been read.
     - _On_: Filters the list strictly to threads awaiting your attention.
4. **Instant Background Sync**:
   - Widgets read the copy of your mail Magimail keeps on this Mac, so they draw before a connection is made.
   - When you archive, read or receive a message, the app tells its widgets at once and they redraw with it.
