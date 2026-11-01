# Third-party desktop links

Event bodies, Google Tasks and emails frequently contain links to external productivity tools,
such as task managers (Todoist), issue trackers (Linear), notes (Notion), design tools (Figma)
and team chat (Slack).

Google wraps outbound links in tracking redirectors (`https://www.google.com/url?q=...`), and
invitations or emails forwarded through Microsoft 365 carry Outlook Safelinks. These tracking
redirectors break Apple Universal Links because macOS checks only the outer `google.com` or
`safelinks.protection.outlook.com` domain.

Both Magimail and Magical unwrap tracking redirectors via `@magimail/core` before dispatching
external URLs to macOS.

```mermaid
flowchart TD
  Trigger["External link click<br/>(email body, event description, task)"] --> Unwrap["unwrapRedirectors(url)<br/>(@magimail/core)"]
  Unwrap --> Universal["shell.openExternal(unwrappedUrl)<br/>macOS LaunchServices"]
  Universal --> Resolution{"Desktop client installed<br/>for target domain?"}
  Resolution -->|Yes (Todoist, Notion, Linear, Figma, Slack)| App["Native Desktop Application<br/>(Apple Universal Links)"]
  Resolution -->|No / unknown domain| Browser["System Default Web Browser"]
```

## Redirector unwrapping in `@magimail/core`

`unwrapRedirectors` in `@magimail/core` (`packages/core/src/links.ts`) recursively strips known
tracking and protection wrappers up to three hops:

- **Google outbound redirectors**: URLs matching `google.com/url` or `*.google.com/url` extract the
  destination URL from the `q` or `url` query parameter.
- **Outlook Safelinks**: URLs matching `safelinks.protection.outlook.com` extract the target URL from
  the `url` query parameter.
- **Direct URLs**: URLs without tracking parameters or unrecognised hosts pass through untouched.

## Desktop app dispatch via Apple Universal Links

macOS routes HTTP and HTTPS URLs to installed native applications that register domain associations
via `apple-app-site-association` (Universal Links).

When `shell.openExternal(unwrappedUrl)` passes a clean URL:

1. **Installed application**: macOS hands the link directly to the native desktop application
   (such as Todoist for `app.todoist.com`, Notion for `notion.so`, or Linear for `linear.app`).
   No browser tab or interstitial window opens.
2. **Missing application or unassociated domain**: macOS routes the destination URL directly to
   the user's default web browser without passing through Google's tracking redirect page.

Because Universal Links are maintained by macOS LaunchServices per installed application,
supporting external tools requires no per-app custom schemes or individual user settings.

## App-specific integration

- **Magimail**: Outbound links in `setWindowOpenHandler` and `will-navigate` in
  [`../magimail/overview.md`](../magimail/overview.md) unwrap redirectors before calling `shell.openExternal`.
- **Magical**: Outbound links in event descriptions and tasks pass through `openExternalUrl` in
  `links.ts`. Magical also rewrites video conference links (Zoom and Microsoft Teams) to native
  custom schemes; see [`../magical/conference-links.md`](../magical/conference-links.md).
