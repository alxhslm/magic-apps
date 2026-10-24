import HelperBrand

/// The mark Magimail draws, bound once.
///
/// `HelperBrand` holds both apps' artwork, the box rule and the rasteriser.
/// Naming `.magimail` here is the only place this app says which mark is its own,
/// so the menu bar, the popover header and the widget headers cannot draw
/// different envelopes. See `docs/shared/brand-and-icons.md`.
///
/// The widget extension compiles this file by reference and links `HelperBrand`
/// as a local package.
enum BrandArtwork {
    static let mark = BrandMark(.magimail)
}
