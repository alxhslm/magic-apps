# Third-party integrations

Event descriptions, task bodies and meeting invitations frequently contain links to external
tools, such as task managers (Todoist, Linear, Notion) and video conference providers (Zoom, Microsoft Teams).
Google Calendar wraps outbound links in redirectors (`https://www.google.com/url?q=...`), and
invitations routed through Exchange carry Outlook Safelinks. These tracking wrappers prevent macOS
from recognising the destination domain and break Apple Universal Links.

Magical unifies external link handling in `openExternalUrl` in `links.ts`, unwrapping redirectors
before dispatch so desktop clients and conference handlers receive direct URLs.

```mermaid
flowchart TD
  Trigger["External link trigger<br/>(window.open, will-navigate, joinCall)"] --> Open["openExternalUrl(url)"]
  Open --> Unwrap["unwrapRedirectors(url)<br/>(strips Google redirectors & Safelinks)"]
  Unwrap --> CallCheck{"Conference call link and<br/>alwaysJoinInBrowser off?"}
  CallCheck -->|Yes| RewriteMeeting["toNativeMeetingUrl(url)<br/>(zoommtg://, msteams://)"]
  CallCheck -->|No| Universal["shell.openExternal(unwrappedUrl)<br/>macOS Universal Links"]
  RewriteMeeting --> LSCheck{"hasApplicationForUrl<br/>(LaunchServices check)"}
  LSCheck -->|Yes| LaunchNative["shell.openExternal(nativeUrl)<br/>Desktop Application"]
  LSCheck -->|No| Universal
  LaunchNative -->|Throws / refused| Universal
  Universal --> Resolution{"Desktop client installed<br/>for target domain?"}
  Resolution -->|Yes (e.g. Todoist, Notion, Linear)| App["Desktop Application"]
  Resolution -->|No| Browser["Default Web Browser"]
```

## Desktop apps via Universal Links

macOS resolves Apple Universal Links for applications that register domain associations
(`apple-app-site-association`). By stripping Google's outbound tracking redirector, Magical restores
Universal Links resolution across third-party productivity tools:

- **Todoist**: Links to tasks (`https://app.todoist.com/app/task/<id>`) and projects
  (`https://app.todoist.com/app/project/<id>`) open in Todoist for Mac when installed.
- **Notion, Linear, Figma, Slack**: Outbound links to these services resolve to their native macOS
  desktop applications.
- **Missing clients**: When a native client is not installed, macOS falls back to loading the page
  in the user's default browser with no interstitial Google redirect.

Because macOS manages Universal Links dynamically per domain, third-party desktop tools require no
bespoke URL schemes or application-specific toggles.

## Video conference schemes

Unlike modern web tools using Universal Links, video conferencing platforms rely on custom URL schemes:

| Provider            | Web URL pattern                                | Native URL scheme                                      | Preference                             |
| :------------------ | :--------------------------------------------- | :----------------------------------------------------- | :------------------------------------- |
| **Zoom**            | `zoom.us/j/<id>`<br/>`zoom.us/w/<id>`          | `zoommtg://zoom.us/join?action=join&confno=<id>&pwd=…` | `alwaysJoinInBrowser` (off by default) |
| **Microsoft Teams** | `teams.microsoft.com/…`<br/>`teams.live.com/…` | `msteams://…`                                          | `alwaysJoinInBrowser` (off by default) |

### Zoom

`toNativeMeetingUrl` rewrites Zoom web join links (`zoom.us/j/<id>` and `zoom.us/w/<id>`) into
`zoommtg://zoom.us/join?action=join&confno=<id>`. When the original URL contains a password query
parameter (`?pwd=…`), it is extracted and appended as `&pwd=…` so joining does not prompt for a
passcode.

Conference discovery and join controls across the tray and notifications are documented in
[`conference-links.md`](conference-links.md).

### Microsoft Teams

`toNativeMeetingUrl` rewrites Teams meeting links on `teams.microsoft.com` and `teams.live.com` by
substituting the `https://` prefix with `msteams://`. Non-meeting paths (such as `meetingOptions/` or
dial-in numbers) are excluded by conference resolution before reaching the rewrite stage.

Conference discovery and join controls are documented in
[`conference-links.md`](conference-links.md).

## LaunchServices verification and fallback

macOS LaunchServices maintains handler registrations per custom URL scheme. Launching an unregistered
custom URL scheme directly causes macOS to display an error modal ("There is no application set to open
the URL"). Magical verifies custom meeting schemes before dispatching:

1. **Pre-flight check**: `hasApplicationForUrl` in `native-handlers.ts` queries the native C++ addon
   bridge (`NSWorkspace.URLForApplicationToOpenURL:`). Results are memoised per scheme for the
   duration of the application session, avoiding redundant LaunchServices lookups.
2. **Missing client fallback**: When LaunchServices reports no registered application, `openExternalUrl`
   dispatches the unwrapped web URL to open the system default browser.
3. **Launch failure fallback**: An application registration can outlive the bundle it points to. If
   `shell.openExternal(nativeUrl)` throws or is refused, `openExternalUrl` catches the error and
   falls back to opening the unwrapped web URL in the browser.

## User settings

Meeting schemes are configurable in Magical Settings:

- **Always open calls in the browser**: Key `alwaysJoinInBrowser` (boolean, default: `false`). Located
  under **Joining calls** in the settings window. When enabled, Zoom and Teams links bypass native
  scheme rewriting and open directly in the browser.
- **Helper IPC**: Toggling the control sends a `settings.changed` notification over JSON-RPC from the
  Swift helper to the Electron main process, persisting the change to `settings.json` immediately.
