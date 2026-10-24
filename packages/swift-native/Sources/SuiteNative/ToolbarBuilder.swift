import AppKit

public final class ButtonTarget: NSObject {
    public static let shared = ButtonTarget()
    private var actions: [NSToolbarItem.Identifier: String] = [:]

    public func register(_ id: NSToolbarItem.Identifier, actionName: String) {
        actions[id] = actionName
    }

    @objc public func handleClick(_ sender: NSToolbarItem) {
        if let action = actions[sender.itemIdentifier] {
            ActionBridge.emit(action)
        }
    }
}

public enum ToolbarBuilder {
    /// Creates a standard bordered icon toolbar button using an SF Symbol.
    public static func makeButton(
        _ id: NSToolbarItem.Identifier,
        symbol: String,
        label: String,
        action actionName: String,
        needsMessage: Bool = false
    ) -> NSToolbarItem {
        let item = ValidatedToolbarItem(itemIdentifier: id)
        item.label = label
        item.toolTip = label
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
        // Without this an image item renders as a flat icon with no hover or
        // pressed feedback. Bordered is the standard toolbar button, and AppKit
        // draws its states itself — Liquid Glass included on macOS 26.
        item.isBordered = true
        item.target = ButtonTarget.shared
        item.action = #selector(ButtonTarget.handleClick(_:))
        ButtonTarget.shared.register(id, actionName: actionName)
        if needsMessage {
            ItemValidation.shared.setDefault(id, enabled: false)
            item.isEnabled = ItemValidation.shared.isEnabled(id)
        }
        return item
    }

    /// Creates an expanded toolbar item group with real subitems.
    public static func makeGroup(
        _ id: NSToolbarItem.Identifier,
        label: String,
        needsMessage: Bool = false,
        members: [(symbol: String, label: String, action: String)]
    ) -> NSToolbarItemGroup {
        let group = NSToolbarItemGroup(itemIdentifier: id)
        group.label = label
        group.controlRepresentation = .expanded
        group.subitems = members.map { member in
            makeButton(
                NSToolbarItem.Identifier(member.action),
                symbol: member.symbol,
                label: member.label,
                action: member.action,
                needsMessage: needsMessage
            )
        }
        group.image = group.subitems.first?.image
        return group
    }

    /// Creates an NSSearchToolbarItem preconfigured with the shared SearchDelegate.
    /// The placeholder is the app's string, pushed with its other toolbar labels.
    public static func makeSearchItem(
        _ id: NSToolbarItem.Identifier,
        placeholder: String
    ) -> NSSearchToolbarItem {
        let item = NSSearchToolbarItem(itemIdentifier: id)
        item.searchField.delegate = SearchDelegate.shared
        item.searchField.placeholderString = placeholder
        return item
    }
}
