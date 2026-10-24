/// Which app's mark to draw.
///
/// Both marks live in this package, so the menu bar, the popover and the widgets
/// cannot drift apart a line at a time, and this is the only thing that tells
/// them apart. Each app binds its own in `BrandArtwork.swift` and passes it
/// nowhere else.
public enum BrandMarkKind: CaseIterable, Sendable {
    case magimail
    case magical
}
