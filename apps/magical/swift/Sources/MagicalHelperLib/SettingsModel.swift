import Foundation
import HelperRPC
import HelperUI
import SwiftUI

/// Observable settings state, mirrored from the main process and pushed back to
/// it on every change.
///
/// Deliberately narrow: it carries only settings the app actually acts on. A
/// toggle here that nothing reads is worse than a missing one — it reads as a
/// feature and silently does nothing.
@MainActor
public final class SettingsModel: ObservableObject {
    public static let shared = SettingsModel()

    public var transport: StdioTransport?

    // MARK: - General

    @Published public var theme: String = "system" {
        didSet { emit("theme", theme) }
    }

    @Published public var launchAtLogin: Bool = false {
        didSet { emit("launchAtLogin", launchAtLogin) }
    }

    @Published public var addEventAccountPicker: String = "active" {
        didSet { emit("addEventAccountPicker", addEventAccountPicker) }
    }

    @Published public var inactiveAccountSuspendMinutes: Int = 5 {
        didSet { emit("inactiveAccountSuspendMinutes", inactiveAccountSuspendMinutes) }
    }

    // MARK: - Notifications

    @Published public var meetingAlertsEnabled: Bool = true {
        didSet { emit("meetingAlertsEnabled", meetingAlertsEnabled) }
    }

    @Published public var meetingAlertLeadMinutes: Int = 5 {
        didSet { emit("meetingAlertLeadMinutes", meetingAlertLeadMinutes) }
    }

    @Published public var disabledAlertCalendarIds: [String] = [] {
        didSet { emit("disabledAlertCalendarIds", disabledAlertCalendarIds) }
    }

    @Published public var alwaysJoinInBrowser: Bool = false {
        didSet { emit("alwaysJoinInBrowser", alwaysJoinInBrowser) }
    }

    @Published public var showMenuBarIcon: Bool = true {
        didSet { emit("showMenuBarIcon", showMenuBarIcon) }
    }

    @Published public var menuBarDisplayMode: String = "iconOnly" {
        didSet { emit("menuBarDisplayMode", menuBarDisplayMode) }
    }

    @Published public var showMenuBarAccountColor: Bool = true {
        didSet { emit("showMenuBarAccountColor", showMenuBarAccountColor) }
    }

    @Published public var dockBadgeMode: String = "allPending" {
        didSet { emit("dockBadgeMode", dockBadgeMode) }
    }

    // MARK: - Appearance

    @Published public var transparentBackground: Bool = true {
        didSet { emit("transparentBackground", transparentBackground) }
    }

    @Published public var hideSidebar: Bool = false {
        didSet { emit("hideSidebar", hideSidebar) }
    }

    @Published public var hideTasksTab: Bool = false {
        didSet { emit("hideTasksTab", hideTasksTab) }
    }

    @Published public var showCompletedTasks: Bool = true {
        didSet { emit("showCompletedTasks", showCompletedTasks) }
    }

    // MARK: - Focus Filter

    /// Read aloud in Settings → Notifications. Written by `FocusFilterController` as the
    /// filter changes rather than pushed from the main process, which knows the filter only
    /// through the helper's `focusFilter.changed` event.
    @Published public var focusFilterStatus = String(localized: "Inactive (All calendars active)")

    // MARK: - Accounts & Calendars

    @Published public var accounts: [[String: Any]] = []
    @Published public var browserProfiles: [String: [[String: String]]] = [:]

    @Published public var calendars: [TrayCalendarItem] = []

    public var accountsList: [TrayAccount] {
        accounts.map { TrayAccount(from: $0) }
    }

    public var availableCalendars: [TrayCalendarItem] {
        if !calendars.isEmpty {
            return calendars
        }
        var list: [TrayCalendarItem] = []
        var seen = Set<String>()
        for account in accountsList {
            if !seen.contains(account.id) {
                seen.insert(account.id)
                list.append(TrayCalendarItem(
                    id: account.id,
                    accountId: account.id,
                    name: account.name,
                    colorHex: account.color
                ))
            }
        }
        return list
    }

    public func isAlertsEnabled(for calendar: TrayCalendarItem) -> Bool {
        !disabledAlertCalendarIds.contains(Self.alertKey(calendar))
            && !disabledAlertCalendarIds.contains(calendar.id)
    }

    public func setAlertsEnabled(_ enabled: Bool, for calendar: TrayCalendarItem) {
        let key = Self.alertKey(calendar)
        // The bare id is the older shape, which muted the calendar in every account. Taking
        // it out too is what lets this calendar be unmuted without the other account's copy
        // staying quiet.
        if enabled {
            disabledAlertCalendarIds.removeAll { $0 == key || $0 == calendar.id }
        } else if !disabledAlertCalendarIds.contains(key) {
            disabledAlertCalendarIds.append(key)
        }
    }

    /// Whether every calendar on this account raises alerts.
    ///
    /// An account with no calendars reads as enabled: the header checkbox is then the only
    /// thing in the group, and an unticked box over nothing says a mute that is not there.
    public func isAlertsEnabled(forAccount accountId: String) -> Bool {
        availableCalendars
            .filter { $0.accountId == accountId }
            .allSatisfy { isAlertsEnabled(for: $0) }
    }

    /// Mutes or unmutes every calendar on one account at once.
    ///
    /// Written as one change to `disabledAlertCalendarIds` rather than a loop of them: the
    /// property emits to the main process on every set, and a loop would send one message
    /// per calendar and persist an intermediate state on each.
    public func setAlertsEnabled(_ enabled: Bool, forAccount accountId: String) {
        let calendars = availableCalendars.filter { $0.accountId == accountId }
        guard !calendars.isEmpty else { return }

        let keys = Set(calendars.map { Self.alertKey($0) })
        let bare = Set(calendars.map(\.id))
        var next = disabledAlertCalendarIds.filter { !keys.contains($0) && !bare.contains($0) }
        if !enabled {
            next.append(contentsOf: keys.sorted())
        }
        disabledAlertCalendarIds = next
    }

    /// The key one calendar's alert mute is stored under: `accountId|calendarId`.
    ///
    /// The account as well as the calendar, because Google gives Birthdays, Tasks and each
    /// locale's holidays the same id in every account, and muting one account's must not
    /// silence another's.
    private static func alertKey(_ calendar: TrayCalendarItem) -> String {
        "\(calendar.accountId)|\(calendar.id)"
    }

    @Published public var appVersion: String = ""

    // MARK: - Default handlers

    /// One row per type Magical can claim, read live from LaunchServices.
    ///
    /// Not mirrored from `settings.json` like everything above it, because the answer is
    /// not Magical's to remember: the user can change the handler in Finder at any time,
    /// and a row showing what Magical last set would be a row that lies.
    public struct HandlerRow: Identifiable {
        public let target: String
        public let label: String
        /// The app that opens this type today, by its display name.
        public let handler: String
        public let isMagical: Bool

        public var id: String {
            target
        }
    }

    @Published public var handlerRows: [HandlerRow] = []
    /// False outside an app bundle, as under `pnpm dev`, where there is nothing to register.
    @Published public var canClaimDefaults = false

    /// Re-reads LaunchServices. Called when the window appears and after every claim.
    public func refreshHandlers() {
        let report = DefaultHandler.report()
        canClaimDefaults = report["canClaim"] as? Bool ?? false
        handlerRows = (report["handlers"] as? [[String: Any]] ?? []).map {
            HandlerRow(
                target: $0["target"] as? String ?? "",
                label: $0["label"] as? String ?? "",
                handler: $0["handler"] as? String ?? "",
                isMagical: $0["isMagical"] as? Bool ?? false
            )
        }
    }

    /// Claims one type, then re-reads rather than assuming it worked.
    public func claimHandler(_ target: String) {
        guard let parsed = DefaultHandler.Target(rawValue: target) else { return }
        DefaultHandler.claim(parsed) { [weak self] _ in
            self?.refreshHandlers()
        }
    }

    /// Set while the main process is writing its own state in, so replaying it
    /// does not echo every value straight back as a user edit.
    private var suppressEvents = false

    public func update(from dict: [String: Any]) {
        suppressEvents = true
        defer { suppressEvents = false }

        if let v = dict["theme"] as? String {
            theme = v
        }
        if let v = dict["launchAtLogin"] as? Bool {
            launchAtLogin = v
        }
        if let v = dict["addEventAccountPicker"] as? String {
            addEventAccountPicker = v
        }
        if let v = dict["inactiveAccountSuspendMinutes"] as? Int {
            inactiveAccountSuspendMinutes = v
        }
        if let v = dict["meetingAlertsEnabled"] as? Bool {
            meetingAlertsEnabled = v
        }
        if let v = dict["meetingAlertLeadMinutes"] as? Int {
            meetingAlertLeadMinutes = v
        }
        if let v = dict["disabledAlertCalendarIds"] as? [String] {
            disabledAlertCalendarIds = v
        }
        if let v = dict["alwaysJoinInBrowser"] as? Bool {
            alwaysJoinInBrowser = v
        }
        if let v = dict["showMenuBarIcon"] as? Bool {
            showMenuBarIcon = v
        }
        if let v = dict["menuBarDisplayMode"] as? String {
            menuBarDisplayMode = v
        }
        if let v = dict["showMenuBarAccountColor"] as? Bool {
            showMenuBarAccountColor = v
        }
        if let v = dict["dockBadgeMode"] as? String {
            dockBadgeMode = v
        }
        if let v = dict["transparentBackground"] as? Bool {
            transparentBackground = v
        }
        if let v = dict["hideSidebar"] as? Bool {
            hideSidebar = v
        }
        if let v = dict["hideTasksTab"] as? Bool {
            hideTasksTab = v
        }
        if let v = dict["showCompletedTasks"] as? Bool {
            showCompletedTasks = v
        }
    }

    private func emit(_ key: String, _ value: Any) {
        guard !suppressEvents else { return }
        transport?.sendEvent(method: "settings.changed", params: ["key": key, "value": value])
    }
}

/// The shared account list editor reads the account list and the transport, and
/// nothing else of this model. Everything Magical-specific stays out of `HelperUI`.
extension SettingsModel: AccountListModel {}
