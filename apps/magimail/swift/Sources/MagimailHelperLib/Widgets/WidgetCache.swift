import Foundation
import SwiftUI

// MARK: - Shared cache

/// Snapshot written by the Electron main process on every Atom poll.
///
/// Read from the App Group container both sides are entitled for. That replaced
/// a read-only sandbox exception over the whole of Application Support, which
/// is also where the Gmail session cookies live — one JSON file did not justify
/// the reach. See `src/widget-cache.ts` and `entitlements.plist`.
public struct WidgetCache: Codable {
    public var updatedAt: Double
    public var totalUnread: Int
    public var accounts: [CachedAccount]
    public var messages: [CachedMessage]

    public static let empty = WidgetCache(updatedAt: 0, totalUnread: 0, accounts: [], messages: [])

    public init(updatedAt: Double, totalUnread: Int, accounts: [CachedAccount], messages: [CachedMessage]) {
        self.updatedAt = updatedAt
        self.totalUnread = totalUnread
        self.accounts = accounts
        self.messages = messages
    }

    private static let fileName = "widget-cache.json"

    /// Nil when this process is not entitled for the group, which is a build
    /// fault rather than a missing snapshot — `load()` renders the placeholder.
    static var fileURL: URL? {
        guard let group = widgetAppGroupId else { return nil }
        return FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: group)?
            .appendingPathComponent(fileName)
    }

    /// Returns `.empty` when the file is absent or unreadable, so widgets render
    /// a sensible placeholder rather than failing to load.
    static func load() -> WidgetCache {
        let logger = WidgetsLogger.shared
        guard let url = fileURL else {
            logger.error("No App Group container; this build is not entitled for \(widgetAppGroupId ?? "any group")")
            return .empty
        }

        guard FileManager.default.fileExists(atPath: url.path) else {
            logger.warn("widget-cache.json not found at \(logger.redactText(url.path))")
            return .empty
        }

        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            logger.error("Failed to read widget-cache.json: \(error.localizedDescription)")
            return .empty
        }

        do {
            let cache = try JSONDecoder().decode(WidgetCache.self, from: data)
            logger.info("Loaded widget cache: \(cache.accounts.count) account(s), \(cache.totalUnread) unread, \(cache.messages.count) message(s)")
            return cache
        } catch {
            logger.error("Failed to decode widget-cache.json: \(error)")
            return .empty
        }
    }
}

public struct CachedAccount: Codable, Identifiable {
    public var id: String
    public var name: String
    public var color: String
    public var email: String
    public var unreadCount: Int

    public init(id: String, name: String, color: String, email: String, unreadCount: Int) {
        self.id = id
        self.name = name
        self.color = color
        self.email = email
        self.unreadCount = unreadCount
    }
}

public struct CachedMessage: Codable, Identifiable {
    public var id: String
    public var threadId: String
    public var accountId: String
    public var sender: String
    public var subject: String
    public var snippet: String
    /// Milliseconds since the epoch; 0 when the feed gave no usable date.
    public var date: Double
    /// Absent in a snapshot written before categories were cached.
    public var category: String?
    /// Absent in a snapshot written before unread was cached. `isUnread`
    /// supplies the default.
    public var unread: Bool?

    public init(
        id: String,
        threadId: String,
        accountId: String,
        sender: String,
        subject: String,
        snippet: String,
        date: Double,
        category: String? = nil,
        unread: Bool? = nil
    ) {
        self.id = id
        self.threadId = threadId
        self.accountId = accountId
        self.sender = sender
        self.subject = subject
        self.snippet = snippet
        self.date = date
        self.category = category
        self.unread = unread
    }

    var mailCategory: MailCategory {
        MailCategory.from(category)
    }

    /// Whether the row is drawn as unread. A snapshot from before the field
    /// existed has no value, and that counts as unread: it is how the widget
    /// drew every row then, and how the popover reads an omitted flag.
    var isUnread: Bool {
        unread ?? true
    }

    var displayDate: String {
        guard date > 0 else { return "" }
        let value = Date(timeIntervalSince1970: date / 1000)
        let formatter = DateFormatter()
        formatter.dateFormat = Calendar.current.isDateInToday(value) ? "HH:mm" : "d MMM"
        return formatter.string(from: value)
    }
}

// MARK: - Categories

// MARK: - Helpers

extension WidgetCache {
    func account(for message: CachedMessage) -> CachedAccount? {
        accounts.first { $0.id == message.accountId }
    }

    /// The snapshot with read threads taken out, for a widget set to unread only.
    ///
    /// Only the message list is filtered: the totals, the accounts and the chips read the
    /// same either way, and a list taken to empty then draws the same "all caught up" state
    /// the popover shows. A thread from a snapshot written before the flag existed counts as
    /// unread, so an older cache is never silently emptied.
    func onlyUnread() -> WidgetCache {
        guard messages.contains(where: { !$0.isUnread }) else { return self }
        var filtered = self
        filtered.messages = messages.filter(\.isUnread)
        return filtered
    }

    /// Deep link handled by the app's `magimail://` protocol registration.
    func threadURL(for message: CachedMessage) -> URL? {
        URL(string: "magimail://thread/\(message.threadId)?account=\(message.accountId)")
    }

    static func composeURL(accountId: String?) -> URL? {
        guard let accountId else { return URL(string: "magimail://compose") }
        return URL(string: "magimail://compose?account=\(accountId)")
    }

    /// Opens the app on this account's inbox, switching account if need be.
    static func inboxURL(accountId: String) -> URL? {
        URL(string: "magimail://inbox?account=\(accountId)")
    }
}

extension Color {
    /// Parses `#RRGGBB`, falling back to the system accent colour.
    init(hexString: String) {
        var hex = hexString.trimmingCharacters(in: .whitespaces)
        if hex.hasPrefix("#") {
            hex.removeFirst()
        }
        guard hex.count == 6, let value = UInt32(hex, radix: 16) else {
            self = .accentColor
            return
        }
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}
