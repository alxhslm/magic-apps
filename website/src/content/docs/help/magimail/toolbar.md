---
title: Window Toolbar
description: Customising buttons, search, and native message actions in the macOS toolbar.
---

Magimail embeds Gmail within a native macOS toolbar that follows Apple platform standards, providing quick access to multi-account navigation, search and message triage.

![Magimail window toolbar showing account switcher, compose, share, and print controls](/assets/shot-toolbar.webp)

## Toolbar Arrangement & Default Set

By default, Magimail arranges the toolbar with:

- **Account Switcher**: Fixed on the far left, showing your connected Google accounts with profile initials, colour accents, and live unread badges. Click any account tab or press <kbd>⌘1</kbd>–<kbd>⌘9</kbd> to switch accounts instantly.
- **Flexible Space**: Keeps your message actions comfortably separated from account tabs.
- <span class="sym sym-compose" aria-hidden="true"></span> **Compose**: Opens a new compose draft (<kbd>⌘N</kbd>).
- **Share Item**: Opens macOS system sharing options for the currently selected message or thread URL.
- **Print Item**: A dedicated menu button offering **Print…** (<kbd>⌘P</kbd>) and **Export as PDF…**.

The switcher on the left is the same account list as [Multiple Accounts](/help/magimail/accounts/), which covers what each account keeps separate.

## Customising Toolbar Buttons

You can tailor which buttons appear in the Magimail window header:

1. Right-click any empty area of the window toolbar, or choose **View → Customise Toolbar…** from the menu bar.
2. The native customisation palette drops down with the full list of available items:
   - **Account Switcher**: Fixed to the leading edge (immovable).
   - **Compose**: Open a new email draft (<kbd>⌘N</kbd>).
   - **Search Field**: Native search field with Google search operator completion.
   - **Archive**: Archive selected threads immediately.
   - **Delete**: Move selected messages to Trash.
   - **Mark Read / Unread**: Toggle read state for selected threads.
   - <span class="sym sym-reply" aria-hidden="true"></span> **Reply**: Draft a reply to the sender.
   - <span class="sym sym-reply-all" aria-hidden="true"></span> **Reply All**: Reply to all participants on the active thread.
   - <span class="sym sym-forward" aria-hidden="true"></span> **Forward**: Forward the active message.
   - **Manage Group**: A compact 3-in-1 segmented control combining **Archive**, **Delete**, and **Toggle Read**.
   - **Reply Group**: A compact segmented control combining **Reply**, **Reply All**, and **Forward**.
   - **Print Item**: Dropdown menu for printing or generating a clean PDF.
   - **Share Item**: Standard macOS Share picker.
   - **Space & Flexible Space**: Spacing elements to group or align buttons across the window.
3. Drag buttons into or out of the toolbar to match your triage workflow.
4. To reset to the original arrangement, drag the **Default Set** row onto the toolbar.
5. Click **Done** to save your changes.

## Trackpad & Mouse Navigation

Moving back and forward through your email history uses the same gestures as the rest of macOS:

- **Trackpad Two-Finger Swipes**: Swipe two fingers right across your trackpad to step **Back** (for example, jumping out of an opened email back into your inbox). Swipe two fingers left to step **Forward**.
- **Mouse Side Buttons**: If you use an external mouse with side buttons (Buttons 4 and 5), pressing the back button takes you back to your previous view, and pressing forward moves you forward.
- **Keyboard Shortcuts**: You can also press <kbd>⌘[</kbd> to go back and <kbd>⌘]</kbd> to go forward.
- **Mouse Wheel Behaviour**: A horizontal flick on an external mouse wheel smoothly scrolls message content horizontally rather than accidentally navigating back, which would lose your place.

## Native Search Bar

When the search bar is placed in your toolbar:

- Click the search box to focus it, and press <kbd>Esc</kbd> to clear it.
- Type any standard Gmail search operator (e.g. `from:taylor is:unread`, `has:attachment filename:pdf`, `larger:10M`).
- Press <kbd>Return</kbd> to run the query in the account the window is showing.
- <kbd>⌥⌘F</kbd> (**Edit → Find → Search Mailbox**) puts the caret in Gmail's own search box instead, which is the field Gmail's filter chips and suggestions belong to.
