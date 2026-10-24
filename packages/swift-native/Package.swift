// swift-tools-version: 5.9
import PackageDescription

/// Shared in-process AppKit & macOS native foundation for Magimail and Magical.
///
/// Holds native plumbing that must run inside Electron's main process (AppKit
/// NSToolbar lifecycle, item validation, account segmented controls, and WidgetCenter
/// timeline reloads).
///
/// Not a node package, so it carries no package.json and pnpm ignores it. It is
/// consumed by SwiftPM path dependency from apps/*/native/Package.swift.
let package = Package(
    name: "SuiteNative",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "SuiteNative", targets: ["SuiteNative"]),
    ],
    targets: [
        .target(
            name: "SuiteNative",
            path: "Sources/SuiteNative"
        ),
    ]
)
