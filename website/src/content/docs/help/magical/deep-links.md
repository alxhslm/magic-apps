---
title: Deep Links & Automation
description: Using the magical:// URL scheme with Apple Shortcuts, Raycast, Alfred, and opening external links in native desktop apps.
---

Magical registers the native macOS `magical://` URL scheme, allowing you to trigger navigation, open the new event composer, search events, or RSVP to meetings from Apple Shortcuts, Raycast, Alfred, or terminal scripts.

## Supported Actions & Parameters

| URL Pattern           | Parameters                       | Description                                                                             |
| :-------------------- | :------------------------------- | :-------------------------------------------------------------------------------------- |
| `magical://open`      | _None_                           | Brings the main Magical calendar window to the front.                                   |
| `magical://quick-add` | _None_                           | Opens the event creation modal (prompts for account if configured to 'Always ask').     |
| `magical://date`      | `at`, `account`                  | Navigates the calendar to a specific date (e.g. `2026-11-01`).                          |
| `magical://search`    | `q` or `query`, `account`        | Searches events and meetings across your schedules.                                     |
| `magical://event`     | `eid`, `account`, `action`, `at` | Focuses an event or executes an RSVP action (`reveal`, `yes`, `no`, `maybe`, `delete`). |

:::tip[Headless background RSVPs]
When a meeting link carries an RSVP action (`action=yes`, `action=no` or `action=maybe`), Magical records your response in the background without raising the main window. It is the same answer a banner gives; [Meeting Alerts & Invitations](/help/magical/notifications/) covers what happens to the invitation afterwards.
:::

## Examples

### Open New Event Composer

```sh
open "magical://quick-add"
```

### Jump to a Specific Date

```sh
open "magical://date?at=2026-11-01"
```

### Accept an Invitation Headlessly

```sh
open "magical://event?eid=abc123xyz&action=yes&account=work"
```

### Search Upcoming Meetings

```sh
open "magical://search?q=Dentist"
```

## Using Deep Links in Automations

### Apple Shortcuts

1. Open the **Shortcuts** app on macOS.
2. Create a new shortcut and add the **Open URL** action.
3. Enter your formatted `magical://` link (such as `magical://quick-add`).
4. Bind this shortcut to a global hotkey or macOS menu bar item.

### Raycast & Alfred

- In **Raycast**, create a **Quicklink** with the URL `magical://search?q={query}` to query Google Calendar instantly from your launcher.
- In **Alfred**, create a keyword trigger to launch `magical://quick-add`.

## Opening Links in Desktop Apps

Event descriptions and Google Tasks frequently include links to external tools such as Todoist, Notion, Linear, Figma, or Slack.

Magical strips Google's redirect prefix from outbound links so they open directly in their native macOS desktop apps when installed, or in your default browser when not.

:::tip[Video conference calls]
Meeting links for Zoom and Microsoft Teams also open in their native desktop apps when installed. If you prefer to join meetings in your browser, turn on **Always open calls in the browser** in **Settings → Notifications**. See [Settings Reference](/help/magical/settings/).
:::
