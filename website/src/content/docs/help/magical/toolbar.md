---
title: Window Toolbar
description: Customising calendar navigation, the Invitations Tray, and quick actions in the native macOS toolbar.
---

Magical wraps Google Calendar in a native macOS toolbar. It provides platform-standard date navigation, pending invitation management and quick event creation without relying on web page buttons.

![The Customise Toolbar sheet, with date navigation, invitations, task and search items ready to drag into place](/assets/shot-toolbar-magical.webp)

## Toolbar Arrangement & Default Set

By default, the Magical toolbar contains:

- **Account Switcher**: Immovable on the far left, showing initials and unread invitation badges for each connected Google account. Press <kbd>⌘1</kbd>–<kbd>⌘9</kbd> to jump between accounts.
- **Flexible Space**: Distributes controls cleanly across your window.
- **Calendar Navigation Control (`< Today >`)**:
  - <span class="sym sym-chevron-left" aria-hidden="true"></span> Moves back one period (previous day, week, or month depending on your active calendar view).
  - `Today`: Immediately centres the view on today's schedule.
  - <span class="sym sym-chevron-right" aria-hidden="true"></span> Moves forward one period into upcoming dates.
- <span class="sym sym-tray" aria-hidden="true"></span> <span class="sym sym-tray-full" aria-hidden="true"></span> **Invitations Tray**: Carries a count of the invitations awaiting your reply, and opens a menu listing them with 1-click **Accept**, **Maybe**, **Decline**, **Mark as Read** and **Open in Calendar**. See [Invitation Tray](/help/magical/invitation-tray/).
- <span class="sym sym-circle-badge-plus" aria-hidden="true"></span> **New Task**: Opens Google Calendar's new-task field for the account the window is showing. See [Google Tasks](/help/magical/tasks/).
- <span class="sym sym-calendar-badge-plus" aria-hidden="true"></span> **New Event**: Opens the event creation modal (<kbd>⌘N</kbd>).

:::note
The navigation control is dimmed while you are viewing Google Tasks, which have no day, week or month to step through. See [Google Tasks](/help/magical/tasks/).
:::

## Customising Toolbar Buttons

You can tailor which controls appear in the Magical window:

1. Right-click any blank area of the toolbar, or choose **View → Customise Toolbar…** from the menu bar.
2. The customisation sheet drops down with all available items:
   - **Account Switcher**: Pinned to the left (immovable).
   - **Navigation Group (`< Today >`)**: Date period switcher and Today jump.
   - **Invitations Tray**: Live badge and RSVP dropdown.
   - **New Event Button**: Rapid calendar event composer.
   - **New Task Button**: Instant Google Task creation. See [Google Tasks](/help/magical/tasks/).
   - **Search Field**: Native search field for calendar events.
   - **Space & Flexible Space**: Spacing elements to arrange items.
3. Drag items into the toolbar, or drag unwanted items off the bar until they poof.
4. Drag the **Default Set** from the bottom to reset at any time.
5. Click **Done** to save your layout.

## Trackpad & Mouse Navigation

Magical separates date browsing from history navigation:

- **Trackpad Two-Finger Swipes**: Swiping horizontally with two fingers across your trackpad advances or rewinds your calendar dates:
  - Swipe two fingers **right**: Glides to the **Previous Period** (yesterday, last week, or last month).
  - Swipe two fingers **left**: Glides to the **Next Period** (tomorrow, next week, or next month).
- **Horizontal Mouse Wheel**: Flicking the tilt wheel left or right on an external mouse similarly shifts your calendar period forward or backward without touching the keyboard.
- **Mouse Side Buttons (Back & Forward)**: Unlike date swiping, your mouse side buttons handle **navigation history**:
  - Pressing the **Back** side button steps back out of the event creation modal, dismisses an active search query, or returns you to your previous schedule after jumping to a date from a deep link.
  - Pressing the **Forward** side button traverses forward through your navigation trail.
- **Keyboard Equivalents**: Press <kbd>K</kbd> or <kbd>P</kbd> for Previous Period, <kbd>J</kbd> or <kbd>N</kbd> for Next Period, and <kbd>T</kbd> to return to Today. <kbd>⌘[</kbd> and <kbd>⌘]</kbd> move back and forward through history, as they do everywhere else on the Mac.

## Native Search Bar

When the search field is placed in your toolbar:

- Click the field to focus it, and press <kbd>Esc</kbd> to clear it.
- Type what you are looking for: an event name, an attendee, a room or a location. Google Calendar's own search rules apply.
- Press <kbd>Return</kbd> to open Google Calendar's search results for the account the window is showing.
- <kbd>⌥⌘F</kbd> (**Edit → Find → Search Calendar**) opens the same search from the keyboard.
