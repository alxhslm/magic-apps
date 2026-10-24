import AppKit

/// One mark: the paths, the box round them, and the stroke weight they use.
///
/// The rule the numbers obey is the same for both marks and is stated here; the
/// mark-specific part is stated beside the mark in `MarkArtwork`.
struct BrandMarkDefinition {
    /// One box unit is one device pixel: every surface draws the mark 18pt wide,
    /// and 18pt on a Retina display is 36 device pixels across.
    ///
    /// That is what keeps the mark sharp in a widget. A widget is drawn in an
    /// extension, out of the process that asked for it, and the artwork crosses
    /// that boundary as pixels rather than as paths. Whatever flattens it asks
    /// the SVG for a bitmap without naming a size and gets the box back, so the
    /// box has to be the device pixels the mark occupies or the widget shows it
    /// upscaled and soft. The menu bar and the popover never showed the fault:
    /// they draw in-process, where AppKit rasterises the paths at the screen's
    /// own scale and the box never comes into it.
    ///
    /// Both are integers, so the mark is a whole number of pixels either way.
    /// The box is bigger than the artwork and centred on the mark's body, not on
    /// its whole artwork, because AppKit centres the whole frame against the
    /// title, transparent margins included. See
    /// `docs/shared/brand-and-icons.md#glyph-grid`.
    let boxWidth: CGFloat
    let boxHeight: CGFloat

    /// Whole units, so the mark's straight runs cover whole pixels.
    ///
    /// A stroke is crisp when it is an even number of device pixels wide and its
    /// centreline sits on a whole one, which is why every horizontal and vertical
    /// coordinate in the artwork below is an integer.
    ///
    /// Line weight is a property of the pair, never a lever for apparent size:
    /// the two glyphs share a line weight only while they share a width, because
    /// the stroke is set in box units. Both boxes are the same width, so here
    /// equal `stroke-width` is equal weight; a box of another width would break
    /// it again.
    let strokeWidth: CGFloat

    /// Drawn in the brand's colours even for the menu bar, where `isTemplate`
    /// keeps only the alpha.
    let svg: String

    /// Callers set a width and take the height from this; picking a height would
    /// squash the mark or drop the room that does the lining up.
    var aspectRatio: CGFloat {
        boxWidth / boxHeight
    }

    /// The mark `width` points across, or `nil` if the SVG cannot be rasterised.
    func image(width: CGFloat, template: Bool) -> NSImage? {
        guard let image = NSImage(data: Data(svg.utf8)) else { return nil }
        image.size = NSSize(width: width, height: width / aspectRatio)
        image.isTemplate = template
        return image
    }
}
