import AppKit
import HelperRPC
import SwiftUI

/// One tab in a helper's settings window.
///
/// The content is opaque to this package on purpose: it is already carrying the
/// app's settings model through the environment, and the window only has to
/// frame it, label it and put it in a `TabView`.
@MainActor
public struct SettingsTab {
    /// Names the pane for `SettingsWindowController.show(_:pane:)`, so a caller
    /// asking for "accounts" does not have to know where in the tab order it sits.
    public let id: String
    public let label: String
    public let icon: String
    /// The height of the content view, before the 40pt the window adds for the tab bar.
    public let height: CGFloat
    public let content: () -> AnyView

    public init(
        id: String,
        label: String,
        icon: String,
        height: CGFloat,
        @ViewBuilder content: @escaping () -> some View
    ) {
        self.id = id
        self.label = label
        self.icon = icon
        self.height = height
        self.content = { AnyView(content()) }
    }
}

/// The window title and tab order one app's settings window is built from.
public struct SettingsWindowSpec {
    public let title: String
    public let tabs: [SettingsTab]

    public init(title: String, tabs: [SettingsTab]) {
        self.title = title
        self.tabs = tabs
    }
}

/// The window and tab host both helpers put their settings panes in.
///
/// The chrome is identical in the two apps; only the title, the tabs and their
/// heights differ, so the app builds a `SettingsWindowSpec` and this owns the
/// `NSWindow`, the `NSTabViewController` and the pane selection. The panes stay
/// in the app, because they read the app's own settings model.
@MainActor
public final class SettingsWindowController {
    public static let shared = SettingsWindowController()

    private var window: NSWindow?
    private var tabVC: NSTabViewController?
    private var spec: SettingsWindowSpec?

    public func show(_ spec: SettingsWindowSpec, pane: String? = nil) {
        self.spec = spec

        if let window, window.isVisible, let tabVC {
            if let pane {
                selectPane(pane, in: tabVC)
            }
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let tabVC = NSTabViewController()
        tabVC.tabStyle = .toolbar
        tabVC.title = spec.title

        for tab in spec.tabs {
            let view = tab.content()
                .frame(width: 400, height: tab.height)
                .padding(30)
            let host = NSHostingView(rootView: view)
            let vc = NSViewController()
            vc.view = host
            vc.preferredContentSize = NSSize(width: 500, height: tab.height + 40)
            let item = NSTabViewItem(viewController: vc)
            item.label = tab.label
            item.image = NSImage(systemSymbolName: tab.icon, accessibilityDescription: tab.label)
            tabVC.addTabViewItem(item)
        }

        if let pane {
            selectPane(pane, in: tabVC)
        }

        let window = NSWindow(contentViewController: tabVC)
        window.title = spec.title
        window.titleVisibility = .visible
        window.center()
        window.isReleasedWhenClosed = false
        window.delegate = WindowDelegate.shared

        self.window = window
        self.tabVC = tabVC
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func selectPane(_ pane: String, in tabVC: NSTabViewController) {
        HelperLog.info("Settings", "Switched settings pane to \(pane)")
        guard let spec,
              let index = spec.tabs.firstIndex(where: { $0.id == pane.lowercased() })
        else { return }
        tabVC.selectedTabViewItemIndex = index
    }

    public func close() {
        HelperLog.info("Settings", "Settings window closed")
        window?.close()
        window = nil
        tabVC = nil
        spec = nil
    }
}

private final class WindowDelegate: NSObject, NSWindowDelegate {
    static let shared = WindowDelegate()

    func windowWillClose(_: Notification) {
        HelperLog.info("Settings", "Settings window will close")
        Task { @MainActor in
            SettingsWindowController.shared.close()
        }
    }
}
