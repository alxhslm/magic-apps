// swift-tools-version: 5.9
import PackageDescription

/// The JSON-RPC transport both apps' Swift helpers speak to Electron.
///
/// Not a node package, so it carries no package.json and pnpm ignores it. It is
/// consumed by SwiftPM path dependency from apps/*/swift/Package.swift.
let package = Package(
    name: "HelperRPC",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "HelperRPC", targets: ["HelperRPC"]),
    ],
    targets: [
        .target(name: "HelperRPC", path: "Sources/HelperRPC"),
        .testTarget(
            name: "HelperRPCTests",
            dependencies: ["HelperRPC"],
            path: "Tests/HelperRPCTests"
        ),
    ]
)
