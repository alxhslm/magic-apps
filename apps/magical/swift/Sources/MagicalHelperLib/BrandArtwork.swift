import HelperBrand

/// The mark Magical draws, bound once.
///
/// `HelperBrand` holds both apps' artwork, the box rule and the rasteriser.
/// Naming `.magical` here is the only place this app says which mark is its own,
/// so the menu bar, the popover header and the widget headers cannot draw
/// different calendars. See `docs/shared/brand-and-icons.md`.
///
/// The widget extension compiles this file by reference and links `HelperBrand`
/// as a local package.
enum BrandArtwork {
    static let mark = BrandMark(.magical)
}
