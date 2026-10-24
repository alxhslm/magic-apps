// swift-tools-version: 5.9
import PackageDescription

/// Shared brand artwork for Magimail's and Magical's native surfaces.
///
/// Both apps ship the same three surfaces — a menu bar status item, a popover
/// header and a widget header — and drew each with its own copy of the box rule,
/// the SVG rasteriser and the two wrappers. The paths differ between the marks;
/// nothing else does. `BrandMarkKind` picks a mark, and each app binds its own in
/// `BrandArtwork.swift`.
///
/// Not a node package, so it carries no package.json and pnpm ignores it. It is
/// consumed by SwiftPM path dependency from apps/*/swift/Package.swift, and by
/// each widget extension's Xcode target, which links it as a local package rather
/// than compiling the artwork files by reference.
let package = Package(
    name: "HelperBrand",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "HelperBrand", targets: ["HelperBrand"]),
    ],
    targets: [
        .target(
            name: "HelperBrand",
            path: "Sources/HelperBrand"
        ),
        .testTarget(
            name: "HelperBrandTests",
            dependencies: ["HelperBrand"],
            path: "Tests/HelperBrandTests"
        ),
    ]
)
