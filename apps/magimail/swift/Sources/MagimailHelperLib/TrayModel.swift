import Foundation
import SwiftUI

/// What a popover row can do to its thread, beyond opening it.
///
/// The raw values are the wire strings `tray.threadAction` carries, so the
/// menu, the local state update and the main process all name an action once.
public enum TrayThreadAction: String {
    case archive
    case trash
    case markRead
    case markUnread
}

/// Data model for the menu bar tray popover.
@MainActor
public final class TrayModel: ObservableObject {
    public static let shared = TrayModel()

    @Published public var accounts: [TrayAccount] = []
    @Published public var totalUnread: Int = 0
    @Published public var messagesByAccount: [String: [TrayMessage]] = [:]

    /// Selected account filter. `nil` shows every account.
    @Published public var selectedAccountId: String?

    // Settings that affect the status item title
    @Published public var showCount: Bool = true
    @Published public var showDots: Bool = true
    /// Whether the popover draws only unread threads. A view filter, not a
    /// setting that changes what is fetched; `TrayModel` still holds the whole
    /// list so turning it off restores the read context without a round trip.
    @Published public var showUnreadOnly: Bool = false

    /// Network connection state
    @Published public var isOffline: Bool = false

    /// A Workspace administrator is refusing Gmail's Atom feed for an account.
    ///
    /// Separate from `isOffline` (the network is fine) and from the sign-in state (no
    /// credential the user can enter will lift an organisation policy).
    @Published public var isRestricted: Bool = false

    /// Verification code extracted from a recent unread email.
    @Published public var currentVerificationCode: TrayVerificationCode?
    @Published public var menuBarVerificationCodes: Bool = true
    @Published public var verificationCodeDurationMinutes: Int = 15

    /// The verification code to show in the hero card if within its duration and enabled.
    public var activeVerificationCode: TrayVerificationCode? {
        guard menuBarVerificationCodes, let current = currentVerificationCode else { return nil }
        let maxAge: TimeInterval = Double(verificationCodeDurationMinutes) * 60
        if Date().timeIntervalSince(current.receivedAt) > maxAge {
            return nil
        }
        return current
    }

    /// Set while a forced poll is in flight, so the gear menu's Refresh item cannot be
    /// fired twice. Any state arriving from Electron clears it: the poll that answers a
    /// refresh lands as either a count change or a fresh message list.
    @Published public var isRefreshing: Bool = false

    /// How many threads per account to keep once they have been read.
    /// Matches `RECENT_TRAY_MESSAGES` in `src/menubar-manager.ts`, which bounds
    /// the pool Electron offers; this bounds what is drawn from it.
    private let retentionLimit = 20

    /// How long a popover action holds its state against a stale payload.
    ///
    /// Long enough to outlive the lag between Gmail applying the change and its
    /// cache showing it; short enough that an action Gmail never applied stops
    /// claiming to have worked.
    private let localStateGrace: TimeInterval = 30

    /// A change the user made in the popover that the payload has not caught up
    /// with yet, held against a stale copy from the cache.
    private enum LocalState {
        /// The row's read state was set here.
        case read(isUnread: Bool)
        /// The row was archived or trashed and must not be drawn again until the
        /// cache drops it.
        case removed

        /// The row to draw for this message, or `nil` when the change took it out
        /// of the list.
        func applied(to message: TrayMessage) -> TrayMessage? {
            switch self {
            case let .read(isUnread):
                isUnread ? message.markedUnread() : message.markedRead()
            case .removed:
                nil
            }
        }

        /// Whether the payload now reflects this change.
        func agrees(with incoming: TrayMessage?) -> Bool {
            switch self {
            case let .read(isUnread):
                // Absent means the action also took it out of the inbox.
                incoming.map { $0.isUnread == isUnread } ?? true
            case .removed:
                incoming == nil
            }
        }
    }

    private struct LocalStateEntry {
        let state: LocalState
        let setAt: Date
    }

    /// Pending changes set here, per account, keyed by thread id.
    private var localState: [String: [String: LocalStateEntry]] = [:]
    /// Replace this account's list with the newest payload.
    ///
    /// The cache is authoritative about both presence and read state: it lists
    /// read threads as well as unread ones, and a thread that is not in it has
    /// been archived or deleted. Nothing is carried over from the previous
    /// payload — keeping a dropout as a muted row is what left a deleted thread
    /// in the popover until twenty newer ones replaced it.
    public func setMessages(accountId: String, incoming: [TrayMessage]) {
        isRefreshing = false
        let unsettled = settleLocalState(accountId: accountId, incoming: incoming)
        let next = incoming
            .compactMap { message -> TrayMessage? in
                guard let entry = unsettled[message.id] else { return message }
                return entry.state.applied(to: message)
            }
            .sorted { $0.sortKey > $1.sortKey }
            .prefix(retentionLimit)
        messagesByAccount[accountId] = Array(next)
    }

    /// Drop the read states the payload has caught up with, and return the rest.
    ///
    /// A state settles when the payload agrees with it: the thread carries the
    /// same read flag, or it has left the list altogether (archived or trashed).
    /// Presence alone is not agreement — the cache lists read and unread threads
    /// alike, so a thread still sitting there as read is exactly the stale copy a
    /// `markUnread` has to win against. Anything still waiting is dropped after
    /// `localStateGrace`, so a Gmail that never applied the action wins in the end.
    private func settleLocalState(
        accountId: String,
        incoming: [TrayMessage]
    ) -> [String: LocalStateEntry] {
        let now = Date()
        let byId = Dictionary(incoming.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let unsettled = (localState[accountId] ?? [:]).filter { id, entry in
            !entry.state.agrees(with: byId[id])
                && now.timeIntervalSince(entry.setAt) < localStateGrace
        }
        localState[accountId] = unsettled.isEmpty ? nil : unsettled
        return unsettled
    }

    /// Show an action on a thread in the popover's own copy of the list.
    ///
    /// The list is read on demand, so waiting for Gmail to agree would leave the
    /// row as it was until the next pull — long enough to read as the click
    /// having missed. Marking read or unread is applied to the row; archiving and
    /// trashing pull it out of the list at once, because the thread is leaving
    /// the inbox and the cache may serve the old copy for a moment yet.
    ///
    /// The change is recorded as well as shown, because a pull can land before
    /// Gmail has applied the action: acting on a thread moves an unread count, a
    /// changed count pushes fresh tray data, and the popover answers that by
    /// asking for messages again — which Electron answers from Gmail's cache,
    /// where the thread may still read as it did. Without the record, the row
    /// comes straight back.
    public func apply(_ action: TrayThreadAction, accountId: String, messageId: String) {
        guard var messages = messagesByAccount[accountId],
              let index = messages.firstIndex(where: { $0.id == messageId })
        else { return }

        let state: LocalState
        switch action {
        case .markUnread:
            messages[index] = messages[index].markedUnread()
            state = .read(isUnread: true)
        case .markRead:
            messages[index] = messages[index].markedRead()
            state = .read(isUnread: false)
            if currentVerificationCode?.messageId == messageId || currentVerificationCode?.threadId == messageId {
                currentVerificationCode = nil
            }
        case .archive, .trash:
            // Pull the row now: the thread is leaving the inbox, and the cache
            // may serve the old copy for a moment yet.
            messages.remove(at: index)
            state = .removed
            if currentVerificationCode?.messageId == messageId || currentVerificationCode?.threadId == messageId {
                currentVerificationCode = nil
            }
        }
        messagesByAccount[accountId] = messages
        localState[accountId, default: [:]][messageId] = LocalStateEntry(state: state, setAt: Date())
    }

    /// Every cached thread across all accounts, newest first, paired with its account.
    /// Honours `selectedAccountId` and `showUnreadOnly`.
    public var visibleMessages: [(message: TrayMessage, account: TrayAccount)] {
        accounts
            .filter { selectedAccountId == nil || $0.id == selectedAccountId }
            .flatMap { account in
                (messagesByAccount[account.id] ?? []).map { (message: $0, account: account) }
            }
            .filter { !showUnreadOnly || $0.message.isUnread }
            .sorted { $0.message.sortKey > $1.message.sortKey }
    }

    /// Unread count for the current filter.
    public var visibleUnreadCount: Int {
        accounts
            .filter { selectedAccountId == nil || $0.id == selectedAccountId }
            .reduce(0) { $0 + $1.unreadCount }
    }

    public func update(from params: [String: Any]) {
        isRefreshing = false
        if let rawAccounts = params["accounts"] as? [[String: Any]] {
            accounts = rawAccounts.map { TrayAccount(from: $0) }
            // An account that has gone takes its cached threads with it. The threads are
            // held here rather than pushed again, so nothing else would ever drop them.
            let live = Set(accounts.map(\.id))
            messagesByAccount = messagesByAccount.filter { live.contains($0.key) }
            localState = localState.filter { live.contains($0.key) }
            if let selected = selectedAccountId, !live.contains(selected) {
                selectedAccountId = nil
            }
        }
        if let total = params["totalUnread"] as? Int {
            totalUnread = total
        }
        if let sc = params["showCount"] as? Bool {
            showCount = sc
        }
        if let sd = params["showDots"] as? Bool {
            showDots = sd
        }
        if let unreadOnly = params["showUnreadOnly"] as? Bool {
            showUnreadOnly = unreadOnly
        }
        if let offline = params["isOffline"] as? Bool {
            isOffline = offline
        }
        if let restricted = params["isRestricted"] as? Bool {
            isRestricted = restricted
        }
        if let vcDict = params["verificationCode"] as? [String: Any] {
            updateVerificationCode(from: vcDict)
        } else if params.keys.contains("verificationCode") {
            updateVerificationCode(from: nil)
        }
        if let mbvc = params["menuBarVerificationCodes"] as? Bool {
            menuBarVerificationCodes = mbvc
        }
        if let vcd = params["verificationCodeDurationMinutes"] as? Int {
            verificationCodeDurationMinutes = vcd
        }
    }

    public func updateVerificationCode(from dict: [String: Any]?) {
        guard let dict,
              let code = dict["code"] as? String, !code.isEmpty,
              let messageId = dict["messageId"] as? String,
              let threadId = dict["threadId"] as? String,
              let accountId = dict["accountId"] as? String
        else {
            currentVerificationCode = nil
            return
        }

        let service = dict["service"] as? String
        let subject = dict["subject"] as? String ?? ""
        let from = dict["from"] as? String ?? ""
        let receivedAtMs = dict["receivedAt"] as? Double ?? (dict["receivedAt"] as? Int).map { Double($0) } ?? (Date().timeIntervalSince1970 * 1000)
        let receivedAt = Date(timeIntervalSince1970: receivedAtMs / 1000)

        currentVerificationCode = TrayVerificationCode(
            code: code,
            service: service,
            subject: subject,
            from: from,
            messageId: messageId,
            threadId: threadId,
            accountId: accountId,
            receivedAt: receivedAt
        )
    }
}

public struct TrayVerificationCode: Equatable, Sendable {
    public let code: String
    public let service: String?
    public let subject: String
    public let from: String
    public let messageId: String
    public let threadId: String
    public let accountId: String
    public let receivedAt: Date

    public init(
        code: String,
        service: String?,
        subject: String,
        from: String,
        messageId: String,
        threadId: String,
        accountId: String,
        receivedAt: Date
    ) {
        self.code = code
        self.service = service
        self.subject = subject
        self.from = from
        self.messageId = messageId
        self.threadId = threadId
        self.accountId = accountId
        self.receivedAt = receivedAt
    }
}

public struct TrayAccount: Identifiable {
    public let id: String
    public let name: String
    public let color: String
    public let unreadCount: Int
    public let email: String
    public let needsAuth: Bool

    init(from dict: [String: Any]) {
        id = dict["id"] as? String ?? ""
        name = dict["name"] as? String ?? String(localized: "Unknown")
        color = dict["color"] as? String ?? "#3b82f6"
        unreadCount = dict["unreadCount"] as? Int ?? 0
        email = dict["email"] as? String ?? ""
        needsAuth = dict["needsAuth"] as? Bool ?? false
    }
}

public struct TrayMessage: Identifiable {
    public let id: String
    public let threadId: String
    public let from: String
    public let subject: String
    public let snippet: String
    public let internalDate: String
    public private(set) var isUnread: Bool
    public let category: MailCategory

    public init(from dict: [String: Any]) {
        id = dict["id"] as? String ?? UUID().uuidString
        threadId = dict["threadId"] as? String ?? ""
        from = dict["from"] as? String ?? ""
        subject = dict["subject"] as? String ?? String(localized: "(no subject)")
        snippet = dict["snippet"] as? String ?? ""
        internalDate = dict["internalDate"] as? String ?? ""
        let labelIds = dict["labelIds"] as? [String] ?? []
        isUnread = labelIds.contains("UNREAD")
        // Resolved in the main process from Gmail's category sub-feeds, the only
        // side that can see them. The Atom feed carries no label per entry.
        category = MailCategory.from(dict["category"] as? String)
    }

    /// A copy of this thread marked read, for threads that have dropped out of the
    /// unread-only Atom feed.
    public func markedRead() -> TrayMessage {
        var copy = self
        copy.isUnread = false
        return copy
    }

    /// A copy of this thread marked unread, for a row the user has just put back.
    public func markedUnread() -> TrayMessage {
        var copy = self
        copy.isUnread = true
        return copy
    }

    /// Millisecond timestamp used for ordering. Undated threads sort last.
    public var sortKey: Double {
        Double(internalDate) ?? 0
    }

    public var senderName: String {
        // Parse "Name <email>" format
        if let match = from.range(of: #"^"?([^"<]+)"?\s*<"#, options: .regularExpression) {
            return String(from[match]).replacingOccurrences(of: "\"", with: "")
                .replacingOccurrences(of: "<", with: "").trimmingCharacters(in: .whitespaces)
        }
        return from.trimmingCharacters(in: .whitespaces)
    }

    public var formattedTime: String {
        guard let ms = Double(internalDate) else { return "" }
        let date = Date(timeIntervalSince1970: ms / 1000)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            let formatter = DateFormatter()
            formatter.dateFormat = "HH:mm"
            return formatter.string(from: date)
        } else {
            let formatter = DateFormatter()
            formatter.dateFormat = "d MMM"
            return formatter.string(from: date)
        }
    }
}
