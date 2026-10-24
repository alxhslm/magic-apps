// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MagicalNative",
    platforms: [.macOS(.v14)],
    products: [
        .library(
            name: "MagicalNative",
            type: .dynamic,
            targets: ["MagicalNative"]
        ),
    ],
    dependencies: [
        .package(path: "../../../packages/swift-native"),
    ],
    targets: [
        .target(
            name: "MagicalNative",
            dependencies: [
                .product(name: "SuiteNative", package: "swift-native"),
            ],
            path: "Sources"
        ),
    ]
)
