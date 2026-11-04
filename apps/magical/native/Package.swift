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
        .package(path: "../swift"),
        .package(path: "../../../packages/swift-native"),
    ],
    targets: [
        .target(
            name: "MagicalNative",
            dependencies: [
                .product(name: "MagicalHelperLib", package: "swift"),
                .product(name: "SuiteNative", package: "swift-native"),
            ],
            path: "Sources"
        ),
        .testTarget(
            name: "MagicalNativeTests",
            dependencies: ["MagicalNative"],
            path: "Tests"
        ),
    ]
)
