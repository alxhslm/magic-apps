---
title: Focus Filters
description: Filtering calendars and quieting notifications during macOS Focus modes.
---

Magical integrates with macOS Focus Filters to automatically tailor your schedule, meeting alerts, and menu bar indicators to your current context.

## Setting Up Focus Filters

1. Open macOS **System Settings → Focus**.
2. Click on a Focus mode (e.g. **Work** or **Personal**).
3. Under **Focus Filters**, click **Add Filter**.
4. Choose **Magical**.
5. Choose which accounts stay on, then which of their calendars matter. An account you turn off takes every calendar it has with it, and the calendars under an account you leave on are still individually switchable.
6. Optionally toggle **Prevent Access to Silenced Accounts**:
   - When off, silenced accounts stop firing notifications and countdowns, but you can still click their tabs if needed.
   - When on, silenced accounts are greyed out in the toolbar and switcher until the Focus mode ends.
7. Click **Add** to save.

![Configuring Magical Focus Filter in macOS System Settings](/assets/shot-focus-magical.webp)

## How Focus Filters Behave

When your Focus turns on:

- **Notification Suppression**: Events on silenced calendars will not trigger [alert banners](/help/magical/notifications/), full-screen notifications or chimes.
- **Menu Bar Countdown**: The [menu bar](/help/magical/menu-bar/) countdown and next-event title ignore silenced calendars, focusing only on relevant events (e.g. personal commitments during personal hours).
- **Widgets**: [Desktop widgets](/help/magical/widgets/) filter out events belonging to silenced accounts.
- **In-App Indicator**: A subtle Focus indicator appears in Magical's window confirming that an Apple Focus filter is active.
