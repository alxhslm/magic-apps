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

## Browser and Chromium profile

Two Google accounts signed in to the same Chromium browser share nothing, and a Meet link that
lands in the wrong profile asks to be let in. An account can therefore name a Chromium profile,
and the app a browser, for every link that leaves it.

| Setting                            | Where    | Answers                          |
| :--------------------------------- | :------- | :------------------------------- |
| `openLinksIn` (`settings.json`)    | General  | Which browser opens a link       |
| `browserProfile` (`accounts.json`) | Accounts | Which Google session it opens in |

### The one exception: apps we name

Applying a profile means starting the browser ourselves, and that is what stops macOS handing a URL
to the desktop app that claims its domain. The resolution happens inside `swcd` at open time and
cannot be asked for in advance: `LSCopyDefaultApplicationURLForURL`, `LSCopyApplicationURLsForURL`,
`NSWorkspace.urlForApplication(toOpen:)`, `app.getApplicationInfoForProtocol` and `/usr/bin/open`
all answer with a browser for a domain that `shell.openExternal` then gives to its app, and
`swcutil` knows but needs root.

So the table in `packages/core/src/app-links.json` names the domains whose links belong to an app:
Notion, Linear, Todoist, Figma, Slack, Asana, Loom, Miro, Dropbox. A link to one of them is handed
over with `open -b <bundleId> <url>`; every other link goes to the chosen browser with the account's
profile. An app that refuses the URL falls back to the browser rather than leaving the link
unopened.

Adding an app is one object: a name, a bundle id, and the hosts it owns. A domain missing from the
table is not broken, it opens in the browser with the right profile, which is where links went
before the table existed. Google's own domains are absent on purpose: a Drive or Docs link has to
keep the account's profile.

### Resolving a profile

Profiles come from each browser's `Local State` (`profile.info_cache`), the one file Chrome, Brave
and Edge all write: directory name, display name, and the Google account signed in. An account's
`browserProfile` is `_auto` (the default), `_none`, or a profile directory.

`_auto` means the profile signed in as the account's address, and nothing more: where no profile
carries that address the answer is `null`, which leaves `--profile-directory` off the launch line
so the browser uses whatever window it already has. `accounts.json` did not carry an address at
all, so each app reads it from Google's account chip once the page settles
(`ACCOUNT_EMAIL_SCRIPT` and `readAccountEmail` in `account-email.ts`) and treats the answer as
input rather than fact before storing it.

### Launching

`/usr/bin/open -b <bundleId> -n --args --profile-directory="<dir>" <url>`, because Chromium reads
`--profile-directory` only when it is starting. When the resolved profile is already the open one
the flag is dropped and a plain `-b` reuses that window. A failed launch falls back to
`shell.openExternal`.

## App-specific integration

- **Magimail**: Outbound links in `setWindowOpenHandler` and `will-navigate` in
  [`../magimail/overview.md`](../magimail/overview.md) unwrap redirectors and then call
  `openExternalUrl` with the account.
- **Magical**: Outbound links in event descriptions and tasks pass through `openExternalUrl` in
  `links.ts`. Magical also rewrites video conference links (Zoom and Microsoft Teams) to native
  custom schemes; see [`../magical/conference-links.md`](../magical/conference-links.md).
