# Third-party integrations

Event descriptions, task bodies and meeting invitations frequently contain links to external
tools, such as task managers (Todoist, Linear, Notion) and video conference providers (Zoom, Microsoft Teams).

Magical unifies external link dispatch in `openExternalUrl` in `links.ts`, unwrapping redirectors
via `@magimail/core` before dispatch so desktop clients and conference handlers receive direct URLs.
The shared redirector unwrapping and Universal Links resolution mechanism is documented in
[`../shared/third-party-links.md`](../shared/third-party-links.md).

```mermaid
flowchart TD
  Trigger["External link trigger<br/>(window.open, will-navigate, joinCall)"] --> Open["openExternalUrl(url)"]
  Open --> Unwrap["unwrapRedirectors(url)<br/>(@magimail/core)"]
  Unwrap --> CallCheck{"Conference call link and<br/>alwaysJoinInBrowser off?"}
  CallCheck -->|Yes| RewriteMeeting["toNativeMeetingUrl(url)<br/>(zoommtg://, msteams://)"]
  CallCheck -->|No| Universal["shell.openExternal(unwrappedUrl)<br/>macOS Universal Links"]
  RewriteMeeting --> LSCheck{"hasApplicationForUrl<br/>(LaunchServices check)"}
  LSCheck -->|Yes| LaunchNative["shell.openExternal(nativeUrl)<br/>Desktop Application"]
  LSCheck -->|No| Universal
  LaunchNative -->|Throws / refused| Universal
  Universal --> Resolution{"Desktop client installed<br/>for target domain?"}
  Resolution -->|Yes (apps supporting deep links<br/>including Todoist, Notion, etc.)| App["Desktop Application"]
  Resolution -->|No| Browser["Default Web Browser"]
```

## Desktop apps via Universal Links

Outbound tracking redirectors are unwrapped using `unwrapRedirectors` from `@magimail/core`.
macOS then resolves Apple Universal Links directly to installed desktop apps (such as Todoist,
Notion, Linear, Figma, and Slack), falling back to the default web browser when the application
is not installed. See [`../shared/third-party-links.md`](../shared/third-party-links.md) for the
shared architecture.

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
