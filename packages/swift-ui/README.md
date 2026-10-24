# `HelperUI`

The SwiftUI chrome Magimail's and Magical's Swift helpers share for their settings
windows. AppKit and SwiftUI only — no app-specific content:

- `SettingsWindow.swift` — `SettingsWindowController`, the `NSWindow` and
  `NSTabViewController` host, plus the `SettingsWindowSpec` / `SettingsTab` values an
  app builds to describe its own title and panes.
- `AccountsTab.swift` — the account list editor, generic over the `AccountListModel`
  protocol both apps' settings models conform to.
- `AccountRow.swift` — one editable account row.
- `DefaultHandlerRow.swift` — one claimable file type or scheme, and the button that
  claims it, with the app's name supplied by the caller.
- `HexColor.swift` — the suite's one `#rrggbb` parser and formatter.

Before this package existed the window, the tab host, both rows and the colour helpers
were copies in each app's `SettingsWindow.swift`.

## Using it

SwiftPM path dependency, from an app's `swift/Package.swift`:

```swift
.package(path: "../../../packages/swift-ui")
```

then `import HelperUI` in any file that names these types. There is no re-export from the
app's own library target, deliberately — `@_exported` is an underscored attribute, and an
explicit import in the handful of files that need one is cheaper than depending on it.

## What does not belong here

Anything that knows what a setting means. The tabs themselves — General, Appearance,
Notifications, Advanced — read the app's own `SettingsModel` and stay in the app, as does
the model. The app builds a `SettingsWindowSpec` from its own views and hands it to the
controller; the controller never learns what is in a pane.

The package also carries no user-visible copy of its own. `DefaultHandlerRow` derives its
two sentences from the `appName` it is given, and everything else is passed in by the app.
That keeps the strings in the app's String Catalog, which is where macOS looks for them —
a SwiftPM target's `.xcstrings` is copied into its resource bundle uncompiled, so the
package could not localise a string itself. See
[`docs/shared/ui-strings.md`](../../docs/shared/ui-strings.md).

## Changing the account list

`AccountsTab` is generic over `AccountListModel`: `accounts` plus a `transport`. That is
everything the shared editor reads, and both apps' models already satisfy it.

An app that grows a genuinely different account list writes its own `AccountsTab` and
points its `SettingsWindowSpec` at that instead — the window takes an opaque view per tab,
so nothing in this package or the other app changes.
