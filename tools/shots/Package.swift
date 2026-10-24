// swift-tools-version: 5.9
import PackageDescription

/// Renders the website's native screenshots from the real views, so a shot can
/// never show a layout the app no longer draws.
let package = Package(
    name: "shots",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "magical-helper"),
        .package(path: "magimail-helper"),
    ],
    targets: [
        .executableTarget(
            name: "shots",
            dependencies: [
                .product(name: "MagicalHelperLib", package: "magical-helper"),
                .product(name: "MagimailHelperLib", package: "magimail-helper"),
            ],
            path: "Sources/shots"
        ),
        // The SF Symbols the help pages name, rendered as alpha masks for the
        // stylesheet to tint. Depends on nothing, so it builds on its own.
        .executableTarget(
            name: "symbols",
            path: "Sources/symbols"
        ),
    ]
)
