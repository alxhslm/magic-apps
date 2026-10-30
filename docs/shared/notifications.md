# Native notifications

Both apps post banners through the Swift helper rather than Electron, because the helper is what
gives a notification its bundle identity and its action buttons. What each app announces, and when,
is its own: Magimail's arrival and watermark logic is in
[`../magimail/notifications.md`](../magimail/notifications.md), Magical's alert scheduler and invite
watcher in [`../magical/notifications.md`](../magical/notifications.md).

## Helper posts the banner

`MagicalHelper`/`MagimailHelper` owns `UNUserNotificationCenter` and posts every banner. Dispatch is
a `sendToHelper` call over the newline-delimited JSON-RPC in
[`process-model-and-ipc.md`](process-model-and-ipc.md). When the helper is absent, as it is under
`pnpm run dev`, dispatch silently does nothing.

The delivery half is identical in both helpers, so it lives once in
`NotificationControllerBase` in `packages/swift-notifications`: claiming the delegate, registering
the categories, asking for authorisation at launch, adding a request and routing a pressed action
back over the pipe. Each app's `NotificationController` subclasses it and supplies only what
differs — its categories, its banner content, the sound rule and the event a press maps to. A fix
to authorisation or delivery is therefore one edit, not two that can drift apart.

Electron's own `Notification` does support macOS action buttons, so the often-repeated claim that the
buttons would have to be dropped is wrong. Staying in Swift keeps the banner in the process that
already owns the menu bar and the settings window, rather than adding a second one just to reach
`UNUserNotificationCenter`.

## Registration happens at launch

The main process sends `notify.setup` immediately after spawning the helper, which registers the
action categories and requests authorization. Left to the first dispatch, macOS would know nothing
about the app until a notification arrived: there would be no row in System Settings to grant
beforehand, and the first notification would necessarily be missed.

Every response is logged with its raw action identifier and message id, including one that maps to no
event, so a delivery failure can be told from an unrecognised identifier.

## Diagnosing a missing response

The app log says whether `didReceive` fired, not whether macOS received the click. Read the system
side with `tools/notification-response-trace.sh` while reproducing: it prints the app and helper
identities and processes, then streams `usernoted` and `usernotificationsd` lines for the bundle.
`Received response` and `Bringing app … front for response` mean macOS got it; `activating
connection … delegate.<bundle>` names the process it handed it to. `--past` reads the last 30
minutes instead of waiting for the next click.

If the system log shows the response but the helper logs no `Response received`, the break is between
`usernoted` and the helper. If neither appears, the click never reached the system.

## Only the helper posts notifications

The shared session configuration denies the web `Notification` API on every Google partition, both
when a page asks and when Chromium checks a grant already stored there. Without this, Gmail posts its
own banner for the same message under the same bundle identity the helper uses: two banners for the
user, and two processes claiming one identity.

## Clearing on removal

**Remove All App Data and Quit…** sends `notify.clearAll` as its first step, before anything is
deleted. The helper takes back every delivered notification, cancels every pending request, and
registers an empty category set: no banner or scheduled alert is left naming an account whose data
has gone, and a category left registered would keep its actions in System Settings for a bundle that
is no longer installed. The clear is guarded by the same bundle-identity check as every other
notification call, so a helper outside a bundle skips it rather than aborting, as it does under
`pnpm dev` and `swift test`. The rest of the removal is in
[`sessions-and-security.md`'s Removing an app](sessions-and-security.md#removing-an-app).

**Authorisation cannot be revoked.** macOS has no API for it, so the app's row under System Settings,
Notifications stays until the user turns it off, and the user is the only one who can. Clearing what
has been posted and scheduled is the whole of what the app can do from inside itself.

## Bundle identity

`UNUserNotificationCenter` aborts without a bundle identity, so the helper must run from
`Contents/MacOS` inside the app and carry the app's signing identifier rather than one derived from
its filename. A helper elsewhere in the bundle, or signed under its own identifier, either aborts or
fails `requestAuthorization` with `UNErrorDomain Code=1`, and the app never appears in System
Settings, Notifications. Under `pnpm run dev` the helper runs outside any bundle, so check banners on the
installed build.

The signing rules and `signIgnore` are in [`building-and-signing.md`](building-and-signing.md); the
identity the widget extension needs, and the quit that follows from sharing an identity, are in
[`process-model-and-ipc.md`](process-model-and-ipc.md); the Focus filter's identity requirement is in
[`focus-filters.md`](focus-filters.md).

## Category and action contract

Every banner belongs to a registered `UNNotificationCategory`, and the actions are declared on the
category rather than per notification.

- **Registering the categories is what supplies the actions.** An action that is not on the category
  cannot be attached.
- **macOS decides how many actions it shows inline and collapses the rest.** Switching the app to
  Alerts in System Settings leaves the actions there, behind an **Options** dropdown;
  `UNNotificationAction` has no say in the matter. Registering fewer is the only thing that changes
  it, and the number at which macOS stops collapsing is unverified.
- **An action that cannot apply to a given notification is not registered on that category, not
  disabled on it**, because macOS cannot hide an action per notification. Magical therefore has two
  meeting categories rather than one carrying a disabled Join button.
- **`.foreground` is a deliberate omission for an action that leaves the app.** An action that hands
  a URL to another application does not ask to bring this one forward on the way.

## Content and formatting

macOS lays a banner out as **title, then subtitle, then body**, and the order is not the order the
fields are named in. A subject therefore has to be the _subtitle_ to appear above a snippet; assigning
the snippet to the subtitle renders it above the subject and in bold, which reads as the subject being
a preview of itself.

Magimail's mapping is: sender name as title, subject as subtitle, snippet as body; when the snippet is
empty the subject moves into the body rather than being printed twice.

Magical's mapping is: an alert uses the meeting name, then `In 5 minutes · 14:30`, then the conference
provider or the location. An invitation uses the event name, then `Invitation from <organiser>`, then
when it is.

## Sound belongs to the category level

The loud level sets `content.sound` and the silent level does not. `willPresent` honours the same
level, so a silent category stays silent when the app is frontmost; a global switch on top would only
raise the question of which wins. macOS System Settings remains the final say.
