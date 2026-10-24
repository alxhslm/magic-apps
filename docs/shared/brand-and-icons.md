# Brand and icons

Magic Apps has no app of its own, so the shared mark is the star both app icons carry on the shared
indigo ground, drawn in `website/src/assets/suite.svg`. It serves as the favicon for the marketing
site and as the social image. Each app adds its own artwork on top.

## Two marks

### Magimail: the envelope

Magimail's mark is a generic postal envelope.

- **Geometry.** A downward triangular flap with thin diagonal seams over a thin slab base, offset by
  3.5px so the artwork reads as stationery paper.
- **Flap.** The flap lifts slightly and casts a directional shadow onto the face.
- **Palette.** Outline muted terracotta (`#C05A4E`, 1.5pt); body panels cool-grey layered paper
  (`#F5F6F8`, `#EBEDF0`) rather than stark white; accent a golden haloed star (`#EBC24A`) at the top
  left.
- **The star sits top left because macOS draws the dock badge top right and it cannot move.**
- **Never reintroduce Gmail's trade dress.** No thick vertical red pillars, and no thick red "V"
  folds forming the letter "M". `build/icon.svg` carries the invariant as comments.

### Magical: the calendar

The icon is a ring-bound calendar page floating on a deep indigo field, with a magic wand entering
from the left and sparkles at its tip. `apps/magical/build/icon.svg`:

- **Silhouette.** macOS squircle, `rx=115 ry=115` on a 512×512 canvas (`macSquircleCal`).
- **Background.** Indigo-to-near-black gradient (`bgGrad`, `#1e1b4b` → `#0c0a1d`) over a subtle star
  field.
- **Calendar card.** Centred and untilted (`translate(86, 81)`), warm off-white page
  (`#f8f6f0` → `#e8e4da`) with one folded corner cut away to reveal the background.
- **Header band.** Blue gradient (`#3b82f6` → `#1d4ed8`), rounded top corners only, carrying the
  3-letter month (`AUG`) in white.
- **Ring binders.** Full metal bars (`ringMetal`) run from above the page down through the holes into
  the header. They are drawn in two passes, so the back of each ring sits behind the page and the
  front sits in front of it.
- **Date.** The large day number (`31`) in near-black (`#0f172a`), centred on the white page body.
- **Magic wand.** Enters from the left edge, tip over the top-left of the card, with a `sparkleGlow`
  filter on the sparkles.

## Artwork in code

Both marks are defined in `packages/swift-brand`, the shared Swift package the two helpers and the
widget extensions link. `MarkArtwork.swift` holds one definition per mark — the paths, the box round
them and the stroke weight — and the one function that rasterises them. `BrandMarkKind` picks a mark;
`MenuBarGlyph` and `BrandMark` choose a width and whether the result is a template image, and nothing
else, so the menu bar, the popover and the widgets cannot draw different envelopes.

Each app binds its own mark once, in `BrandArtwork.swift` (`BrandArtwork.mark`), and every surface
reaches the artwork through it. That binding is the only place an app says which mark is its own. The
status-item rules are in [`menu-bar.md`](menu-bar.md).

The envelope's outline is open where the star sits, so moving one means moving the other.

**The box is 36 × 30 because that is the mark in device pixels**, 18pt wide on a Retina display. A
widget is drawn in an extension, out of the process that asked for it, and the artwork crosses that
boundary as pixels rather than as paths: whatever flattens it asks the SVG for a bitmap without naming
a size and gets the box back. A box smaller than the pixels the mark occupies draws a soft envelope
in the widget, while the status item, which rasterises in-process at the screen's own scale, draws a
sharp one.

## Glyph grid

- **One box unit is one device pixel.** Every surface draws a mark 18pt wide, which is 36 device
  pixels on a Retina display, so both boxes are 36 across and both heights are whole numbers: 30 for
  Magimail's envelope, 39 for Magical's card. Keep Magical's frame under the 22pt status button: a
  box past 44 renders over 22pt and AppKit shrinks the whole glyph to fit.
- **Straight runs sit on whole units, with an even `stroke-width`.** A stroke is crisp when it covers
  whole pixels, which needs an even width and a centreline on a whole unit. Both marks use 2, and
  every horizontal and vertical coordinate in them is an integer. Diagonals and curves gain nothing
  from the grid and keep the weights they were drawn with.
- **The two glyphs share a line weight rather than a `stroke-width`.** Line weight is a property of
  the pair; it is never a lever for apparent size. Both boxes are the same width, so here equal
  `stroke-width` is equal weight; a box of another width would break it again.
- **Centre the box on the mark's body, not on its whole artwork.** AppKit centres the whole frame
  against the title, transparent margins included, so wherever the body sits inside the frame is
  where it lands. Both marks hang a star off their top-left corner, and counting it pushes the body
  the other way. The body is the envelope outline, and the calendar card without its ring binders.
  Both boxes are bigger than their body for this reason, and both bodies sit dead centre in them,
  which is what puts the two marks on the same line beside their titles.
- **Settle apparent size by looking, not by measuring.** Neither ink nor bounding box decides it on
  its own: view the two at true size, blurred until only their mass is left, and adjust the paths.

## Icon pipeline

- **Source of truth**: `apps/magimail/build/icon.svg` and `apps/magical/build/icon.svg`.
- **In-app branding**: `apps/magimail/resources/magimail.svg`, copied from the build asset. The
  native surfaces draw the mark in `packages/swift-brand` rather than this file.
- **Widgets**: a `.appex` cannot link `MagimailHelperLib`, so the extension links `HelperBrand`
  (`packages/swift-brand`) as a local SwiftPM package and compiles the app's `BrandArtwork.swift` and
  `Views.swift` by relative path instead.
- **Website**: the site shows `icon.svg` itself, copied from the app tree by `eleventy.config.mjs`.
  `src/assets/envelope.svg` and `hero-art.svg` are hand-maintained and have to be changed with it.
- **Generation**:

  ```bash
  cp apps/magimail/build/icon.svg apps/magimail/resources/magimail.svg
  swift apps/magimail/build/generate-icons.swift
  iconutil -c icns apps/magimail/build/icon.iconset -o apps/magimail/build/icon.icns
  ```

  `generate-icons.swift` writes the `.iconset` directory and `icon.png`; run `iconutil` to produce
  `icon.icns`.

- **The generator puts the artwork on Apple's icon grid and casts the template shadow.** Since Big
  Sur a macOS app icon body occupies 824 of a 1024 canvas and the remaining margin holds the shadow,
  which keeps every icon at the same visual size in the Dock. `icon.svg` carries a margin of its own,
  its squircle inset to 448 of 512, so the generator scales the artwork by the ratio between the two
  and then draws it with a black shadow at 30 % opacity, offset 10 down and blurred, on the 1024
  canvas. Rendering the shipping icons of Mail, Notes and Reminders at 1024 and reading the alpha off
  their edges gives the same body and shadow profile; that measurement is where the numbers come
  from, so change one only after repeating it. Magical's generator and its Dock tile carry the
  identical treatment; see [`../magical/dock-icon.md`](../magical/dock-icon.md).
- **Magical's Dock tile reads the SVG rather than embedding it.** `apps/magical/build/icon.svg` is
  shipped verbatim as `Contents/Resources/icon.svg` and loaded beside the dylib at runtime;
  `generate-icons.swift` no longer writes a Swift copy of it. The same file is therefore the source
  of truth for the `.icns` and the tile. See
  [`../magical/dock-icon.md#the-artwork-at-runtime`](../magical/dock-icon.md#the-artwork-at-runtime).
- **Nothing is drawn over the squircle's edge.** Both marks end at the body and let the template
  shadow do the separating, as Mail, Notes, Reminders and Terminal do.

## Dock tile

- **The dock tile is drawn in-process.** An `NSView` attached to `dockTile.contentView` renders with
  AppKit, Core Graphics and Core Text, which stays crisp at every Retina scale, and nothing
  rasterises a static bitmap through a Node library or pushes a large PNG buffer over
  `app.dock.setIcon()`. Magical's date tile, its midnight rollover and its badge are in
  [`../magical/dock-icon.md`](../magical/dock-icon.md).
- **Badge only what needs triage.** A dock badge counts unanswered meeting invites and unread inbox
  items. It never counts completed or merely scheduled events; a counter that can never reach zero
  only makes the user anxious.
