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
  Unwrap --> Route["openExternalUrl(url, account)<br/>(@magimail/core)"]
  Route --> Choice{"account.browser set<br/>and not system?"}
  Choice -->|no| Universal["shell.openExternal(unwrappedUrl)<br/>macOS LaunchServices"]
  Choice -->|yes| Direct["/usr/bin/open -b bundleId<br/>with --profile-directory"]
  Universal --> Resolution{"Desktop client installed<br/>for target domain?"}
  Resolution -->|Yes (Todoist, Notion, Linear, Figma, Slack)| App["Native Desktop Application<br/>(Apple Universal Links)"]
  Resolution -->|No / unknown domain| Browser["System Default Web Browser"]
  Direct --> Browser
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

When `shell.openExternal(unwrappedUrl)` passes a clean URL — which is what happens unless an
account names a browser, see below — LaunchServices resolves it:

1. **Installed application**: macOS hands the link directly to the native desktop application
   (such as Todoist for `app.todoist.com`, Notion for `notion.so`, or Linear for `linear.app`).
   No browser tab or interstitial window opens.
2. **Missing application or unassociated domain**: macOS routes the destination URL directly to
   the user's default web browser without passing through Google's tracking redirect page.

Because Universal Links are maintained by macOS LaunchServices per installed application,
supporting external tools requires no per-app custom schemes or individual user settings.

## Per-account browser and Chromium profile

Two Google accounts signed in to the same Chromium browser share nothing, and a Meet link that
lands in the wrong profile asks to be let in. An account can therefore name a browser
(`browser`) and, for Chromium, a profile directory (`browserProfile`) in `AccountConfig` in
`@magimail/core`. Both are optional; with neither, links take the `shell.openExternal` path
above and macOS decides.

`openExternalUrl` honours the pair by launching the browser itself:
`/usr/bin/open -b <bundleId> -n --args --profile-directory="<dir>" <url>`. The `-n` is not
optional: Chromium applies `--profile-directory` only to an instance it is starting, so an
already-running browser ignores the flag. The cost is a second instance, with its own dock
tile and window set, which is why the path is opt-in per account rather than the default.

Profiles are read from each browser's `Local State` (`profile.info_cache`), the one file
Chrome, Brave and Edge all write, which gives the directory name, the profile's display name
and the Google account signed into it. `_auto` matches that last field against the account's
email; an unmatched `_auto` falls back to the browser's `Default` profile. Safari has no
supported flag or URL scheme for profile targeting, so it is offered as a browser and nothing
more.

Each step degrades rather than fails: no resolved profile launches the browser without
`--profile-directory`, and a failed launch passes the URL to `shell.openExternal`. Handing the
URL to a browser we opened cannot leave it unopened.

The settings tab avoids asking a question the answer is already known for. `getDefaultBrowser`
reads the LaunchServices handler for `https`, and the tab marks that row `(default)` and
preselects it for any account that has not chosen. The picker therefore states which browser
links actually reach, and the profile row appears for the common case of a Chrome default. The
stored value stays unset, so the account keeps following the system default when it changes. A default browser outside `SUPPORTED_BROWSERS`
(Firefox, Arc) is reported as `other`: the row falls back to the system entry and the profile
picker stays hidden, since there is nothing to match it against.

## App-specific integration

- **Magimail**: Outbound links in `setWindowOpenHandler` and `will-navigate` in
  [`../magimail/overview.md`](../magimail/overview.md) unwrap redirectors and then call
  `openExternalUrl` with the account.
- **Magical**: Outbound links in event descriptions and tasks pass through `openExternalUrl` in
  `links.ts`. Magical also rewrites video conference links (Zoom and Microsoft Teams) to native
  custom schemes; see [`../magical/conference-links.md`](../magical/conference-links.md).
