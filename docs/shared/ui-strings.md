# Our own UI strings

Gmail and Google Calendar serve their interface in the user's language. Everything around them —
our menu labels, dialog text, notification wording, window titles and the HTML pages we render
ourselves (the offline page, the Find in Page bar, Magimail's category banner) — is ours, and it was
written as a literal at the point it was used, so neither app can be translated. This document
defines the catalogue that replaces those literals: a map of named strings, each holding the text to
render per locale.

This is the mirror of [`dom-labels.md`](dom-labels.md). That document resolves a control on
_Google's_ page from a label the page renders, because the page is in the user's language. This one
resolves a string _we_ render. The shapes are deliberately the same so the two read alike: named
entries, locale keys with a base and regional overrides, and a schema that validates the data at
load.

The shapes are defined in `packages/core/src/ui-strings.ts` and exported from `@magimail/core`. The
locale keys themselves live in `packages/core/src/locale.ts`, shared with the DOM action map. The
data lives in a `ui-strings.json` each app authors for itself.

## The map

A catalogue is versioned and keys its strings by name.

```json
{
  "version": 1,
  "strings": {
    "menu.file": { "en": "File", "de": "Ablage" },
    "menu.file.print": { "en": "Print..." },
    "dialog.accountPicker.button": { "en": "{name} Account" }
  }
}
```

A key is a dotted name grouping a surface (`menu.*`, `dialog.*`, `notification.*`, `window.*`,
`find.*`, `offline.*`, `banner.*`) so a translator can see where a string is used without opening
the code. Nothing enforces the grouping; it is a naming convention, not a shape.

Each string maps a locale key to the text that renders it. `validateUiStringsMap` enforces the shape
and the rules below. Each app validates its catalogue at load and its unit tests do too, so a bad
catalogue is a thrown error rather than a dialog that renders a key. It parses against
`uiStringsMapSchema`, the zod schema that defines the shape once: `UiStringsMap` is inferred from
it, so the type the compiler checks and the runtime check cannot drift. An unknown field is itself a
problem, so a typo is reported rather than ignored.

### Locale keys

A key is a base language (`en`, `de`) or a language with a region (`en-GB`, `en-US`, `de-DE`). Keys
compare case-insensitively, with the language lowercased and the region uppercased. The rules are
those [`dom-labels.md` describes](dom-labels.md#labels-and-locale-keys), because
`packages/core/src/locale.ts` defines them once: the exact key for the locale is tried first
(`en-GB`), then the base language (`en`), and the two are never merged. A regional key records only
the strings whose wording differs, replacing the base for the strings it covers.

Every string must include at least one `en`-based key with a non-empty value. That keeps English
present as the base a catalogue is written against; a string translated only into German would
never resolve on an English system.

### Placeholders

A string may carry `{name}` placeholders, filled from the parameters passed at the call site:

```json
{ "notification.lead.minutes": { "en": "In {count} minutes" } }
```

`formatUiString` replaces each placeholder with the matching parameter and **throws** when one is
missing, so a template is never shipped with a literal `{name}` in it. Placeholders are named rather
than positional, and a translator may reorder them, which is the reason not to concatenate strings
at the call site.

Grammar that changes with a count is handled with separate keys rather than plural machinery:
`notification.lead.minute` and `notification.lead.minutes` are two strings, so a language with
different plural rules is free to have one, two or three.

## The translator

`createTranslator(map, getLocale)` returns the `(key, params?) => string` a call site uses. The
locale is read per call from `getLocale`, so the translator does not have to be rebuilt when the app
learns the system language after `ready`. A key the catalogue does not define throws, so a typo
fails loudly rather than rendering `undefined`.

Each app's `src/strings.ts` validates its JSON, holds the current locale, and hands out `uiString`:

```ts
import { uiString } from './strings.js';

label: uiString('menu.file.print');
message: uiString('dialog.resetSession.question', { name: account.name });
```

The locale is set from `app.getLocale()` in `whenReady`, before the first menu or dialog is built.
Until it is set the translator uses the base language, which is also what the tests see, so a test
asserting an English string needs no setup.

The Node-side helpers are:

- `validateUiStringsMap(map)` validates a catalogue and returns every problem as a `path message`
  line, so an app can fail at startup.
- `resolveUiString(entry, locale)` returns the effective string: the exact key when present,
  otherwise the base, otherwise `undefined`.
- `formatUiString(template, params)` fills placeholders.
- `createTranslator(map, getLocale?)` builds the lookup.
- `createUiStringTemplate(map, getLocale?)` returns a string's template with its `{name}`
  placeholders left for the caller, for a surface that fills a placeholder only it knows — the native
  toolbar's invitation count.
- `pickUiStrings(map, keys)` selects named strings and throws on a key the catalogue does not
  define, for tests and tooling.

## What this does not cover

This catalogue is the **Node side only**, namely the Electron main
process: menus, dialogs, notification text and window titles.

The native surfaces — the Swift helpers' settings windows, menu bars and notifications, and the
Share, Widget and App Intents extension bundles — each localise with a String Catalog
(`.xcstrings`), the mechanism macOS localises with. Generating `.xcstrings`
from this JSON was considered and rejected: it would put a build step between a translator and the
string the OS reads, and it would have to reimplement String Catalog's own plural and substitution
features.

A `.xcstrings` is a source file; macOS reads the `.strings` and `.stringsdict` a catalog compiles
into. An Xcode target does that from its Resources phase, which is how both widget extensions ship
theirs. The App Intents extensions have no Xcode target and are built by a bare `swiftc`
invocation, so their build scripts call `compile_string_catalog` in
[`tools/localization.sh`](../../tools/localization.sh). SwiftPM is not an alternative: it copies a
`.xcstrings` resource into the target's bundle uncompiled, so the two helpers compile theirs the
same way. A helper is a bare executable at `Contents/MacOS`, not a bundle, so `Bundle.main` is the
containing app; `swift/build.sh` compiles its catalog and `electron-builder` carries the
compiled `*.lproj` (`en.lproj`, `en-GB.lproj`) into `Contents/Resources`, which is where the helper's own code and the shared `HelperUI` chrome
both resolve their strings. `HelperUI` (`packages/swift-ui`) still holds no catalog of its own: the
app passes its name in and the rows derive their sentences from it, so the keys they need sit in
each app's catalog, exactly as the toolbar's labels stay in the app's catalogue rather than the
addon's. Each `.appex` is also its own resource namespace, so the catalogs stay one per bundle even
when several bundles compile the same Swift source — `MailCategory.swift` in Magimail, and the
widget views in both apps, are localised once at the call site and carry their keys in each bundle
that renders them. The reverse does not follow: a catalog lists only the keys its own compiled
sources draw, so a sentence only the widget can render stays out of the helper's catalog rather
than sitting there for a translator to work on and never be shown.

The Share extension draws no interface of its own, so it carries only
`Resources/en.lproj/InfoPlist.strings`, for its bundle display name. The App Intents extensions'
`CFBundleDisplayName` stays English: the Focus UI attributes a filter to the app and shows the
intent's `title`, not the extension bundle's name, so `Magimail Focus Filters` is never drawn.

Everything core builds that a user reads — the diagnostics dialog (`diagnostics.ts`), the pre-release expiry alert (`prerelease-build-expiry.ts`), the offline page (`offline-page.ts`) and the Find in Page bar (`find-in-page.ts`) — takes the app's `uiString` rather than holding wording of its own, because core owns the layout and no app's data. Core exports the keys it needs (`DIAGNOSTICS_DIALOG_KEYS`, `PRERELEASE_EXPIRY_KEYS`, `OFFLINE_PAGE_KEYS`, `FIND_IN_PAGE_KEYS`) and each app's `ui-strings` test asserts they exist.

The native toolbar's item labels are the exception among the native surfaces. Its addon is a dylib
loaded into Electron rather than a bundle, so it has no resource bundle of its own, and `swift build`
(a command-line build, unlike Xcode) copies a `.xcstrings` without compiling it. Those labels are
therefore resolved from this catalogue and pushed over the addon's JSON bridge;
[`native-ui.md`](native-ui.md#localised-labels) records the decision and the constraint that settled
it.

### Left English on purpose

Some English is not copy, and is deliberately not catalogued:

- **Data the user authored** — account names, calendar names Google already localises, message
  subjects and event titles. These render as written, in whatever language the user wrote them.
- **Suggested filenames** — the `Email.pdf` fallback is a filename, not a label.
- **The diagnostics report body** (`formatSummaryText`) — it is emailed to support and pasted
  into a GitHub issue, and a support ticket is read in English wherever it came from, so the report
  stays English wherever it is shown, including inside the dialog that offered it.
- **The About panel's copyright line** — a legal line, not interface copy.

## Adding a string

Write the English text into the app's `ui-strings.json` first, then call `uiString` at the point it
renders. If the string carries dynamic parts, make them named placeholders rather than concatenating
at the call site. Remove the entry when a string stops being rendered. Run the app's
`ui-strings` test: it validates the catalogue, checks that every `uiString('…')` literal names a key
that exists, and checks that no key is left behind by code that no longer uses it.

## Adding a language

Add the locale key to the strings that differ, leaving the rest on the base. Nothing has to change
at a call site: `app.getLocale()` already resolves to the region and falls back to the base. A
string that is not translated stays English, which is visible rather than broken, and a system
language with no translation at all reads English rather than throwing. Shipping a catalogue before
its translation exists is therefore safe.
