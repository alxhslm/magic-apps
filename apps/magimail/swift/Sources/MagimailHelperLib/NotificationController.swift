import Foundation
import HelperNotifications
import HelperRPC
import UserNotifications

// MARK: - Notification Controller

/// Gmail arrival banners, posted through `UNUserNotificationCenter`.
///
/// The delegate, the authorisation prompt and the request plumbing it inherits from
/// `NotificationControllerBase`; what a Gmail banner says and which actions it carries
/// is here.
@MainActor
public final class NotificationController: NotificationControllerBase {
    public static let shared = NotificationController()

    static let categoryId = "magimail.message"
    static let archiveAction = "magimail.archive"
    static let markReadAction = "magimail.markRead"
    static let trashAction = "magimail.trash"

    /// Set of dispatched message IDs to avoid duplicates.
    private var dispatchedIds = Set<String>()

    private init() {
        super.init(appName: "Magimail")
    }

    static func makeCategories() -> [UNNotificationCategory] {
        let archive = UNNotificationAction(
            identifier: archiveAction,
            title: String(localized: "Archive"),
            options: []
        )
        let markRead = UNNotificationAction(
            identifier: markReadAction,
            title: String(localized: "Mark Read"),
            options: []
        )
        let trash = UNNotificationAction(
            identifier: trashAction,
            title: String(localized: "Delete"),
            options: [.destructive]
        )
        return [
            UNNotificationCategory(
                identifier: categoryId,
                actions: [archive, markRead, trash],
                intentIdentifiers: [],
                options: []
            ),
        ]
    }

    override public func categories() -> [UNNotificationCategory] {
        Self.makeCategories()
    }

    /// Sound follows the category level set at dispatch, so a `silent` category stays
    /// silent whether or not Magimail happens to be frontmost.
    override public nonisolated func foregroundOptions(for notification: UNNotification) -> UNNotificationPresentationOptions {
        let level = notification.request.content.userInfo["level"] as? String ?? "loud"
        return level == "loud" ? [.banner, .sound] : [.banner]
    }

    public func dispatch(transport: StdioTransport, params: [String: Any]) {
        guard prepareForDispatch(transport: transport),
              let accountId = params["accountId"] as? String,
              let messages = params["messages"] as? [[String: Any]]
        else { return }

        let settings = params["notifications"] as? [String: String] ?? [:]

        guard !FocusFilterController.shared.isAccountMuted(accountId) else {
            HelperLog.info("Focus", "\(messages.count) banner(s) suppressed; \(accountId) is muted by a Focus")
            return
        }

        var suppressedByLevel = 0
        for msg in messages {
            guard let msgId = msg["id"] as? String else { continue }

            // Skip duplicates
            if dispatchedIds.contains(msgId) {
                continue
            }
            dispatchedIds.insert(msgId)

            // Resolved in the main process from Gmail's category sub-feeds, the
            // only side that can see them.
            let category = MailCategory.from(msg["category"] as? String)
            let level = settings[category.rawValue] ?? "loud"

            // Skip badge-only and off. Counted rather than logged per message:
            // a busy inbox on "badge" would otherwise fill the file on its own.
            if level == "off" || level == "badge" {
                suppressedByLevel += 1
                continue
            }

            let content = Self.makeContent(from: msg, accountId: accountId, level: level)

            post(identifier: "magimail.\(msgId)", content: content)
        }

        if suppressedByLevel > 0 {
            HelperLog.info(
                "Notifications",
                "\(suppressedByLevel) of \(messages.count) banner(s) held back by their category level"
            )
        }

        // Trim dispatched set to avoid unbounded growth
        if dispatchedIds.count > 1000 {
            let sorted = Array(dispatchedIds)
            dispatchedIds = Set(sorted.suffix(1000))
        }
    }

    static func makeContent(from msg: [String: Any], accountId: String, level: String) -> UNMutableNotificationContent {
        let msgId = msg["id"] as? String ?? ""
        let openId = msg["threadId"] as? String ?? msgId
        let category = MailCategory.from(msg["category"] as? String)

        let senderName = parseSenderName(msg["from"] as? String ?? "")
        let subject = msg["subject"] as? String ?? String(localized: "(no subject)")
        let snippet = msg["snippet"] as? String ?? ""

        // macOS lays a banner out as title, then subtitle, then body, so
        // the subject has to be the *subtitle* to sit above the preview.
        // Matches Mail: who it is from, what it is about, then a taste of it.
        let content = UNMutableNotificationContent()
        content.title = senderName
        if snippet.isEmpty {
            content.body = subject
        } else {
            content.subtitle = subject
            content.body = snippet
        }
        content.categoryIdentifier = categoryId
        // Notification Center stacks by thread, so grouping on the Gmail
        // category lets a pile of promotions be cleared in one gesture
        // without disturbing the rest. Left unset, every banner Magimail has
        // ever posted collapses into one undifferentiated stack.
        content.threadIdentifier = "magimail.category.\(category.rawValue)"
        if let attachment = CategoryAttachment.make(for: category) {
            content.attachments = [attachment]
        }
        content.userInfo = [
            "accountId": accountId,
            "messageId": openId,
            // Carried so `willPresent` can honour the same level when the
            // banner arrives with Magimail already frontmost.
            "level": level,
        ]
        if level == "loud" {
            content.sound = .default
        }
        return content
    }

    static func parseSenderName(_ from: String) -> String {
        if from.isEmpty {
            return String(localized: "Unknown")
        }
        if let range = from.range(of: #"^"?([^"<]+)"?\s*<"#, options: .regularExpression) {
            return String(from[range])
                .replacingOccurrences(of: "\"", with: "")
                .replacingOccurrences(of: "<", with: "")
                .trimmingCharacters(in: .whitespaces)
        }
        return from.trimmingCharacters(in: .whitespaces)
    }

    /// Handle notification click and action button presses.
    static func makeActionPayload(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any]
    ) -> (method: String, params: [String: Any])? {
        let accountId = userInfo["accountId"] as? String ?? ""
        let messageId = userInfo["messageId"] as? String ?? ""

        switch actionIdentifier {
        case archiveAction:
            return ("notify.action", [
                "accountId": accountId,
                "messageId": messageId,
                "action": "archive",
            ])
        case markReadAction:
            return ("notify.action", [
                "accountId": accountId,
                "messageId": messageId,
                "action": "markRead",
            ])
        case trashAction:
            return ("notify.action", [
                "accountId": accountId,
                "messageId": messageId,
                "action": "trash",
            ])
        case UNNotificationDefaultActionIdentifier:
            return ("notify.click", [
                "accountId": accountId,
                "messageId": messageId,
            ])
        default:
            return nil
        }
    }

    override public func notificationEvent(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any]
    ) -> (method: String, params: [String: Any])? {
        Self.makeActionPayload(actionIdentifier: actionIdentifier, userInfo: userInfo)
    }
}
