---
title: Deep Links & Automation
description: Using the magimail:// URL scheme with Apple Shortcuts, Raycast, Alfred, and opening external links in native desktop apps.
---

Magimail registers the native macOS `magimail://` URL scheme, allowing you to trigger navigation, compose drafts, search inboxes, and execute triage actions from Apple Shortcuts, Raycast, Alfred, Stream Deck buttons, terminal scripts, or custom web links.

## Supported Actions & Parameters

| URL Pattern              | Parameters                              | Description                                                                                     |
| :----------------------- | :-------------------------------------- | :---------------------------------------------------------------------------------------------- |
| `magimail://inbox`       | `account`                               | Focuses Magimail and opens the inbox for the specified account.                                 |
| `magimail://compose`     | `to`, `su`, `body`, `account`           | Opens a compose window pre-filled with recipient, subject, and body text.                       |
| `magimail://share`       | `files` (repeated), `text`, `url`, `to` | Opens a compose window with attached files staged from Finder or external scripts.              |
| `magimail://search`      | `q` or `query`, `account`               | Runs a search query directly in Gmail.                                                          |
| `magimail://thread/<id>` | `account`, `action`                     | Opens the thread, or executes an action (`open`, `archive`, `trash`, `markRead`, `markUnread`). |

:::tip[Headless background triage]
When a deep link includes a triage action such as `action=archive`, `action=trash` or `action=markRead`, Magimail applies the change in the background without opening the main window or taking focus from the app you are in.
:::

## Examples

### Compose an Email with Pre-filled Details

```sh
open "magimail://compose?to=team@example.com&su=Weekly%20Update&body=Hi%20team,%0A%0AHere%20is%20the%20report."
```

### Search an Account's Inbox

```sh
open "magimail://search?q=is:unread%20from:github&account=work"
```

### Archive a Thread in the Background

```sh
open "magimail://thread/18fa24b91ac051?action=archive"
```

## Using Deep Links in Automations

### Apple Shortcuts

1. Open the **Shortcuts** app on macOS.
2. Create a new shortcut and add the **Open URL** action.
3. Enter your formatted `magimail://` link (for example, `magimail://inbox?account=work`).
4. Assign a global keyboard shortcut in the shortcut details pane.

### Raycast & Alfred

- In **Raycast**, create a **Quicklink** with the URL `magimail://search?q={query}` to search Gmail directly from your command bar.
- In **Alfred**, create a **Web Search** keyword configured to open `magimail://compose?to={query}`.

## Opening Links in Desktop Apps

Emails frequently include links to external tools such as Todoist, Notion, Linear, Figma, GitHub, or Slack.

When you click an external link inside Magimail:

1. **Tracking redirects are unwrapped.** Gmail wraps outbound links in `https://www.google.com/url?q=...`. Magimail unwraps the redirect before opening the URL, recovering the direct address.
2. **Installed desktop apps open directly.** macOS routes recognised web URLs to their native desktop applications through Apple Universal Links. When you have the matching app installed on your Mac, it opens without raising a browser tab.
3. **Other links open in your default browser.** If no desktop app handles the address, Magimail passes the unwrapped link to your default web browser.
