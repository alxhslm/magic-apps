import AppKit

// MARK: - Item validation

/// Enabled state for items the main process drives.
///
/// AppKit revalidates toolbar items on its own schedule, so assigning
/// `isEnabled` once does not hold — the next validation pass overwrites it.
/// Overriding `validate()` is the documented way to supply the state instead,
/// which needs somewhere for the override to read from.
public final class ItemValidation {
    public static let shared = ItemValidation()
    private var enabled: [NSToolbarItem.Identifier: Bool] = [:]

    public init() {}

    public func set(_ id: NSToolbarItem.Identifier, enabled value: Bool) {
        enabled[id] = value
    }

    /// Sets a default state only if no state has been explicitly recorded yet.
    public func setDefault(_ id: NSToolbarItem.Identifier, enabled value: Bool) {
        if enabled[id] == nil {
            enabled[id] = value
        }
    }

    /// Items that never register a state stay enabled, which is AppKit's own
    /// default for an item whose target responds to its action.
    public func isEnabled(_ id: NSToolbarItem.Identifier) -> Bool {
        enabled[id] ?? true
    }
}

open class ValidatedToolbarItem: NSToolbarItem {
    override open func validate() {
        isEnabled = ItemValidation.shared.isEnabled(itemIdentifier)
    }
}

open class ValidatedToolbarItemGroup: NSToolbarItemGroup {
    override open func validate() {
        isEnabled = ItemValidation.shared.isEnabled(itemIdentifier)
    }
}

open class ValidatedMenuToolbarItem: NSMenuToolbarItem {
    override open func validate() {
        isEnabled = ItemValidation.shared.isEnabled(itemIdentifier)
    }
}

open class ValidatedSharingToolbarItem: NSSharingServicePickerToolbarItem {
    override open func validate() {
        isEnabled = ItemValidation.shared.isEnabled(itemIdentifier)
    }
}
