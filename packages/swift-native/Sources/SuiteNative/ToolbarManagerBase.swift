import AppKit

// MARK: - Toolbar Manager Base

/// Shared AppKit window lifecycle and toolbar management.
///
/// Encapsulates the delicate Cocoa window setup:
/// - Handling closed/reopened windows from the Dock (re-binding toolbar to the new NSWindow)
/// - Setting .unified style, hidden title, and borderless titlebar
/// - Persisting customization palette layouts via autosavesConfiguration
/// - Descending into groups to apply enabled/disabled states across AppKit validation passes
/// - Updating the AccountSegmentedControl on account state updates
@MainActor
open class ToolbarManagerBase: NSObject, NSToolbarDelegate {
    public private(set) var toolbar: NSToolbar?
    public private(set) weak var window: NSWindow?
    public let model = ToolbarModel()
    private var mouseNavigation: MouseNavigationMonitor?

    /// The app's toolbar strings, pushed before the toolbar is built. See
    /// `ToolbarLabels` and `docs/shared/native-ui.md#localised-labels`.
    public private(set) var labels = ToolbarLabels()

    open var toolbarIdentifier: NSToolbar.Identifier {
        NSToolbar.Identifier("SuiteToolbar")
    }

    open var accountsItemIdentifier: NSToolbarItem.Identifier {
        NSToolbarItem.Identifier("accounts")
    }

    open var showUnreadCountsInSwitcher: Bool {
        true
    }

    /// The inputs this app answers with a navigation. See `MouseNavigationMonitor.Sources`.
    open var mouseNavigationSources: MouseNavigationMonitor.Sources {
        .all
    }

    override public init() {
        super.init()
        mouseNavigation = MouseNavigationMonitor { [weak self] direction, source in
            self?.handleMouseNavigation(direction: direction, source: source)
        }
    }

    /// Translates mouse and gesture navigation into bridge actions.
    open func handleMouseNavigation(
        direction: MouseNavigationMonitor.Direction,
        source _: MouseNavigationMonitor.Sources
    ) {
        ActionBridge.emit(direction == .back ? "goBack" : "goForward")
    }

    open func attach(to window: NSWindow) {
        // A closed and reopened main window arrives here as a *different*
        // NSWindow. Without this the guard below would keep the toolbar bound
        // to the dead one and the new window would come up bare.
        if self.window !== window {
            detach()
        }

        guard toolbar == nil else { return }
        self.window = window

        mouseNavigation?.sources = mouseNavigationSources
        mouseNavigation?.install(for: window)

        let tb = NSToolbar(identifier: toolbarIdentifier)
        tb.delegate = self
        tb.displayMode = .iconOnly
        tb.allowsUserCustomization = true
        // AppKit persists customization layout to user defaults under toolbarIdentifier.
        tb.autosavesConfiguration = true

        window.toolbar = tb
        window.titleVisibility = .hidden
        window.titlebarSeparatorStyle = .none
        window.toolbarStyle = .unified

        toolbar = tb
    }

    open func detach() {
        mouseNavigation?.remove()
        window?.toolbar = nil
        toolbar = nil
        window = nil
    }

    open func runCustomization() {
        toolbar?.runCustomizationPalette(nil)
    }

    /// Every item in the toolbar, with each group followed by its members.
    public static func items(in toolbar: NSToolbar?) -> [NSToolbarItem] {
        (toolbar?.items ?? []).flatMap { item -> [NSToolbarItem] in
            guard let group = item as? NSToolbarItemGroup else { return [item] }
            return [group] + group.subitems
        }
    }

    open func setItemEnabled(id: String, enabled: Bool) {
        let identifier = NSToolbarItem.Identifier(id)
        ItemValidation.shared.set(identifier, enabled: enabled)

        // Both halves are needed. Recording state survives AppKit's own
        // validation passes; writing isEnabled here makes it land for plain items.
        // Lookups descend into groups to reach subitems.
        if let item = Self.items(in: toolbar).first(where: { $0.itemIdentifier == identifier }) {
            item.isEnabled = enabled
        }

        toolbar?.validateVisibleItems()
    }

    open func updateAccounts(json: String) {
        guard let data = json.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }

        if let accounts = parsed["accounts"] as? [[String: Any]] {
            model.accounts = accounts.map { ToolbarAccount(from: $0) }
        }
        if let activeId = parsed["activeAccountId"] as? String {
            model.activeAccountId = activeId
        }

        // Refresh the accounts toolbar item
        if let item = toolbar?.items.first(where: { $0.itemIdentifier == accountsItemIdentifier }) {
            configureAccountsItem(item)
        }
    }

    /// Records the app's toolbar strings. Pushed before `attach`, so the items
    /// AppKit builds already have their final labels. The locale is read once at
    /// launch, as macOS applies a system language change at launch, so there is
    /// nothing to re-label in a running session.
    open func updateLabels(json: String) {
        guard let data = json.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = parsed["labels"] as? [String: String]
        else { return }

        labels = ToolbarLabels(raw)
    }

    open func configureAccountsItem(_ item: NSToolbarItem) {
        guard model.accounts.count > 1 else {
            item.view = NSView(frame: .zero)
            return
        }

        // Reused in place rather than rebuilt so unread count changes don't trigger full relayout.
        let control = (item.view as? AccountSegmentedControl) ?? AccountSegmentedControl(showUnreadCounts: showUnreadCountsInSwitcher)
        control.labels = labels
        control.configure(accounts: model.accounts, activeAccountId: model.activeAccountId)

        if item.view !== control {
            item.view = control
        }
    }

    // MARK: - NSToolbarDelegate stubs to override

    open func toolbar(
        _: NSToolbar,
        itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar _: Bool
    ) -> NSToolbarItem? {
        if itemIdentifier == accountsItemIdentifier {
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            configureAccountsItem(item)
            return item
        }
        return nil
    }

    open func toolbarDefaultItemIdentifiers(_: NSToolbar) -> [NSToolbarItem.Identifier] {
        [accountsItemIdentifier]
    }

    open func toolbarAllowedItemIdentifiers(_: NSToolbar) -> [NSToolbarItem.Identifier] {
        [accountsItemIdentifier, .space, .flexibleSpace]
    }

    open func toolbarImmovableItemIdentifiers(_: NSToolbar) -> Set<NSToolbarItem.Identifier> {
        [accountsItemIdentifier]
    }
}
