import Foundation
import HelperNotifications
import HelperRPC
import UserNotifications

/// Meeting alerts, posted through `UNUserNotificationCenter`.
///
/// Lives in the helper rather than in Electron because Electron's `new Notification()`
/// cannot render action buttons on macOS, and the buttons are the point: a banner that
/// only says a meeting is starting makes you go and find the window.
///
/// The delegate, the authorisation prompt and the request plumbing it inherits from
/// `NotificationControllerBase`; the meeting and invitation categories, their content
/// and the `alert.action` vocabulary are here. See
/// `docs/magical/notifications.md#posting-the-banner`.
@MainActor
public final class NotificationController: NotificationControllerBase {
    public static let shared = NotificationController()

    static let categoryWithCall = "magical.meeting.call"
    static let categoryPlain = "magical.meeting"
    static let joinAction = "magical.join"
    static let snoozeAction = "magical.snooze"
    static let categoryInvite = "magical.invite"
    /// A banner that reports something already finished, so there is nothing to act on.
    static let categoryNotice = "magical.notice"
    static let rsvpYes = "magical.rsvp.yes"
    static let rsvpMaybe = "magical.rsvp.maybe"
    static let rsvpNo = "magical.rsvp.no"

    private init() {
        super.init(appName: "Magical")
    }

    static func makeCategories() -> [UNNotificationCategory] {
        let join = UNNotificationAction(
            identifier: joinAction,
            title: String(localized: "Join Call"),
            options: []
        )
        let snooze = UNNotificationAction(
            identifier: snoozeAction,
            title: String(localized: "Snooze 5m"),
            options: []
        )
        let yes = UNNotificationAction(
            identifier: rsvpYes,
            title: String(localized: "Yes"),
            options: []
        )
        let maybe = UNNotificationAction(
            identifier: rsvpMaybe,
            title: String(localized: "Maybe"),
            options: []
        )
        let no = UNNotificationAction(
            identifier: rsvpNo,
            title: String(localized: "No"),
            options: []
        )

        return [
            UNNotificationCategory(
                identifier: categoryInvite,
                actions: [yes, maybe, no],
                intentIdentifiers: [],
                options: []
            ),
            UNNotificationCategory(
                identifier: categoryWithCall,
                actions: [join, snooze],
                intentIdentifiers: [],
                options: []
            ),
            UNNotificationCategory(
                identifier: categoryPlain,
                actions: [snooze],
                intentIdentifiers: [],
                options: []
            ),
            UNNotificationCategory(
                identifier: categoryNotice,
                actions: [],
                intentIdentifiers: [],
                options: []
            ),
        ]
    }

    override public func categories() -> [UNNotificationCategory] {
        Self.makeCategories()
    }

    /// Reports the outcome rather than only logging it. A denied permission is silent
    /// by nature: every later dispatch succeeds and no banner appears, so the app has
    /// no way to tell that from a quiet morning unless it is told here.
    override public func authorizationResolved(granted: Bool, error: Error?) {
        sendEvent(
            method: "notify.authorization",
            params: ["granted": granted, "error": error?.localizedDescription ?? ""]
        )
    }

    static func makeContent(params: [String: Any]) -> UNMutableNotificationContent? {
        guard let title = params["title"] as? String else { return nil }
        let key = params["key"] as? String ?? ""
        let conferenceUrl = params["conferenceUrl"] as? String
        let accountId = params["accountId"] as? String ?? ""

        let content = UNMutableNotificationContent()
        content.title = title
        // macOS lays a banner out as title, then subtitle, then body. "In 5 minutes"
        // belongs above the location, the way Calendar does it.
        if let subtitle = params["subtitle"] as? String, !subtitle.isEmpty {
            content.subtitle = subtitle
        }
        if let body = params["body"] as? String, !body.isEmpty {
            content.body = body
        }
        let kind = params["kind"] as? String ?? "alert"
        switch kind {
        case "invite":
            content.categoryIdentifier = categoryInvite
        case "notice":
            content.categoryIdentifier = categoryNotice
        default:
            content.categoryIdentifier = conferenceUrl == nil ? categoryPlain : categoryWithCall
        }
        content.sound = .default
        // Notification Center groups by thread. Per account rather than per meeting, so a
        // pile of work alerts can be cleared without disturbing personal ones.
        content.threadIdentifier = "magical.account.\(accountId)"
        content.userInfo = [
            "key": key,
            "accountId": accountId,
            "eventId": params["eventId"] as? String ?? "",
            "deepLink": params["deepLink"] as? String ?? "",
            "conferenceUrl": conferenceUrl ?? "",
        ]
        return content
    }

    public func dispatch(transport: StdioTransport, params: [String: Any]) {
        guard prepareForDispatch(transport: transport),
              let key = params["key"] as? String,
              let content = Self.makeContent(params: params)
        else { return }

        let accountId = params["accountId"] as? String ?? ""
        let calendarIds = params["calendarIds"] as? [String] ?? []

        // Suppressed here, at the moment the banner would be posted, rather than back in
        // the scheduler. The scheduler has no concept of Focus and keeps none: an alert it
        // never armed is one that cannot fire when the Focus ends five minutes later, and
        // one it cannot withdraw when the meeting moves.
        //
        // An event sits on several calendars at once, and the banner goes only when the
        // Focus silences all of them; one silenced calendar is no reason to miss a meeting
        // the user is also holding on a calendar the Focus left alone.
        if !calendarIds.isEmpty, calendarIds.allSatisfy({
            FocusFilterController.shared.isSilenced(calendarId: $0, accountId: accountId)
        }) {
            HelperLog.info("Focus", "Banner suppressed for \(key); its calendar is silenced by a Focus")
            return
        }

        post(identifier: key, content: content)
    }

    /// Withdraws a banner whose meeting was cancelled or moved.
    public func withdraw(keys: [String]) {
        withdraw(identifiers: keys)
    }

    static func makeActionPayload(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any]
    ) -> (action: String, params: [String: Any])? {
        let action: String
        switch actionIdentifier {
        case joinAction: action = "join"
        case snoozeAction: action = "snooze"
        case rsvpYes: action = "rsvp:yes"
        case rsvpMaybe: action = "rsvp:maybe"
        case rsvpNo: action = "rsvp:no"
        case UNNotificationDefaultActionIdentifier: action = "open"
        default:
            return nil
        }

        let key = userInfo["key"] as? String ?? ""
        let accountId = userInfo["accountId"] as? String ?? ""
        let eventId = userInfo["eventId"] as? String ?? ""
        let deepLink = userInfo["deepLink"] as? String ?? ""
        let conferenceUrl = userInfo["conferenceUrl"] as? String ?? ""

        return (action, [
            "key": key,
            "accountId": accountId,
            "eventId": eventId,
            "deepLink": deepLink,
            "conferenceUrl": conferenceUrl,
            "action": action,
        ])
    }

    override public func notificationEvent(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any]
    ) -> (method: String, params: [String: Any])? {
        guard let payload = Self.makeActionPayload(actionIdentifier: actionIdentifier, userInfo: userInfo) else {
            return nil
        }
        return ("alert.action", payload.params)
    }
}
