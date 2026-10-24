// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MagicalHelper",
    platforms: [.macOS(.v14)],
    products: [
        // Exposed so `tools/shots` can render the popover for the website.
        .library(name: "MagicalHelperLib", targets: ["MagicalHelperLib"]),
    ],
    dependencies: [
        .package(path: "../../../packages/swift-rpc"),
        .package(path: "../../../packages/swift-notifications"),
        .package(path: "../../../packages/swift-brand"),
        .package(path: "../../../packages/swift-ui"),
    ],
    targets: [
        .target(
            name: "MagicalHelperLib",
            dependencies: [
                .product(name: "HelperRPC", package: "swift-rpc"),
                .product(name: "HelperNotifications", package: "swift-notifications"),
                .product(name: "HelperBrand", package: "swift-brand"),
                .product(name: "HelperUI", package: "swift-ui"),
            ],
            path: "Sources/MagicalHelperLib"
        ),
        .executableTarget(
            name: "MagicalHelper",
            dependencies: [
                "MagicalHelperLib",
                .product(name: "HelperRPC", package: "swift-rpc"),
            ],
            path: "Sources/MagicalHelper"
        ),
        .testTarget(
            name: "MagicalHelperLibTests",
            dependencies: ["MagicalHelperLib"],
            path: "Tests/MagicalHelperLibTests"
        ),
    ]
)
