# Locale-aware DOM actions

Gmail and Calendar identify a control by an English `aria-label`, `data-tooltip` or its visible
text. On an account whose language is not English those strings never appear, so an action that
matches them quietly does nothing. This document defines the vocabulary that replaces label
matching: a map of named actions, each resolved either by a strong hook or by a set of localised
labels.

The shapes are defined in `packages/core/src/dom-labels.ts` and exported from `@magimail/core`. The
page-side resolver is `findAction`, carried by `DOM_DRIVE_PREAMBLE` in `packages/core/src/dom.ts`.
The data lives in a `dom-labels.json` each app authors for itself.

## Three bands

Every handle on Google's DOM sits in one of three bands.

| Band        | Examples                                                            | Use                                    |
| :---------- | :------------------------------------------------------------------ | :------------------------------------- |
| Strong hook | `role`, `name`, `href`, `data-*` state, an authored id, `act`, `gh` | Match on it, with no label             |
| Locale map  | `aria-label`, `data-tooltip`, visible text                          | Match only where no strong hook exists |
| Never       | `jsname`, `jslog`, `jsaction` values, classes, generated ids        | Never match                            |

The line between the first two bands is not "authored against generated". `act` and `gh` look as
generated as `jsname`, but Google hand-authors them and reads them at runtime: a change to an `act`
value breaks the JavaScript Google ships, so it changes rarely and on purpose. `jslog` is telemetry.
Google's analytics reads it, nothing resolves a control through it, so it carries no identity and
moves freely. `jsname`, the values inside `jsaction`, classes and generated ids are compiler output
with no meaning outside the build that emitted them.

A strong hook is preferred wherever one exists. A label is a fallback for the controls Google left
unlabelled in markup, and the resolver reports which of the two matched so a caller can log a
control that has fallen back.

## The map

An action map is versioned and keys its actions by name.

```json
{
  "version": 1,
  "actions": {
    "compose": { "selectors": ["[gh=\"cm\"]"] },
    "addCc": { "labels": { "en": ["Add Cc recipients"] }, "match": "startsWith" }
  }
}
```

Each action sets **exactly one** of `selectors` or `labels`, never both. There is no fallback chain
between them: an action matched by a hook is not also tried against labels when the hook misses.
`validateDomActionMap` enforces this and the rest of the rules below. Each app validates its map at
load and its unit tests do too, so a bad map is a thrown error rather than a control that quietly
stops matching. It parses against `domActionMapSchema`, the zod schema that defines the shape once:
`DomAction` is inferred from it, so the type the compiler checks and the runtime check cannot
drift. An unknown field is itself a problem, so a typo such as `selector` is reported rather than
ignored.

### Labels and locale keys

`labels` maps a locale key to the strings that render that control. A key is a base language (`en`,
`de`) or a language with a region (`en-GB`, `en-US`, `de-DE`). Keys compare case-insensitively, with
the language lowercased and the region uppercased.

The resolver reads the page's language from `document.documentElement.lang` once per call and
normalises it to `xx` or `xx-YY`, defaulting to `en` when the attribute names no language. It then
looks up the exact key for that language (`en-GB`) and, only when that key is absent, the base
language (`en`). It never reads any other language. The two keys are never merged: the base is the
default map, written once, and a regional key records only the actions whose wording differs,
replacing the base entry for that action. An action that renders the same across variants is written
once under `en` and found by every English page, `en-GB` and `en-US` alike. Where a variant differs,
`en-GB` renders "Bin" where `en-US` renders "Trash", so those are two entries, and an `en-US` page
falls back to the base rather than borrowing the `en-GB` string.

A regional entry stands alone, so an action that needs aliases in a region must list them on that
regional key; it does not inherit the base's strings for that action.

Matching never crosses a language. If the action carries neither the exact key nor the base, the
resolver returns `via: 'none'`: a visible miss the caller can log, rather than a guess from a
language the page is not in. Sharing a string across languages is what makes an unscoped union
wrong, because a word such as "Information", "Menu", "Total" or "No" renders identically in several
languages and can match the wrong control.

Every action that carries labels must include at least one `en`-based key holding a non-empty array.
That keeps English present as the base the map is written against; an action with only `de-DE`
labels would never match an English account.

### Match modes

`match` is `exact` (the default), `startsWith` or `contains`. There is no wildcard syntax; dynamic
text is handled by the mode.

Google appends a keyboard hint to some accessible names, so a control renders
`"Add Cc recipients ‪(⌘⇧C)‬"` while the stable part is `"Add Cc recipients"`. Record the stable part
and match with `startsWith`. The stored label stays a true prefix of the live attribute, so the
page-side `startsWith` and a CSS `[aria-label^=...]` fragment agree, and nothing has to strip the
hint out of the attribute at match time. Each CSS fragment also carries a `:lang()` scope (see
[the resolver](#resolver)).

### Signals

By default a label is matched against four signals on each element: `aria-label`, `data-tooltip`,
`title`, and the element's own text. `attrs` restricts that set to the signals named, in the order
given, so a match is only reported where the caller expects to find it. The values are `aria-label`,
`data-tooltip`, `title` and `text`, where `text` means the element's `textContent`.

Restrict to `aria-label` where Google mirrors one label into several nodes. Calendar copies each nav
button's name into a `[role="tooltip"]` beside the button and again into an inner span, so an action
that is unique by `aria-label` otherwise matches three elements and `order: 'only'` reports
`ambiguous`. Naming `attrs: ["aria-label"]` keeps the match on the button itself, where the label is
the control's accessible name, and lets `only` guard uniqueness as intended. Excluding the tooltip
and picking `last` instead lands on the inner span, hiding the duplication the guard exists to catch.

### Scope and exclude

`scope` narrows the search to one subtree; without it the whole document is searched. `exclude`
lists selectors whose subtree is skipped, so a match inside a Workspace dialog or a third-party
add-on is ignored. Both are strong-hook selectors.

## Resolver

`findAction(root, action)` receives the action object as an argument and references no module state,
so one preamble serves either app. It resolves `scope` to the search root, falls back to `root`,
and returns:

```ts
{ el: Element | null, via: 'hook' | 'label' | 'none' | 'ambiguous', matchedBy: string | null }
```

`via` names why the call ended: `hook` for a selector, `label` for a localised string, `none` when
nothing matched, and `ambiguous` when a single match was asserted and more than one appeared.
`matchedBy` is the selector or the label that matched, and `null` otherwise. A selector is preferred
only when its element is laid out, so a hidden control never shadows a shown one; a label is matched
against the effective keys for the page's language under `match`, across the signals `attrs` names.

`order` is required and records the caller's expectation for how many controls match. `first` and
`last` pick one end of the match set in document order. `only` asserts a single match: exactly one
resolves, none is `none`, and a second is `ambiguous` with no element, so a caller can log "expected
one, found N". Ambiguity is surfaced rather than resolved because a second match is a page change;
picking one silently would hide the change and could act on the wrong control. Gmail renders one set
of reply controls per message, and replying to the newest message means the last of them, so a
per-message reply action sets `order: 'last'`.

An action consumed only by CSS needs `order` too, since the field is required; there it is
declaratory, describing the control the fragments target, because the stylesheet does not resolve an
element.

The Node-side helpers are:

- `resolveLocale(htmlLang)` normalises a page language to `xx` or `xx-YY`, defaulting to `en`.
- `normalizeLabel(value)` lowercases, trims, collapses internal whitespace and drops zero-width and
  bidi control characters. The page-side resolver normalises the same way.
- `labelMatches(value, labels, match)` compares one string against a set under a mode.
- `labelsFor(action, locale?)` without a locale returns the union of every key's strings, for
  validation and tooling; with one returns the effective set, the exact key when present otherwise
  the base, deduplicated case-insensitively.
- `pickActions(map, keys)` selects named actions and throws on a key the map does not define.
- `labelSelectors(action, attrs?)` turns an action's labels into CSS attribute-selector fragments for
  an injected stylesheet, one per attribute per label, using the operators that match the mode. Each
  fragment carries a `:lang(<key>)` scope, so the stylesheet only matches a page in that language;
  CSS resolves the base and region relationship itself, since `:lang(en)` matches `en-GB` but
  `:lang(en-GB)` does not match `en-US`. Within a language a regional key overrides the base, so only
  the effective key's fragments are emitted.

## Populating a map

Write the English string first, taken from a real account rather than guessed, and add a regional
key only where a variant renders something different. Because a regional key replaces the base for
that action, record the region's full set of strings on it rather than only the additions. Every
action that can be replaced by a strong hook should be, so the locale map holds only what has no
semantic selector. `validateDomActionMap` runs over the map at load; a problem in the data is a
defect, not a runtime condition.

See [`design.md`'s DOM selection section](design.md#dom-selection--css-hygiene) for the selector
hygiene the hooks must follow.

## Drift canary

`tools/dom-drift.mjs` is a canary for the strong hooks. It resolves each one with the same
page-side `findAction` the apps use and compares the control it lands on against the English
accessible name, read off a signed-in English account. The English label is the oracle only; no
matcher reads it, and the tool does not consult this map.

Point it at the app under test with its debug port open:

```bash
pnpm run magimail:debug                  # CDP on 9222
node tools/dom-drift.mjs --app magimail

pnpm run magical:debug                   # CDP on 9223
node tools/dom-drift.mjs --app magical
```

`--port` overrides the app's default port, and `--target <title substring>` names the account when
more than one view is awake. A control that is not rendered in the current view is reported `skip`,
not `fail`, because reaching a state is not a check: the canary drives the page into the state each
hook needs and then resolves the hook. It selects Gmail threads until one is unread and deselects
them after, opens and closes the Calendar event chips that lay out to check the delete hook, scans
those chips for an invitation to check the RSVP hooks, and opens Calendar search to check `Go back`.
It never activates a control it is checking, never creates or edits an event and never changes mail,
and a state the page does not offer — no event chip, or no invitation among them — stays a skip. It
checks the Calendar day arrows in day and week view, routing the view itself, because their names
change with the view and a check in one view says nothing about the other. It needs `pnpm --filter
@magimail/core run build` for the shared preamble.

The tool is a manual or CI-local canary. A red run means Google moved something a person has to look
at, which is not a job for blocking CI.
