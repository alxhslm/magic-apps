# Deep links

Magimail handles custom URL schemes via `magimail://` and system `mailto:`. The shared protocol
registration, cold-start buffering, and second-instance architecture are documented in
[`../shared/deep-links.md`](../shared/deep-links.md).

A cold launch from one of these links opens the account the link names; without a link the last active
account is restored. See
[`../shared/deep-links.md#cold-launch-account-selection`](../shared/deep-links.md#cold-launch-account-selection).

## Route taxonomy

| Route                    | Parameters                         | Action performed                                           |
| :----------------------- | :--------------------------------- | :--------------------------------------------------------- |
| `magimail://inbox`       | `account`                          | Focuses main window and switches to account inbox.         |
| `magimail://thread/<id>` | `account`, `action`                | Opens the thread, or triages it where `action` specifies.  |
| `magimail://search`      | `q`, `query`, `account`            | Runs Gmail search query or focuses search in target view.  |
| `magimail://compose`     | `account`, `to`, `su`, `body`      | Launches compose pop-out or triggers in-window compose.    |
| `magimail://share`       | `files`, `text`, `url`, `to`, `su` | Opens compose window and synthesises file drop attachment. |

### Inbox (`magimail://inbox`)

Focuses the main window and activates the specified account:

```text
magimail://inbox?account=work-account
```

If `account` is omitted, the currently active account remains selected.

### Thread navigation and triage (`magimail://thread/<id>`)

Opens a specific thread or executes a triage action on it:

```text
magimail://thread/18fa24b91ac051?account=work-account&action=open
```

- **`action`**: Defaults to `open`. Accepts `open`, `archive`, `trash`, `markRead`, and `markUnread`.
- **Focus behaviour**: Only `open` focuses the window. Triage actions execute in the target account view
  without raising or focusing the window, allowing non-disruptive background triage from scripts or
  shortcuts.
- An unrecognized action is logged and ignored rather than falling back to `open`.

### Search (`magimail://search`)

Navigates the target account to a Gmail search query:

```text
magimail://search?q=from%3Aboss%20is%3Aunread&account=work-account
```

- **`q`** or **`query`**: Search terms to execute. Loads `https://mail.google.com/mail/u/0/#search/<query>`.
- If `q` is empty or omitted, Magimail switches to the account (if specified) and focuses the search field
  in the active view.

### Compose (`magimail://compose`)

Activates email composition:

- With `account`: switches to the account and triggers the in-window compose shortcut or detached compose.
- Without `account`: prompts with the native compose account picker.

### Share Extension (`magimail://share`)

Invoked by the macOS Share extension (`MagimailShare.appex`) to hand staged attachments and shared text to
Electron Main. See [`share-and-handlers.md`](share-and-handlers.md) for full payload specification and file
security checks.

## Outbound links

External links clicked in email bodies, detached thread views, and compose popouts are intercepted by
`setWindowOpenHandler` and `will-navigate` in `accounts-manager.ts` and `compose.ts`. Magimail unwraps
Google tracking redirectors via `@magimail/core`, routing recognised destinations to native desktop
applications (such as Todoist, Notion, Linear, Figma, and Slack) via macOS Universal Links. See
[`../shared/third-party-links.md`](../shared/third-party-links.md).
