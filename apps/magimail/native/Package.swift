// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MagimailNative",
    platforms: [.macOS(.v14)],
    products: [
        .library(
            name: "MagimailNative",
            type: .dynamic,
            targets: ["MagimailNative"]
        ),
    ],
    dependencies: [
        .package(path: "../../../packages/swift-native"),
    ],
    targets: [
        .target(
            name: "MagimailNative",
            dependencies: [
                .product(name: "SuiteNative", package: "swift-native"),
            ],
            path: "Sources"
        ),
    ]
)
