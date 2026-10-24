# `HelperBrand`

The two brand marks, and the one rasteriser both apps draw them with. Three files of
mechanism, no app-specific content:

- `MarkArtwork.swift` — one definition per mark: the baked-in SVG, the box round it and the
  stroke weight. `BrandMarkKind` picks one, and `BrandMarkDefinition` holds the rasteriser.
- `BrandMark.swift` — the mark in the brand's colours, for a popover header or a widget
  header, at whatever width the caller asks for.
- `MenuBarGlyph.swift` — the same artwork as a menu bar status item: 18pt wide and a
  template image, so AppKit can invert it for the bar it lands in.

The paths are the one thing that differs between the marks. The box rule, the SVG
rasterisation and the template flag used to exist twice, in `apps/*/swift/Sources/*HelperLib`,
and drifted apart a line at a time.

## Using it

SwiftPM path dependency, from an app's `swift/Package.swift`:

```swift
.package(path: "../../../packages/swift-brand")
```

Each app then binds its own mark once, in `BrandArtwork.swift`:

```swift
import HelperBrand

enum BrandArtwork {
    static let mark = BrandMark(.magimail)
}
```

and every surface — the status item, the popover header, the widget headers — goes through
`BrandArtwork.mark`. That file is also compiled into the widget extension by reference; the
extension links `HelperBrand` as a local SwiftPM package, because a `.appex` cannot link the
app's helper library.

## What does not belong here

Anything that knows where a mark is drawn. The popover header, the widget layouts, the
status-item title and the fallback SF Symbols all stay in their app's own helper. A new
surface draws whatever `BrandArtwork.mark` gives it rather than reaching for the SVG.

It is not a node package and has no `package.json`, so pnpm's `packages/*` workspace glob
skips it.
