---
paths:
  - 'apps/magimail/src/**/*.ts'
  - 'apps/magical/src/**/*.ts'
---

The web contents are Google's page, and it changes without warning. Read
[`design.md`'s DOM selection section](../../docs/shared/design.md#dom-selection--css-hygiene) before
injecting CSS or querying the DOM.

- **Target semantic HTML and ARIA, never a minified class name.** `[role="main"]`, not `.aeN`.
- **A handle falls in one of three bands.** A strong hook (`role`, `name`, `href`, `data-*` state, an
  authored id, `act`, `gh`) is preferred; a localised label is used only where no hook exists; a
  generated name (`jsname`, `jslog`, `jsaction` values, classes) is never used. See
  [`dom-labels.md`](../../docs/shared/dom-labels.md).
- **Scope every injected rule** so it cannot leak into a Workspace dialog, a third-party add-on or
  the user's own mail.
- **`querySelector` returns the first match in document order, not selector order.** Never comma-join
  a precise selector with a loose fallback; `div[act="9"], [aria-label*="Mark as read"]` once clicked
  Report spam.
- **Inject on `did-navigate`, never `dom-ready`.** Waiting flashes unstyled content on the first load
  and on every account switch.
- **Light and dark mode stay consistent with each other.** Every property a dark rule sets, its light
  counterpart resets, so switching theme leaves nothing behind. A dark rule with no reset survives
  the switch. See
  [`dark-mode.md`](../../docs/magimail/dark-mode.md#light-mode-is-an-explicit-reset-not-an-absence).
- **Do not add CSS blur.** AppKit draws the vibrancy; `backdrop-filter` and `-webkit-backdrop-filter`
  are not allowed.
- **Keep settings panels, Google Tasks and companion sidebars solid and opaque**, so desktop vibrancy
  does not bleed through them.
