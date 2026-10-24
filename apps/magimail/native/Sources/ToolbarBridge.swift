import AppKit
import SuiteNative

// MARK: - C-callable bridge for the Node addon

/// Callback type for toolbar actions sent back to JavaScript.
public typealias ToolbarActionCallback = @convention(c) (UnsafePointer<CChar>, UnsafePointer<CChar>) -> Void

@_cdecl("toolbar_set_callback")
public func toolbarSetCallback(_ cb: @escaping ToolbarActionCallback) {
    ActionBridge.callback = cb
}

@_cdecl("toolbar_attach")
public func toolbarAttach(_ nsViewPtr: UnsafeMutableRawPointer) {
    let contentView = Unmanaged<NSView>.fromOpaque(nsViewPtr).takeUnretainedValue()
    guard let window = contentView.window else { return }

    DispatchQueue.main.async {
        ToolbarManager.shared.attach(to: window)
    }
}

@_cdecl("toolbar_detach")
public func toolbarDetach() {
    DispatchQueue.main.async {
        ToolbarManager.shared.detach()
    }
}

@_cdecl("toolbar_update_accounts")
public func toolbarUpdateAccounts(_ json: UnsafePointer<CChar>) {
    let str = String(cString: json)
    DispatchQueue.main.async {
        ToolbarManager.shared.updateAccounts(json: str)
    }
}

/// The app's toolbar strings, pushed from its UI catalogue before the toolbar is
/// built. The addon is a dylib loaded into Electron, not a bundle, so there is no
/// String Catalog for Foundation to read here.
@_cdecl("toolbar_update_labels")
public func toolbarUpdateLabels(_ json: UnsafePointer<CChar>) {
    let str = String(cString: json)
    DispatchQueue.main.async {
        ToolbarManager.shared.updateLabels(json: str)
    }
}

@_cdecl("toolbar_run_customization")
public func toolbarRunCustomization() {
    DispatchQueue.main.async {
        ToolbarManager.shared.runCustomization()
    }
}

@_cdecl("toolbar_set_share_url")
public func toolbarSetShareUrl(_ urlPtr: UnsafePointer<CChar>) {
    let url = String(cString: urlPtr)
    DispatchQueue.main.async {
        ToolbarManager.shared.setShareUrl(url)
    }
}

@_cdecl("toolbar_set_item_enabled")
public func toolbarSetItemEnabled(_ itemIdPtr: UnsafePointer<CChar>, _ enabled: Bool) {
    let itemId = String(cString: itemIdPtr)
    DispatchQueue.main.async {
        ToolbarManager.shared.setItemEnabled(id: itemId, enabled: enabled)
    }
}

// MARK: - Magimail Toolbar Manager

@MainActor
final class ToolbarManager: ToolbarManagerBase {
    static let shared = ToolbarManager()

    override var toolbarIdentifier: NSToolbar.Identifier {
        NSToolbar.Identifier("MagimailToolbar")
    }

    override var accountsItemIdentifier: NSToolbarItem.Identifier {
        Self.accountsID
    }

    /// A sideways wheel notch scrolls here rather than moving through history, which is
    /// what a reader expects of a wheel. The trackpad and the side buttons navigate.
    override var mouseNavigationSources: MouseNavigationMonitor.Sources {
        [.trackpad, .sideButtons]
    }

    // Item identifiers
    private static let accountsID = NSToolbarItem.Identifier("accounts")
    private static let composeID = NSToolbarItem.Identifier("compose")
    private static let archiveID = NSToolbarItem.Identifier("archive")
    private static let trashID = NSToolbarItem.Identifier("trash")
    // Identifier string stays "markRead": `autosavesConfiguration` persists it
    // into the user's saved layout, and an identifier the delegate no longer
    // knows is dropped from that layout silently. The label and the action it
    // sends are free to be renamed; this string is not.
    private static let toggleReadID = NSToolbarItem.Identifier("markRead")
    private static let manageGroupID = NSToolbarItem.Identifier("manageGroup")
    private static let replyID = NSToolbarItem.Identifier("reply")
    private static let replyAllID = NSToolbarItem.Identifier("replyAll")
    private static let forwardID = NSToolbarItem.Identifier("forward")
    private static let replyGroupID = NSToolbarItem.Identifier("replyGroup")
    private static let searchID = NSToolbarItem.Identifier("search")
    private static let printID = NSToolbarItem.Identifier("print")
    private static let shareID = NSToolbarItem.Identifier("share")

    /// The share picker asks for its items synchronously, so the link has to be
    /// here before the user clicks rather than fetched on demand.
    func setShareUrl(_ string: String) {
        ShareItemsProvider.shared.url = string.isEmpty ? nil : URL(string: string)
        toolbar?.validateVisibleItems()
    }

    // MARK: - NSToolbarDelegate

    override func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        switch itemIdentifier {
        case Self.accountsID:
            return super.toolbar(toolbar, itemForItemIdentifier: itemIdentifier, willBeInsertedIntoToolbar: flag)
        case Self.composeID:
            return ToolbarBuilder.makeButton(
                itemIdentifier, symbol: "square.and.pencil",
                label: labels["toolbar.newMessage"], action: "newMessage"
            )
        case Self.searchID:
            return ToolbarBuilder.makeSearchItem(itemIdentifier, placeholder: labels[ToolbarLabelKey.search])
        case Self.archiveID:
            return ToolbarBuilder.makeButton(
                itemIdentifier, symbol: "archivebox",
                label: labels["toolbar.archive"], action: "archive"
            )
        case Self.trashID:
            return ToolbarBuilder.makeButton(
                itemIdentifier, symbol: "trash",
                label: labels["toolbar.delete"], action: "trash"
            )
        case Self.toggleReadID:
            return ToolbarBuilder.makeButton(
                itemIdentifier, symbol: "envelope",
                label: labels["toolbar.toggleRead"], action: "toggleRead"
            )
        case Self.manageGroupID:
            return ToolbarBuilder.makeGroup(itemIdentifier, label: labels["toolbar.manage"], members: [
                ("archivebox", labels["toolbar.archive"], "archive"),
                ("trash", labels["toolbar.delete"], "trash"),
                ("envelope", labels["toolbar.toggleRead"], "toggleRead"),
            ])
        case Self.replyID:
            return ToolbarBuilder.makeButton(
                itemIdentifier, symbol: "arrowshape.turn.up.left",
                label: labels["toolbar.reply"], action: "reply", needsMessage: true
            )
        case Self.replyAllID:
            return ToolbarBuilder.makeButton(
                itemIdentifier, symbol: "arrowshape.turn.up.left.2",
                label: labels["toolbar.replyAll"], action: "replyAll", needsMessage: true
            )
        case Self.forwardID:
            return ToolbarBuilder.makeButton(
                itemIdentifier, symbol: "arrowshape.turn.up.right",
                label: labels["toolbar.forward"], action: "forward", needsMessage: true
            )
        case Self.replyGroupID:
            ItemValidation.shared.setDefault(itemIdentifier, enabled: false)
            let group = ToolbarBuilder.makeGroup(
                itemIdentifier, label: labels["toolbar.reply"], needsMessage: true, members: [
                    ("arrowshape.turn.up.left", labels["toolbar.reply"], "reply"),
                    ("arrowshape.turn.up.left.2", labels["toolbar.replyAll"], "replyAll"),
                    ("arrowshape.turn.up.right", labels["toolbar.forward"], "forward"),
                ]
            )
            group.isEnabled = ItemValidation.shared.isEnabled(itemIdentifier)
            return group
        case Self.printID:
            return makePrintMenuButton(itemIdentifier)
        case Self.shareID:
            return makeShareItem(itemIdentifier)
        default:
            return nil
        }
    }

    override func toolbarDefaultItemIdentifiers(_: NSToolbar) -> [NSToolbarItem.Identifier] {
        [
            Self.accountsID,
            .flexibleSpace,
            Self.composeID,
            Self.shareID,
            Self.printID,
        ]
    }

    override func toolbarImmovableItemIdentifiers(_: NSToolbar) -> Set<NSToolbarItem.Identifier> {
        [Self.accountsID]
    }

    override func toolbarAllowedItemIdentifiers(_: NSToolbar) -> [NSToolbarItem.Identifier] {
        [
            Self.accountsID,
            .flexibleSpace,
            .space,
            Self.composeID,
            Self.shareID,
            Self.printID,
            Self.searchID,
            Self.archiveID,
            Self.trashID,
            Self.toggleReadID,
            Self.replyID,
            Self.replyAllID,
            Self.forwardID,
            Self.manageGroupID,
            Self.replyGroupID,
        ]
    }

    // MARK: - Magimail-specific Item Helpers

    private func makePrintMenuButton(_ id: NSToolbarItem.Identifier) -> NSToolbarItem {
        let item = ValidatedMenuToolbarItem(itemIdentifier: id)
        item.label = labels["toolbar.print"]
        item.toolTip = labels["toolbar.print.toolTip"]
        item.image = NSImage(systemSymbolName: "printer", accessibilityDescription: labels["toolbar.print"])
        item.showsIndicator = false
        item.isBordered = true
        ItemValidation.shared.setDefault(id, enabled: false)
        item.isEnabled = ItemValidation.shared.isEnabled(id)

        let menu = NSMenu()
        menu.autoenablesItems = false

        let printItem = NSMenuItem(title: labels["toolbar.print.menuPrint"], action: nil, keyEquivalent: "p")
        printItem.image = NSImage(systemSymbolName: "printer", accessibilityDescription: nil)
        MenuActionTarget.shared.register(printItem, action: "print")
        menu.addItem(printItem)

        let exportItem = NSMenuItem(title: labels["toolbar.print.menuExport"], action: nil, keyEquivalent: "")
        exportItem.image = NSImage(systemSymbolName: "arrow.down.doc", accessibilityDescription: nil)
        MenuActionTarget.shared.register(exportItem, action: "exportPdf")
        menu.addItem(exportItem)

        item.menu = menu
        return item
    }

    private func makeShareItem(_ id: NSToolbarItem.Identifier) -> NSToolbarItem {
        let item = ValidatedSharingToolbarItem(itemIdentifier: id)
        item.label = labels["toolbar.share"]
        item.toolTip = labels["toolbar.share.toolTip"]
        item.delegate = ShareItemsProvider.shared
        ItemValidation.shared.setDefault(id, enabled: false)
        item.isEnabled = ItemValidation.shared.isEnabled(id)
        return item
    }
}

// MARK: - Menu action target

private final class MenuActionTarget: NSObject {
    static let shared = MenuActionTarget()
    private var actions: [ObjectIdentifier: String] = [:]

    func register(_ item: NSMenuItem, action: String) {
        actions[ObjectIdentifier(item)] = action
        item.target = self
        item.action = #selector(handleMenuClick(_:))
    }

    @objc func handleMenuClick(_ sender: NSMenuItem) {
        if let action = actions[ObjectIdentifier(sender)] {
            ActionBridge.emit(action)
        }
    }
}

// MARK: - Share items

private final class ShareItemsProvider: NSObject, NSSharingServicePickerToolbarItemDelegate {
    static let shared = ShareItemsProvider()

    var url: URL?

    func items(for _: NSSharingServicePickerToolbarItem) -> [Any] {
        guard let url else { return [] }
        return [url]
    }
}
