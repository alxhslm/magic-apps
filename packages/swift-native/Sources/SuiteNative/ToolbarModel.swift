import Foundation

public struct ToolbarAccount: Identifiable {
    public let id: String
    public let name: String
    public let color: String
    public let unreadCount: Int
    /// Outside the active Focus Filter: drawn dimmed, still selectable.
    public let excludedByFocus: Bool
    /// Excluded, and the filter was asked to disable rather than de-emphasise.
    public let disabledByFocus: Bool
    /// Whether this account is unauthenticated / requires sign-in.
    public let needsAuth: Bool

    public init(from dict: [String: Any]) {
        id = dict["id"] as? String ?? ""
        name = dict["name"] as? String ?? ""
        color = dict["color"] as? String ?? "#a855f7"
        unreadCount = dict["unreadCount"] as? Int ?? 0
        excludedByFocus = dict["excludedByFocus"] as? Bool ?? false
        disabledByFocus = dict["disabledByFocus"] as? Bool ?? false
        needsAuth = dict["needsAuth"] as? Bool ?? false
    }

    public init(
        id: String,
        name: String,
        color: String = "#a855f7",
        unreadCount: Int = 0,
        excludedByFocus: Bool = false,
        disabledByFocus: Bool = false,
        needsAuth: Bool = false
    ) {
        self.id = id
        self.name = name
        self.color = color
        self.unreadCount = unreadCount
        self.excludedByFocus = excludedByFocus
        self.disabledByFocus = disabledByFocus
        self.needsAuth = needsAuth
    }
}

@MainActor
public final class ToolbarModel {
    public var accounts: [ToolbarAccount] = []
    public var activeAccountId: String = ""

    public init() {}
}
