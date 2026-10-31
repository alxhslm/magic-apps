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

@_cdecl("toolbar_update_invites")
public func toolbarUpdateInvites(_ json: UnsafePointer<CChar>) {
    let str = String(cString: json)
    DispatchQueue.main.async {
        ToolbarManager.shared.updateInvites(json: str)
    }
}

@_cdecl("toolbar_run_customization")
public func toolbarRunCustomization() {
    DispatchQueue.main.async {
        ToolbarManager.shared.runCustomization()
    }
}

@_cdecl("toolbar_set_item_enabled")
public func toolbarSetItemEnabled(_ itemIdPtr: UnsafePointer<CChar>, _ enabled: Bool) {
    let itemId = String(cString: itemIdPtr)
    DispatchQueue.main.async {
        ToolbarManager.shared.setItemEnabled(id: itemId, enabled: enabled)
    }
}

// MARK: - Calendar Navigation Segmented Control

/// A toolbar item whose control follows the item's validated enabled state.
///
/// AppKit does not forward an item's `isEnabled` onto a view placed on it, so a
/// segmented control would dim for nothing. `< Today >` is disabled in Tasks mode
/// through `toolbar_set_item_enabled`, and `validate()` is what re-applies that
/// state after AppKit's own revalidation passes and after a toolbar customisation
/// rebuilds the item.
final class ControlToolbarItem: ValidatedToolbarItem {
    override func validate() {
        super.validate()
        (view as? NSControl)?.isEnabled = isEnabled
    }
}

final class NavSegmentedControl: NSSegmentedControl {
    convenience init(labels: ToolbarLabels) {
        self.init(frame: .zero)
        segmentStyle = .automatic
        trackingMode = .momentary
        segmentDistribution = .fit
        segmentCount = 3

        let config = NSImage.SymbolConfiguration(pointSize: 11, weight: .medium)

        if let prevImg = NSImage(
            systemSymbolName: "chevron.left",
            accessibilityDescription: labels["toolbar.nav.previous"]
        )?.withSymbolConfiguration(config) {
            setImage(prevImg, forSegment: 0)
        } else {
            setLabel("<", forSegment: 0)
        }
        setToolTip(labels["toolbar.nav.previous"], forSegment: 0)

        setLabel(labels["toolbar.nav.today"], forSegment: 1)
        setToolTip(labels["toolbar.nav.today.toolTip"], forSegment: 1)

        if let nextImg = NSImage(
            systemSymbolName: "chevron.right",
            accessibilityDescription: labels["toolbar.nav.next"]
        )?.withSymbolConfiguration(config) {
            setImage(nextImg, forSegment: 2)
        } else {
            setLabel(">", forSegment: 2)
        }
        setToolTip(labels["toolbar.nav.next"], forSegment: 2)

        target = self
        action = #selector(handleSelection)
        sizeToFit()
    }

    @objc private func handleSelection() {
        switch selectedSegment {
        case 0:
            ActionBridge.emit("navPrev")
        case 1:
            ActionBridge.emit("navToday")
        case 2:
            ActionBridge.emit("navNext")
        default:
            break
        }
    }
}

// MARK: - Magical Toolbar Manager

@MainActor
final class ToolbarManager: ToolbarManagerBase {
    static let shared = ToolbarManager()

    override var toolbarIdentifier: NSToolbar.Identifier {
        NSToolbar.Identifier("MagicalToolbar")
    }

    override var accountsItemIdentifier: NSToolbarItem.Identifier {
        Self.accountsID
    }

    override var showUnreadCountsInSwitcher: Bool {
        false
    }

    /// Sideways movement moves the period, and the side buttons navigate back
    /// and forward (exiting settings/search/editor or traversing history).
    override var mouseNavigationSources: MouseNavigationMonitor.Sources {
        [.sideButtons, .trackpad, .wheel]
    }

    override func handleMouseNavigation(
        direction: MouseNavigationMonitor.Direction,
        source: MouseNavigationMonitor.Sources
    ) {
        if source.contains(.sideButtons) {
            ActionBridge.emit(direction == .back ? "goBack" : "goForward")
        } else {
            // Trackpad swipe and horizontal wheel move the calendar period.
            ActionBridge.emit(direction == .back ? "navPrev" : "navNext")
        }
    }

    // Item identifiers
    private static let accountsID = NSToolbarItem.Identifier("accounts")
    private static let navGroupID = NSToolbarItem.Identifier("navGroup")
    private static let searchID = NSToolbarItem.Identifier("search")
    private static let addEventID = NSToolbarItem.Identifier("addEvent")
    private static let addTaskID = NSToolbarItem.Identifier("addTask")
    private static let invitesID = NSToolbarItem.Identifier("invites")
    private static let toggleSidebarID = NSToolbarItem.Identifier("toggleSidebar")

    // MARK: - NSToolbarDelegate

    override func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        switch itemIdentifier {
        case Self.accountsID:
            return super.toolbar(toolbar, itemForItemIdentifier: itemIdentifier, willBeInsertedIntoToolbar: flag)

        case Self.navGroupID:
            let item = ControlToolbarItem(itemIdentifier: itemIdentifier)
            item.label = labels["toolbar.navigation"]
            item.view = NavSegmentedControl(labels: labels)
            return item

        case Self.addTaskID:
            return ToolbarBuilder.makeButton(
                itemIdentifier,
                symbol: "circle.badge.plus",
                label: labels["toolbar.newTask"],
                action: "quickAddTask"
            )

        case Self.addEventID:
            let item = ToolbarBuilder.makeButton(
                itemIdentifier,
                symbol: "calendar.badge.plus",
                label: labels["toolbar.newEvent"],
                action: "quickAdd"
            )
            if item.image == nil {
                item.image = NSImage(
                    systemSymbolName: "plus",
                    accessibilityDescription: labels["toolbar.newEvent"]
                )
            }
            return item

        case Self.invitesID:
            return makeInvitesItem(itemIdentifier)

        case Self.toggleSidebarID:
            return ToolbarBuilder.makeButton(
                itemIdentifier,
                symbol: "sidebar.right",
                label: labels["toolbar.toggleSidebar"],
                action: "toggleSidebar"
            )

        case Self.searchID:
            return ToolbarBuilder.makeSearchItem(itemIdentifier, placeholder: labels[ToolbarLabelKey.search])

        default:
            return nil
        }
    }

    override func toolbarDefaultItemIdentifiers(_: NSToolbar) -> [NSToolbarItem.Identifier] {
        [
            Self.accountsID,
            .flexibleSpace,
            Self.navGroupID,
            .flexibleSpace,
            Self.invitesID,
            Self.addTaskID,
            Self.addEventID,
            Self.toggleSidebarID,
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
            Self.navGroupID,
            Self.invitesID,
            Self.addTaskID,
            Self.addEventID,
            Self.toggleSidebarID,
            Self.searchID,
        ]
    }

    // MARK: - Invitations inbox

    /// Rebuilds the dropdown from the outstanding set the main process just sent.
    ///
    /// The whole list arrives every time rather than as a diff. It is at most a couple of
    /// dozen entries, and a menu rebuilt wholesale cannot disagree with the badge, which
    /// is counted from the same array on the same call.
    func updateInvites(json: String) {
        guard let data = json.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = root["invites"] as? [[String: Any]]
        else { return }

        invites = raw.map { PendingInviteItem(from: $0) }
        badgeCount = root["count"] as? Int

        guard let item = toolbar?.items.first(where: { $0.itemIdentifier == Self.invitesID }) else {
            return
        }
        configureInvitesItem(item)
    }

    private var invites: [PendingInviteItem] = []
    private var badgeCount: Int?

    private func makeInvitesItem(_ id: NSToolbarItem.Identifier) -> NSToolbarItem {
        let item = ValidatedMenuToolbarItem(itemIdentifier: id)
        item.label = labels["toolbar.invitations"]
        item.image = NSImage(
            systemSymbolName: "tray",
            accessibilityDescription: labels["toolbar.invitations"]
        )
        item.showsIndicator = true
        item.isBordered = true
        configureInvitesItem(item)
        return item
    }

    private func configureInvitesItem(_ item: NSToolbarItem) {
        let count = badgeCount ?? invites.count
        // The count rides on the item itself, so the toolbar answers "is there anything
        // waiting?" without being opened.
        item.title = count > 0 ? String(count) : ""
        switch count {
        case 0:
            item.toolTip = invites.isEmpty
                ? labels["toolbar.invitations.tooltip.none"]
                : labels["toolbar.invitations.tooltip.noneUnread"]
        case 1:
            item.toolTip = labels["toolbar.invitations.tooltip.one"]
        default:
            item.toolTip = labels.format("toolbar.invitations.tooltip.many", ["count": String(count)])
        }
        item.image = NSImage(
            systemSymbolName: (count > 0 || !invites.isEmpty) ? "tray.full" : "tray",
            accessibilityDescription: labels["toolbar.invitations"]
        )
        // Never disabled. A greyed-out item reads as broken as readily as empty, and the
        // way to say empty on macOS is to open onto a menu that says so, as the Dock's
        // own Recent Items does.
        (item as? NSMenuToolbarItem)?.menu = buildInvitesMenu()
    }

    private func buildInvitesMenu() -> NSMenu {
        InviteActionTarget.shared.reset()
        let menu = NSMenu()
        menu.autoenablesItems = false

        if invites.isEmpty {
            let empty = NSMenuItem(title: labels["toolbar.invitations.empty"], action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return menu
        }

        for invite in invites {
            // The app sends the catalogue's “no title” string when the event has no
            // summary, so this fallback only fires on a broken payload.
            let summary = invite.summary.isEmpty ? labels["toolbar.invite.noTitle"] : invite.summary
            let entry = NSMenuItem(title: summary, action: nil, keyEquivalent: "")
            // NSMenuItem.subtitle only arrived in 14.4, and the deployment target is 14.0.
            if #available(macOS 14.4, *) {
                entry.subtitle = invite.detail
            } else if !invite.detail.isEmpty {
                entry.title = "\(summary) · \(invite.detail)"
            }
            // Read invitations are dimmed rather than removed or disabled. The pile stays
            // clearable either way, and the rows drawn in full colour are exactly the ones
            // the Dock badge counts, so the two surfaces cannot tell the user different
            // numbers. Disabling would say the same thing and take away the answer.
            if !invite.isNew {
                entry.attributedTitle = NSAttributedString(
                    string: entry.title,
                    attributes: [
                        .font: NSFont.menuFont(ofSize: 0),
                        .foregroundColor: NSColor.secondaryLabelColor,
                    ]
                )
            }
            entry.submenu = buildAnswerMenu(for: invite)
            menu.addItem(entry)
        }

        if invites.contains(where: \.isNew) {
            menu.addItem(.separator())
            let readAll = NSMenuItem(
                title: labels["toolbar.invitations.markAllRead"], action: nil, keyEquivalent: ""
            )
            InviteActionTarget.shared.register(readAll, action: "invitesReadAll", key: "")
            menu.addItem(readAll)
        }
        return menu
    }

    /// Answering happens here rather than by opening the event, which is the point of an
    /// inbox: the pile is only clearable if each entry can be dealt with where it sits.
    private func buildAnswerMenu(for invite: PendingInviteItem) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false

        let answers: [(String, String, String)] = [
            (labels["toolbar.invite.accept"], "invite:yes", "checkmark.circle"),
            (labels["toolbar.invite.maybe"], "invite:maybe", "questionmark.circle"),
            (labels["toolbar.invite.decline"], "invite:no", "xmark.circle"),
        ]
        for (title, action, symbol) in answers {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            InviteActionTarget.shared.register(item, action: action, key: invite.key)
            menu.addItem(item)
        }

        menu.addItem(.separator())
        // A menu item cannot carry a context menu of its own, so marking one invitation
        // read sits beside the answers rather than under a right-click.
        if invite.isNew {
            let read = NSMenuItem(title: labels["toolbar.invite.markRead"], action: nil, keyEquivalent: "")
            read.image = NSImage(systemSymbolName: "envelope.open", accessibilityDescription: nil)
            InviteActionTarget.shared.register(read, action: "invite:read", key: invite.key)
            menu.addItem(read)
        }

        let open = NSMenuItem(title: labels["toolbar.invite.openInCalendar"], action: nil, keyEquivalent: "")
        open.image = NSImage(systemSymbolName: "calendar", accessibilityDescription: nil)
        InviteActionTarget.shared.register(open, action: "invite:open", key: invite.key)
        menu.addItem(open)
        return menu
    }
}

// MARK: - Invitation model

struct PendingInviteItem {
    let key: String
    let summary: String
    /// The line under the title: when it starts, and whose account it landed on.
    let detail: String
    /// Arrived while the user was away and not yet read. Drawn in full colour; the rest
    /// are dimmed, and this is the same flag the Dock badge counts.
    let isNew: Bool

    init(from dict: [String: Any]) {
        key = dict["key"] as? String ?? ""
        summary = dict["summary"] as? String ?? ""
        detail = dict["detail"] as? String ?? ""
        isNew = dict["isNew"] as? Bool ?? false
    }
}

// MARK: - Invitation menu action target

/// Carries the invitation key back with the action.
///
/// Menu items are rebuilt on every update, so the map is keyed by the item's identity and
/// cleared alongside it; holding keys for items AppKit has already released would leak a
/// little more on every poll.
private final class InviteActionTarget: NSObject {
    static let shared = InviteActionTarget()
    private var actions: [ObjectIdentifier: (action: String, key: String)] = [:]
    private var live: [NSMenuItem] = []

    func register(_ item: NSMenuItem, action: String, key: String) {
        actions[ObjectIdentifier(item)] = (action, key)
        live.append(item)
        item.target = self
        item.action = #selector(handleMenuClick(_:))
    }

    func reset() {
        actions.removeAll()
        live.removeAll()
    }

    @objc func handleMenuClick(_ sender: NSMenuItem) {
        guard let entry = actions[ObjectIdentifier(sender)] else { return }
        ActionBridge.emit(entry.action, entry.key)
    }
}
