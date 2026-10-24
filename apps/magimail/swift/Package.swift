// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MagimailHelper",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "MagimailHelperLib", targets: ["MagimailHelperLib"]),
    ],
    dependencies: [
        .package(path: "../../../packages/swift-rpc"),
        .package(path: "../../../packages/swift-notifications"),
        .package(path: "../../../packages/swift-brand"),
        .package(path: "../../../packages/swift-ui"),
    ],
    targets: [
        .target(
            name: "MagimailHelperLib",
            dependencies: [
                .product(name: "HelperRPC", package: "swift-rpc"),
                .product(name: "HelperNotifications", package: "swift-notifications"),
                .product(name: "HelperBrand", package: "swift-brand"),
                .product(name: "HelperUI", package: "swift-ui"),
            ],
            path: "Sources/MagimailHelperLib"
        ),
        .executableTarget(
            name: "MagimailHelper",
            dependencies: [
                "MagimailHelperLib",
                .product(name: "HelperRPC", package: "swift-rpc"),
            ],
            path: "Sources/MagimailHelper"
        ),
        .testTarget(
            name: "MagimailHelperLibTests",
            dependencies: ["MagimailHelperLib"],
            path: "Tests/MagimailHelperLibTests"
        ),
    ]
)
