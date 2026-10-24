import Foundation
import HelperRPC
import HelperUI
import SwiftUI

/// Observable model for settings state. Sends events to Electron when values change.
@MainActor
public final class SettingsModel: ObservableObject {
    public static let shared = SettingsModel()

    public var transport: StdioTransport?

    // MARK: - General

    @Published public var theme: String = "system" {
        didSet { emit("theme", theme) }
    }

    @Published public var pollIntervalSeconds: Int = 60 {
        didSet { emit("pollIntervalSeconds", pollIntervalSeconds) }
    }

    @Published public var pollIntervalBatterySeconds: Int = 180 {
        didSet { emit("pollIntervalBatterySeconds", pollIntervalBatterySeconds) }
    }

    /// Minutes an account may sit inactive before its web view is released. 0 means never.
    @Published public var inactiveAccountSuspendMinutes: Int = 5 {
        didSet { emit("inactiveAccountSuspendMinutes", inactiveAccountSuspendMinutes) }
    }

    @Published public var launchAtLogin: Bool = false {
        didSet { emit("launchAtLogin", launchAtLogin) }
    }

    @Published public var composeAccountPicker: String = "active" {
        didSet { emit("composeAccountPicker", composeAccountPicker) }
    }

    /// Electron accelerator for the system-wide quick compose chord, or "off".
    @Published public var quickComposeHotkey: String = "Alt+Command+C" {
        didSet { emit("quickComposeHotkey", quickComposeHotkey) }
    }

    // MARK: - Dock & Menu Bar

    /// What the dock badge counts: "allUnread", "newArrivals" or "off".
    ///
    /// A string rather than an enum because the whole settings bridge is
    /// JSON-RPC over stdio, and every other choice on it — theme, compose
    /// picker, hotkey — is already spelled the same way.
    @Published public var dockBadgeMode: String = "allUnread" {
        didSet { emit("dockBadgeMode", dockBadgeMode) }
    }

    @Published public var showMenuBarTray: Bool = true {
        didSet { emit("showMenuBarTray", showMenuBarTray) }
    }

    @Published public var menuBarShowCount: Bool = true {
        didSet { emit("menuBarShowCount", menuBarShowCount) }
    }

    @Published public var menuBarShowDots: Bool = true {
        didSet { emit("menuBarShowDots", menuBarShowDots) }
    }

    @Published public var menuBarUnreadOnly: Bool = false {
        didSet { emit("menuBarUnreadOnly", menuBarUnreadOnly) }
    }

    // MARK: - Appearance

    @Published public var hidePromotionAds: Bool = true {
        didSet { emit("hidePromotionAds", hidePromotionAds) }
    }

    @Published public var hideSidebar: Bool = false {
        didSet { emit("hideSidebar", hideSidebar) }
    }

    @Published public var transparentBackground: Bool = true {
        didSet { emit("transparentBackground", transparentBackground) }
    }

    // MARK: - Notifications

    @Published public var notifPrimary: String = "loud" {
        didSet { emitNotif("primary", notifPrimary) }
    }

    @Published public var notifUpdates: String = "silent" {
        didSet { emitNotif("updates", notifUpdates) }
    }

    @Published public var notifPromotions: String = "badge" {
        didSet { emitNotif("promotions", notifPromotions) }
    }

    @Published public var notifSocial: String = "badge" {
        didSet { emitNotif("social", notifSocial) }
    }

    @Published public var notifForums: String = "off" {
        didSet { emitNotif("forums", notifForums) }
    }

    // MARK: - Focus Filter

    @Published public var focusFilterStatus = String(localized: "Inactive (All accounts active)")

    // MARK: - Accounts

    @Published public var accounts: [[String: Any]] = []

    // MARK: - Default handlers

    /// One row per scheme Magimail can claim, read live from LaunchServices.
    ///
    /// Not mirrored from the main process like everything above it, because the answer is
    /// not Magimail's to remember: the user can change the reader in System Settings at any
    /// time, and a row showing what Magimail last set would be a row that lies.
    public struct HandlerRow: Identifiable {
        public let target: DefaultHandler.Target
        public let label: String
        /// The app that opens this scheme today, by its display name.
        public let handler: String
        public let isMagimail: Bool

        public var id: String {
            target.rawValue
        }
    }

    @Published public var handlerRows: [HandlerRow] = []
    /// False outside an app bundle, as under `pnpm dev`, where there is nothing to register.
    @Published public var canClaimDefaults = false

    /// Re-reads LaunchServices. Called when the window appears and after every claim.
    public func refreshHandlers() {
        canClaimDefaults = DefaultHandler.canClaim
        handlerRows = DefaultHandler.Target.allCases.map { target in
            let state = DefaultHandler.current(target)
            return HandlerRow(
                target: target,
                label: target.label,
                handler: state?.name ?? "",
                isMagimail: state?.isMagimail ?? false
            )
        }
    }

    /// Claims one scheme, then re-reads rather than assuming it worked.
    public func claimHandler(_ target: DefaultHandler.Target) {
        DefaultHandler.claim(target) { [weak self] _ in
            self?.refreshHandlers()
        }
    }

    // MARK: - Info

    @Published public var appVersion: String = ""

    // MARK: - Suppress events during bulk update

    private var suppressEvents = false

    public func update(from dict: [String: Any]) {
        suppressEvents = true
        defer { suppressEvents = false }

        if let v = dict["theme"] as? String {
            theme = v
        }
        if let v = dict["pollIntervalSeconds"] as? Int {
            pollIntervalSeconds = v
        }
        if let v = dict["pollIntervalBatterySeconds"] as? Int {
            pollIntervalBatterySeconds = v
        }
        if let v = dict["inactiveAccountSuspendMinutes"] as? Int {
            inactiveAccountSuspendMinutes = v
        }
        if let v = dict["launchAtLogin"] as? Bool {
            launchAtLogin = v
        }
        if let v = dict["composeAccountPicker"] as? String {
            composeAccountPicker = v
        }
        if let v = dict["quickComposeHotkey"] as? String {
            quickComposeHotkey = v
        }
        if let v = dict["dockBadgeMode"] as? String {
            dockBadgeMode = v
        }
        if let v = dict["showMenuBarTray"] as? Bool {
            showMenuBarTray = v
        }
        if let v = dict["menuBarShowCount"] as? Bool {
            menuBarShowCount = v
        }
        if let v = dict["menuBarShowDots"] as? Bool {
            menuBarShowDots = v
        }
        if let v = dict["menuBarUnreadOnly"] as? Bool {
            menuBarUnreadOnly = v
        }
        if let v = dict["hidePromotionAds"] as? Bool {
            hidePromotionAds = v
        }
        if let v = dict["hideSidebar"] as? Bool {
            hideSidebar = v
        }
        if let v = dict["transparentBackground"] as? Bool {
            transparentBackground = v
        }

        if let notifs = dict["notifications"] as? [String: String] {
            if let v = notifs["primary"] {
                notifPrimary = v
            }
            if let v = notifs["updates"] {
                notifUpdates = v
            }
            if let v = notifs["promotions"] {
                notifPromotions = v
            }
            if let v = notifs["social"] {
                notifSocial = v
            }
            if let v = notifs["forums"] {
                notifForums = v
            }
        }
    }

    private func emit(_ key: String, _ value: Any) {
        guard !suppressEvents else { return }
        transport?.sendEvent(method: "settings.changed", params: ["key": key, "value": value])
    }

    private func emitNotif(_ category: String, _ level: String) {
        guard !suppressEvents else { return }
        // Notifications are nested: send as a special key
        transport?.sendEvent(method: "settings.changed", params: [
            "key": "notifications.\(category)",
            "value": level,
        ])
    }
}

/// The shared account list editor reads the account list and the transport, and
/// nothing else of this model. Everything Magimail-specific stays out of `HelperUI`.
extension SettingsModel: AccountListModel {}
