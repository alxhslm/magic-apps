// swift-tools-version: 5.9
import PackageDescription

/// Shared `UNUserNotificationCenter` plumbing for Magimail's and Magical's Swift helpers.
///
/// Both helpers claim the notification centre delegate, register categories, ask for
/// authorisation at launch, post a request and route a pressed action back over the RPC
/// pipe. That half is identical; the categories, the content and the action vocabulary
/// are not, and stay in each app's own controller.
///
/// Not a node package, so it carries no package.json and pnpm ignores it. It is consumed
/// by SwiftPM path dependency from apps/*/swift/Package.swift.
let package = Package(
    name: "HelperNotifications",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "HelperNotifications", targets: ["HelperNotifications"]),
    ],
    dependencies: [
        .package(path: "../swift-rpc"),
    ],
    targets: [
        .target(
            name: "HelperNotifications",
            dependencies: [.product(name: "HelperRPC", package: "swift-rpc")],
            path: "Sources/HelperNotifications"
        ),
    ]
)
