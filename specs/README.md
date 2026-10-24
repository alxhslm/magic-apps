# Specs

Implementation plans for subsystems that are not built. Each spec holds one unbuilt idea, the
approach chosen, and any major decision whose reason is not obvious, stated with the constraint that
settled it. A spec never describes what runs on `main`; that belongs in
[`../docs/`](../docs/README.md), and when a subsystem ships its spec is rewritten against the code
and deleted here. Magimail has no unbuilt subsystems, so only Magical has specs.

| Spec                                                                           | Covers                                                                       |
| :----------------------------------------------------------------------------- | :--------------------------------------------------------------------------- |
| [`magical/adaptive-sidebar.md`](magical/adaptive-sidebar.md)                   | The companion drawer, the layout modes, hover maths and the popover contract |
| [`magical/quick-add.md`](magical/quick-add.md)                                 | The global shortcut, the floating HUD, `chrono-node` parsing and dispatch    |
| [`magical/google-tasks-ui.md`](magical/google-tasks-ui.md)                     | The mode-aware toolbar, navigation tracking and Tasks theming                |
| [`magical/share-extension.md`](magical/share-extension.md)                     | The macOS Share Sheet and the Quick Add deep link                            |
| [`magical/ics-and-protocol-handlers.md`](magical/ics-and-protocol-handlers.md) | `webcal://` and `ical://` feed subscriptions, and the wider deep links       |
| [`magical/ics-import-extensions.md`](magical/ics-import-extensions.md)         | The sub-calendar picker and the offline import queue                         |
| [`magical/local-calendars.md`](magical/local-calendars.md)                     | EventKit as a second event source, and the Swift bridge                      |
| [`magical/alert-resilience.md`](magical/alert-resilience.md)                   | Telling the user when alerts stop                                            |
| [`magical/wire-canary.md`](magical/wire-canary.md)                             | Nightly CI assertions against Google's tuple indices                         |
| [`magical/session-cookie-relay.md`](magical/session-cookie-relay.md)           | Onboarding an account from one app into the other, and its colour            |
