import AppKit

/// A mark in the brand's colours, for a popover header or a widget header.
///
/// The same artwork the menu bar draws, in the same box, asked for in colour
/// rather than as a template image. Only the width differs between the surfaces.
public struct BrandMark: Sendable {
    /// Which app's mark this is. Each app binds its own in `BrandArtwork.swift`.
    public let kind: BrandMarkKind

    public init(_ kind: BrandMarkKind) {
        self.kind = kind
    }

    /// Callers scale by this rather than picking a height; picking a height would
    /// squash the mark or drop the room that does the lining up.
    public var aspectRatio: CGFloat {
        definition.aspectRatio
    }

    /// Brand mark `width` points across, or `nil` if the SVG cannot be rasterised.
    ///
    /// 18, the width the other app's mark is drawn at too, and both boxes are 36
    /// across. The pair share a line weight only while they share a width: the
    /// stroke is set in box units, so drawing one larger for its own box would
    /// draw it bolder. See `docs/shared/brand-and-icons.md#glyph-grid`.
    public func image(width: CGFloat = 18) -> NSImage? {
        definition.image(width: width, template: false)
    }

    /// The same mark as a menu bar status item.
    public var menuBarGlyph: MenuBarGlyph {
        MenuBarGlyph(kind)
    }

    private var definition: BrandMarkDefinition {
        MarkArtwork.definition(of: kind)
    }
}
