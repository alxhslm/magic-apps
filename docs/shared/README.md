# Shared documentation

What both apps, or `@magimail/core`, share. A page here states a mechanism or an invariant once;
an app page records what is true only of that app and links here for the concept.

| Document                                                     | Covers                                                                       |
| :----------------------------------------------------------- | :--------------------------------------------------------------------------- |
| [`process-model-and-ipc.md`](process-model-and-ipc.md)       | The processes both apps run and the channels between them                    |
| [`window-lifecycle.md`](window-lifecycle.md)                 | The main window, the account renderers it hosts and the window-action policy |
| [`design.md`](design.md)                                     | The visual language, vibrancy, theming, DOM hygiene and account colour       |
| [`dom-labels.md`](dom-labels.md)                             | The locale-aware DOM action vocabulary and its three bands                   |
| [`ui-strings.md`](ui-strings.md)                             | The catalogue of our own user-visible strings and how it resolves them       |
| [`native-ui.md`](native-ui.md)                               | The native surfaces and who draws them: toolbar, settings window             |
| [`menu-bar.md`](menu-bar.md)                                 | The status item and popover mechanism                                        |
| [`notifications.md`](notifications.md)                       | Native notification delivery, categories, actions and sound                  |
| [`widgets.md`](widgets.md)                                   | The widget extension mechanism, the App Group snapshot and shared tokens     |
| [`focus-filters.md`](focus-filters.md)                       | The App Intents Focus filter mechanism                                       |
| [`deep-links.md`](deep-links.md)                             | Custom URL scheme lifecycle, cold-start buffering and triage semantics       |
| [`sessions-and-security.md`](sessions-and-security.md)       | Partitions, browser identity, no OAuth, and encryption at rest               |
| [`logging.md`](logging.md)                                   | What is written to disk when something goes wrong                            |
| [`building-and-signing.md`](building-and-signing.md)         | The build script and the signing grades                                      |
| [`licensing.md`](licensing.md)                               | The open-source licence and the build expiry                                 |
| [`performance-optimisation.md`](performance-optimisation.md) | The memory budget and the Chromium tuning                                    |
| [`brand-and-icons.md`](brand-and-icons.md)                   | Both apps' marks and the icon pipeline                                       |
