// swift-tools-version: 5.9
import PackageDescription

/// Shared SwiftUI chrome for the two helpers' settings windows.
///
/// Holds the window and tab host, the account list editor and its row, the
/// default-handler row, and the hex colour helpers. The tabs themselves — what
/// each app's General, Appearance, Notifications and Advanced panes contain —
/// stay in the app, because they read the app's own settings model.
///
/// Not a node package, so it carries no package.json and pnpm ignores it. It is
/// consumed by SwiftPM path dependency from apps/*/swift/Package.swift.
let package = Package(
    name: "HelperUI",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "HelperUI", targets: ["HelperUI"]),
    ],
    dependencies: [
        .package(path: "../swift-rpc"),
    ],
    targets: [
        .target(
            name: "HelperUI",
            dependencies: [.product(name: "HelperRPC", package: "swift-rpc")],
            path: "Sources/HelperUI"
        ),
        .testTarget(
            name: "HelperUITests",
            dependencies: ["HelperUI"],
            path: "Tests/HelperUITests"
        ),
    ]
)
