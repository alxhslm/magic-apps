import Foundation
import HelperRPC
import UserNotifications

/// The `UNUserNotificationCenter` plumbing both helpers share.
///
/// Magimail and Magical post different things and carry different actions, but both have
/// to claim the delegate, register their categories, ask for authorisation at launch, add
/// a request and route the pressed action back over the RPC pipe. That half lives here.
/// The categories, the content and the action vocabulary stay in each app's own controller,
/// which subclasses this and supplies them through the hooks below.
///
/// The subclass does not conform to `UNUserNotificationCenterDelegate` itself: this class
/// owns the conformance and forwards to the hooks.
@MainActor
open class NotificationControllerBase: NSObject {
    /// The app's name, as it appears before `.app` in a log line.
    private let appName: String
    private var transport: StdioTransport?
    private var didSetup = false

    public init(appName: String) {
        self.appName = appName
        super.init()
    }

    /// Whether this process has the bundle identity `UNUserNotificationCenter` requires.
    ///
    /// Without one, `UNUserNotificationCenter.current()` aborts the process rather than
    /// fail — which a helper run outside the app bundle, as under `pnpm dev`, must not do.
    /// See `docs/shared/notifications.md#bundle-identity`.
    public var hasBundleIdentity: Bool {
        Bundle.main.bundleIdentifier != nil
    }

    /// The categories the centre has been told to register.
    ///
    /// Mirrored here because the clear runs on the way out, where there may be no bundle
    /// identity and therefore no centre to ask, and a test still has to see it.
    public private(set) var registeredCategories: Set<UNNotificationCategory> = []

    // MARK: - Per-app hooks

    /// The categories this app registers, and with them the actions a banner can carry.
    open func categories() -> [UNNotificationCategory] {
        []
    }

    /// Called on the main actor once macOS has answered the authorisation prompt.
    ///
    /// A denial is silent by nature: every later dispatch succeeds and no banner appears,
    /// so an app that needs to tell that from a quiet morning reports it here.
    open func authorizationResolved(granted _: Bool, error _: Error?) {}

    /// The options to use when a banner arrives with the app already frontmost.
    ///
    /// Defaults to a banner with its sound; Magimail overrides it so a silent category
    /// stays silent whether or not the app happens to be frontmost.
    open nonisolated func foregroundOptions(for _: UNNotification) -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    /// Maps a pressed action or a click onto the RPC event that reports it.
    open func notificationEvent(
        actionIdentifier _: String,
        userInfo _: [AnyHashable: Any]
    ) -> (method: String, params: [String: Any])? {
        nil
    }

    // MARK: - Setup

    /// Registers the action categories and asks for permission, ahead of any banner.
    ///
    /// Called once at launch. Leaving it to the first `dispatch` is too late to be useful:
    /// until the app has asked, System Settings has no row to grant, so the first banner
    /// is necessarily missed.
    public func prepare(transport: StdioTransport) {
        guard hasBundleIdentity else {
            HelperLog.warn("Notifications", "No bundle identity — not registering (running outside \(appName).app)")
            return
        }
        ensureSetup(transport: transport)
    }

    /// The first half of a dispatch, shared by both apps.
    ///
    /// Keeps the transport for the action the banner may send back later, refuses to touch
    /// `UNUserNotificationCenter` without a bundle identity, and makes sure categories and
    /// authorisation are registered. Returns `false` when the helper runs outside its app,
    /// in which case the caller must not post.
    @discardableResult
    public func prepareForDispatch(transport: StdioTransport) -> Bool {
        self.transport = transport
        guard hasBundleIdentity else {
            HelperLog.warn("Notifications", "No bundle identity — skipping banner (running outside \(appName).app)")
            return false
        }
        ensureSetup(transport: transport)
        return true
    }

    private func ensureSetup(transport: StdioTransport) {
        self.transport = transport
        guard !didSetup else { return }
        didSetup = true

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        applyCategories(Set(categories()))

        center.requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, error in
            if let error {
                HelperLog.error("Notifications", "Auth error: \(error)")
            } else if !granted {
                HelperLog.warn("Notifications", "Permission denied")
            }
            Task { @MainActor in
                self?.authorizationResolved(granted: granted, error: error)
            }
        }
    }

    /// Registers the action categories, where there is a centre to take them.
    ///
    /// `UNUserNotificationCenter.current()` aborts the process without a bundle
    /// identity, as under `pnpm dev` and under `swift test`.
    public func applyCategories(_ categories: Set<UNNotificationCategory>) {
        registeredCategories = categories
        guard hasBundleIdentity else { return }
        UNUserNotificationCenter.current().setNotificationCategories(categories)
    }

    /// Takes back every banner this app has posted, every alert still waiting to fire,
    /// and the action categories behind them.
    ///
    /// Called as the app removes itself, so no banner is left pointing at data that is
    /// gone. macOS offers no API to revoke the authorisation itself, so the System
    /// Settings row outlives the uninstall; clearing is all that is possible here.
    public func clearAll() {
        applyCategories([])
        guard hasBundleIdentity else { return }
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
    }

    // MARK: - Posting

    /// Adds a banner with no trigger.
    ///
    /// No trigger because the Electron side already waited for the exact moment and owns
    /// rescheduling across sleep and clock changes. A trigger here would put that logic in
    /// two places and let them disagree.
    public func post(identifier: String, content: UNNotificationContent) {
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                HelperLog.error("Notifications", "Failed to dispatch: \(error)")
            }
        }
    }

    /// Withdraws banners whose reason to exist has gone.
    public func withdraw(identifiers: [String]) {
        guard hasBundleIdentity else { return }
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
    }

    /// Reports an event back to Electron, for a hook that has something to say.
    public func sendEvent(method: String, params: [String: Any]) {
        transport?.sendEvent(method: method, params: params)
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension NotificationControllerBase: UNUserNotificationCenterDelegate {
    /// Shows the banner even when the app is frontmost.
    ///
    /// Whether it also makes a sound is the subclass's business; see `foregroundOptions`.
    public nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler(foregroundOptions(for: notification))
    }

    /// Routes a click or an action button press back over the RPC pipe.
    public nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let actionIdentifier = response.actionIdentifier

        Task { @MainActor in
            guard let event = notificationEvent(actionIdentifier: actionIdentifier, userInfo: userInfo) else {
                return
            }
            sendEvent(method: event.method, params: event.params)
        }

        completionHandler()
    }
}
