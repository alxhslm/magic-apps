---
name: capturing-website-shots
description: Capture the website screenshots that need the running app. Use when the frame contains Google's own page, the native toolbar, the system Share sheet, a notification banner, the Dock or System Settings, so the shot cannot be rendered from code.
---

# Capturing the website's shots

The site's images come from two places. `tools/shots` draws everything the project paints
itself, from invented data, with no account and no app running;
[`rendering-website-shots`](../rendering-website-shots/SKILL.md) covers that half and is the
one to prefer. This covers the rest: the shots that need Magimail installed, signed in and
on screen.

What decides the half is what is in the frame. If the project paints every pixel, it is drawn.
If Google's own page, the system Share sheet or a banner is in the frame, it is captured here. So is
System Settings — except the Focus Filter pane, which System Settings draws from the app's own
intent; `tools/shots` stands in for that one, and
[`rendering-website-shots`](../rendering-website-shots/SKILL.md) says why.

| File                                                                                             | In the frame                                                  |
| :----------------------------------------------------------------------------------------------- | :------------------------------------------------------------ |
| `shot-window-light`, `shot-window-dark`, `shot-window-magical-light`, `shot-window-magical-dark` | Gmail and Calendar under the injected theme, both appearances |
| `shot-hero`                                                                                      | The window on the front page                                  |
| `shot-toolbar`                                                                                   | The native `NSToolbar` over Gmail                             |
| `shot-toolbar-magical`                                                                           | The native `NSToolbar` customisation sheet over Calendar      |
| `shot-share`                                                                                     | The system Share sheet                                        |
| `shot-notification`, `shot-notification-magical`                                                 | A banner, which belongs to `NotificationCenter`               |
| `shot-dock`, `shot-dock-magical`                                                                 | The macOS Dock with live app tile and badge                   |

`shot-popover`, `shot-popover-magical`, `shot-widgets`, `shot-widgets-magical`, `shot-tasks-magical`,
`shot-focus` and `shot-focus-magical` are rendered in `tools/shots`.

## One account is enough

Sign in as the demo account only. Showing several accounts needs no second sign-in: the
switcher in the toolbar is a real `NSSegmentedControl` that `ToolbarManagerBase` configures
from an account list, and `packages/swift-native` already exports `SuiteNative` as a library
product, so it can be drawn from invented accounts the way the popover is. Draw that shot
rather than signing a second mailbox in and then keeping it alive.

`website/README.md` holds the content rules: fictional correspondence on `example.com`, and
no real address anywhere in the frame, including in a settings pane behind a sheet.

## Capturing windows

Install before capturing. The installed bundles in `/Applications` are what get photographed;
a TypeScript or Swift change not yet built with `pnpm run magimail:install` or
`pnpm --filter magical run app:install` will not appear in the shot.

Both apps are the user's daily tools. On macOS, `open -a <App> --args --demo` sends an event to
the already running app and discards `--args`, leaving the personal mailbox or calendar on
screen. Binary WebP files are not checked by the privacy hook, so real accounts and client
events photographed in error reach the repository undetected.

Prefer the automated script, which verifies that daily-driver instances are closed, preflights
the CDP targets against seeded demo fixtures, manages focus, and captures both appearances:

```bash
pnpm run shots:windows
# or for a single app:
./tools/capture-window-shots.sh --app magical
```

### Manual capture procedure

When capturing by hand, follow these steps in order:

1. **Quit personal instances**:
   ```bash
   pkill -f "/Applications/Magical.app" || true
   pkill -f "/Applications/Magimail.app" || true
   ```
2. **Launch under the demo profile directly from binary**:
   Never use `open -a` to start a demo instance:
   ```bash
   /Applications/Magical.app/Contents/MacOS/Magical --demo --debug-port=9223 >/tmp/magical-demo.log 2>&1 &
   # or
   /Applications/Magimail.app/Contents/MacOS/Magimail --demo --debug-port=9222 >/tmp/magimail-demo.log 2>&1 &
   ```
   `--demo` resolves to the `demo` userData profile and tells the app to keep clear of the
   App Group.
3. **Verify the running process and CDP fixture**:
   Confirm `--demo` appears in the process arguments:
   ```bash
   ps aux | grep -E "Magical|Magimail" | grep "\--demo"
   ```
   Query `curl -s http://localhost:9223/json` and confirm the loaded calendar is the seeded
   fixture (such as the week of October 25, 2026), not a live personal calendar. Dismiss any
   offline mail banners in Magimail before capturing.
4. **Set window bounds**:
   ```bash
   osascript -e 'tell application "System Events" to tell process "Magical" to set position of window 1 to {100, 100}'
   osascript -e 'tell application "System Events" to tell process "Magical" to set size of window 1 to {1280, 820}'
   ```
5. **Focus and switch appearances**:
   Ensure traffic lights render in their active colours (delete `AppleAquaColorVariant` if set to graphite).
   Activate and raise the window:
   ```bash
   osascript -e 'tell application "Magical" to activate'
   osascript -e 'tell application "System Events" to tell process "Magical" to set frontmost to true; perform action "AXRaise" of window 1'
   osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to true'
   ```
6. **Capture and scale**:
   Capture flat without window shadows (`-o`), downsample to the site's canonical window geometry, and convert to WebP:
   ```bash
   screencapture -l <windowId> -o /tmp/shot-raw.png
   sips -z 1025 1600 /tmp/shot-raw.png --out /tmp/shot-1600.png
   cwebp -q 88 /tmp/shot-1600.png -o website/src/assets/shot-window-magical-dark.webp
   ```

## Capturing the Dock

Each app's Dock section illustrates unread tracking. The shot needs the app's live badge,
clean system neighbours (Chrome, Notes), and the other app out of the frame.

1. **Isolate the app in the Dock**:
   Use `dockutil` to move the other app and any neighbour apps carrying badges past the crop area:
   ```bash
   dockutil --move Magimail --after Photos
   dockutil --move Reminders --after Photos
   ```
2. **Clear the background and hover state**:
   Move windows away from the bottom 150 points so window chrome does not peek over the Dock edge.
   Warp the pointer to `(0, 0)` so no hover magnification or tooltip is visible:
   ```bash
   swift -e '
   import AppKit
   let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: 0, y: 0), mouseButton: .left)
   event?.post(tap: .cghidEventTap)
   '
   ```
3. **Set the badge**:
   Apply the badge after any `dockutil` commands, because restarting the Dock clears transient badge state.
   Send an invite or unread message to an account signed in to the test profile, or call
   `app.dock.setBadge("1")` via the inspector.
4. **Capture the crop**:
   Capture the 5-icon region centered on the app (`760 × 222` at 2x Retina):
   ```bash
   screencapture -R 137,845,380,111 /tmp/shot-dock.png
   cwebp -q 88 /tmp/shot-dock.png -o website/src/assets/shot-dock-magical.webp
   ```
5. **Restore original Dock arrangement**:
   Return moved apps to their standard locations:
   ```bash
   dockutil --move Magimail --before Magical
   dockutil --move Reminders --after Magical
   ```

## Things that will bite

**The site owns the rounding and the shadow.** `.shot--framed` in `site.css` applies a 12px
radius and four shadow tiers, and `.shot--free` applies drop-shadows that follow the image's
own alpha. So capture flat: square corners, no macOS window shadow, and no background behind
a cut-out. A capture carrying its own rounded corners is rounded twice, and one carrying its
own shadow gets five.

**A banner is on screen for about a second**, and it belongs to `NotificationCenter` rather
than to Magimail, so `shot-notification` cannot be framed at leisure. Set the region up
first, then dispatch;
[`testing-native-subsystems`](../testing-native-subsystems/SKILL.md) covers forcing the
dispatch without waiting for mail.
