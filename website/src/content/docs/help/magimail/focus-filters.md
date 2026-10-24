---
title: Focus Filters
description: Integrating Magimail with macOS Focus modes to quieten or block accounts.
---

Magimail supports native macOS Focus Filters, allowing you to automatically control email notifications and account visibility based on your active Focus mode (such as Work, Personal, or Sleep).

## Setting Up Focus Filters

1. Open macOS **System Settings → Focus**.
2. Select an existing Focus (e.g. **Work**) or create a new one.
3. Scroll down to **Focus Filters** and click **Add Filter**.
4. Choose **Magimail**.
5. Choose which accounts stay active during this Focus mode.
6. Optionally enable **Prevent Access to Silenced Accounts**:
   - When off, silenced accounts stop sending notifications and badge counts, but their tabs remain clickable if you manually navigate to them.
   - When on, silenced accounts are completely greyed out in the toolbar and switcher, preventing accidental temptation to check work emails during personal time.
7. Click **Add** to save the filter.

![Configuring Magimail Focus Filter in macOS System Settings](/assets/shot-focus.webp)

## How Focus Filters Behave

When a Focus mode activates:

- **Notifications**: Excluded accounts immediately stop sending alert banners and notification sounds.
- **Menu Bar & Widgets**: Silenced accounts are removed from the aggregate unread total and hidden from [menu bar previews](/help/magimail/menu-bar/) and [widgets](/help/magimail/widgets/).
- **In-App Indicator**: Magimail displays a subtle Focus badge showing that an active Apple Focus filter is currently applied.
