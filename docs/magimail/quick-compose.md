# Quick compose (⌥⌘C)

A system-wide chord opens a compose window from whatever application the user happens to be in.
Magimail registers it at launch, and the Quick compose hotkey picker in Preferences → General
chooses it: `Off`, ⌥⌘C (the default), ⌃⌘C, ⇧⌘C, ⌃⌥⌘C. Every chord is C, for compose, and only
the modifiers vary: the three two-modifier ⌘ combinations cover an ordinary collision, and ⌃⌥⌘C
is for when all three are taken. macOS ships no control for capturing a chord, so the picker is a
fixed list rather than a hand-rolled recorder: every entry is known-good, and it cannot produce a
chord the main process has to refuse.

Files: `apps/magimail/src/quick-compose.ts`, `apps/magimail/src/account-picker.ts`, `focusToField()`
in `apps/magimail/src/compose-fields.ts`.

## Sequence

1. `globalShortcut` fires in the Electron main process.
2. `app.focus({ steal: true })`, which runs before anything goes on screen rather than after.
3. The account picker, if there is more than one account (see below).
4. `openDetachedComposeWindow()` on the chosen account's partition, titled
   `New Message — <account>`.
5. `focusToField()` polls until Gmail's compose inputs exist, then focuses To.

None of this needs an account's web view to be loaded, which matters because the hotkey exists for
the times the app has been sitting in the background. It does need the account manager, and that
belongs to the main window: with the window closed (tray off) the hotkey builds one **hidden**, so
the compose window is what appears and the mail window does not come up behind it.

The chord is registered with Electron's `globalShortcut` rather than in the Swift helper: it is the
same Carbon `RegisterEventHotKey` underneath, and a hotkey has no appearance for a native surface
to get right, so routing it through the helper would only add a stdio round trip and a second place
for the setting to fall out of sync.

## Which account, and who asks

`composeAccountPicker: 'active'`, the default, means _"compose from the account you are looking
at"_. That only answers anything where an account is on screen, so it governs the main window and
nothing else. Every other surface either names an account itself or has to ask:

| Surface                                     | Which account                  |
| :------------------------------------------ | :----------------------------- |
| Main window `Cmd+N`, `Cmd+Shift+N`, toolbar | `composeAccountPicker` decides |
| Widget tile for one account                 | That account                   |
| Menu bar popover, filter on one account     | That account                   |
| `magimail://compose?account=<id>`           | That account                   |
| Recents widget compose button               | Asks                           |
| Menu bar popover, filter on All Accounts    | Asks                           |
| `mailto:` from another application          | Asks                           |
| The quick compose hotkey                    | Asks                           |

`chooseComposeAccount()` is that one question, and `fromMainWindow` is how the main window claims
its exemption. Asking by default means a surface added later has to opt out deliberately rather than
silently guess.

Choosing does not switch accounts. The main window and the tray do switch, because compose lands in
the window the user is already looking at. The hotkey does not, because the user is in another
application and would come back to a main window showing something they never chose.

The alert hangs off a parent window as a sheet when one is given, and goes up parentless otherwise.
From a hotkey or a `mailto:`, the main window may be minimised, buried, or — before one is built for
it — absent.

## If a chord is refused

`globalShortcut.register()` returns false when another application asked for the chord first. That
is logged, and the setting is left exactly as the user set it rather than silently flipped to `Off`
behind their back; they picked it, and the picker offers three others. The settings window is not
told, so a refused chord looks chosen but does nothing. Telling it would need an event back down the
stdio transport.
