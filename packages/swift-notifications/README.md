# `HelperNotifications`

The `UNUserNotificationCenter` plumbing Magimail's and Magical's Swift helpers both need.
One file, `NotificationControllerBase.swift`, holding the half of notification delivery
that does not know what a banner says:

- claiming the notification centre delegate,
- registering the categories the subclass supplies,
- asking for authorisation at launch and reporting the answer,
- posting a request with no trigger,
- withdrawing delivered and pending requests,
- routing a click or an action press back over the RPC pipe.

What each app announces, which categories it registers and which action identifiers it
maps to which method stay in the app's own `NotificationController`, which subclasses
`NotificationControllerBase`.

## Using it

SwiftPM path dependency, from an app's `swift/Package.swift`:

```swift
.package(path: "../../../packages/swift-notifications")
```

then `import HelperNotifications` in the app's `NotificationController.swift`. It pulls in
`HelperRPC` for the transport and the log.

A subclass supplies `categories()` and `notificationEvent(actionIdentifier:userInfo:)`, and
overrides `foregroundOptions(for:)` or `authorizationResolved(granted:error:)` only where
the app differs. The categories, the content and the action vocabulary are per-app and
belong there.

## What does not belong here

Anything that knows what a banner is made of. The sender/subject/snippet mapping, the
meeting and invitation fields, the per-account thread grouping and the Focus filter check
all live in the app's own controller.

It is not a node package and has no `package.json`, so pnpm's `packages/*` workspace glob
skips it.
