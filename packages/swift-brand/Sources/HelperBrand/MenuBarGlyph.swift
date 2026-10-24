import AppKit

/// A mark as a menu bar status item glyph.
///
/// Outline only — its stroke weight matches the system status items either side
/// of it, and any unread state is carried by the title beside it rather than a
/// second filled variant. It asks for the artwork as a template image, which is
/// what lets AppKit invert it to suit the menu bar it lands in (light, dark, or
/// wallpaper blur).
public struct MenuBarGlyph: Sendable {
    /// Which app's mark this is. Each app binds its own `BrandMark` and reaches
    /// it through `BrandMark.menuBarGlyph`.
    public let kind: BrandMarkKind

    public init(_ kind: BrandMarkKind) {
        self.kind = kind
    }

    /// Status item glyph 18pt wide. The height follows the box, so the room
    /// `MarkArtwork` leaves below the mark lifts it onto the middle of the
    /// title's capitals without resizing it.
    public var size: NSSize {
        NSSize(width: 18, height: 18 / mark.aspectRatio)
    }

    /// The glyph, or `nil` if the SVG cannot be rasterised.
    public func statusItemImage() -> NSImage? {
        MarkArtwork.definition(of: kind).image(width: size.width, template: true)
    }

    private var mark: BrandMark {
        BrandMark(kind)
    }
}
