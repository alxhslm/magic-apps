# `SuiteNative`

The shared in-process AppKit & macOS native foundation for Magimail and Magical.

Both applications host a native dynamic library (`lib<App>Native.dylib`) loaded via an N-API addon directly into Electron's main process. This package holds the plumbing that must run inside Electron's process rather than the Swift helper subprocess:

- **AppKit NSToolbar Lifecycle & Boilerplate**:
  - `ToolbarManagerBase`: Attaching an `NSToolbar` to `NSWindow`, managing window destruction/recreation from the Dock, unified styling (`.unified`, `.hidden` title, `.none` separator), and toolbar customization palette presentation.
  - `AccountSegmentedControl`: Real AppKit `NSSegmentedControl` with native OS chrome, custom colored dots (solid for active/unread, outline ring for idle), Focus Filter de-emphasis dimming, `needsAuth` warning triangles, and `⌘1`..`⌘9` keyboard shortcuts.
  - `ItemValidation` & `ValidatedToolbarItem`: Centralized enabled-state store and `validate()` overrides, preventing AppKit's automatic revalidation passes from overriding JavaScript-driven disabled states.
  - `SearchDelegate`: Reusable `NSSearchFieldDelegate` capturing Return/Enter for search actions.
  - `ToolbarBuilder`: Helper functions to construct bordered SF Symbol buttons and expanded item groups.
- **WidgetKit Timeline Reloads**:
  - `reloadAllWidgets()`: Invokes `WidgetCenter.shared.reloadAllTimelines()`. macOS BaseBoard requires the calling process's executable to match `CFBundleExecutable`, which only Electron's main process satisfies.

## What does NOT belong here

App-specific toolbar items, layouts, actions, and business logic. Magimail's email triage, compose, and reply items stay in `apps/magimail/native/`; Magical's calendar navigation, view switcher, and quick add stay in `apps/magical/native/`.

Consumed via SwiftPM path dependency from `apps/*/native/Package.swift`:

```swift
.package(path: "../../../packages/swift-native")
```
