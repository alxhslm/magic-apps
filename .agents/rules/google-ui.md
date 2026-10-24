---
paths:
  - 'apps/magimail/src/**/*.ts'
  - 'apps/magical/src/**/*.ts'
---

**Present Google's page as it is.** The project wraps Gmail and Calendar; it does not redesign them.
Do not inject buttons, badges, fields or panels into the web content, and do not rearrange Google's
layout.

The injected layer may:

- invert Gmail for dark mode,
- make the body transparent so AppKit vibrancy shows through,
- hide chrome the user asked to hide, such as ads, the companion sidebar or banners.

Everything the project adds of its own is native and sits outside the web view: the `NSToolbar`, the
menu bar popover, the banner bar above the content, Settings. See
[`native-ui.md`](../../docs/shared/native-ui.md) and [`dark-mode.md`](../../docs/magimail/dark-mode.md).

The category setup notice is the current exception, and it is native rather than injected. Add an
in-page control only when there is no native place for it, and record why.
