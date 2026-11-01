import AppKit
import HelperRPC
import HelperUI
import SwiftUI

// MARK: - Settings Window

/// Builds Magical's settings window and hands it to the shared host.
///
/// The window, the tab host, the account list editor, the two row views and the
/// colour helpers are in `HelperUI`. What is left here is the title, the tab order
/// and the panes, which read Magical's own settings model.
@MainActor
public enum SettingsWindow {
    /// Starting colours for new accounts, taken in turn so two do not arrive
    /// the same. Only a starting point — any colour can be chosen afterwards.
    private static let startingColors = [
        "#a855f7", "#3b82f6", "#22c55e", "#f97316",
        "#ec4899", "#14b8a6", "#eab308", "#78716c",
    ]

    public static func show(transport: StdioTransport, pane: String? = nil) {
        let model = SettingsModel.shared
        model.transport = transport

        SettingsWindowController.shared.show(
            SettingsWindowSpec(
                title: String(localized: "Magical Settings"),
                tabs: [
                    SettingsTab(
                        id: "general",
                        label: String(localized: "General"),
                        icon: "gearshape",
                        height: 200
                    ) {
                        GeneralTab().environmentObject(model)
                    },
                    SettingsTab(
                        id: "accounts",
                        label: String(localized: "Accounts"),
                        icon: "person.2",
                        height: 340
                    ) {
                        AccountsTab(model: model, startingColors: Self.startingColors)
                    },
                    // Appearance took the Dock badge off Notifications, so it carries that
                    // section's height as well as its own; Notifications traded it for the
                    // Focus Filters section, which is a little taller than what it lost.
                    SettingsTab(
                        id: "appearance",
                        label: String(localized: "Appearance"),
                        icon: "paintbrush",
                        // 570 held the toggle alone; the caption under it now needs
                        // the room.
                        height: 610
                    ) {
                        AppearanceTab().environmentObject(model)
                    },
                    SettingsTab(
                        id: "notifications",
                        label: String(localized: "Notifications"),
                        icon: "bell",
                        height: 550
                    ) {
                        NotificationsTab().environmentObject(model)
                    },
                    SettingsTab(
                        id: "advanced",
                        label: String(localized: "Advanced"),
                        icon: "wrench.adjustable",
                        height: 290
                    ) {
                        AdvancedTab().environmentObject(model)
                    },
                ]
            ),
            pane: pane
        )
    }
}

// MARK: - General Tab

/// Short, because every control in this window is wired to something the app
/// reads and Magical reads little yet. A toggle here that nothing acts on would
/// be worse than a thin tab — it reads as a feature and silently does nothing.
struct GeneralTab: View {
    @EnvironmentObject var model: SettingsModel

    var body: some View {
        Form {
            Toggle("Launch Magical at login", isOn: $model.launchAtLogin)
                .onAppear { model.refreshHandlers() }

            Divider()

            Picker("New event account:", selection: $model.addEventAccountPicker) {
                Text("Use active account").tag("active")
                Text("Always ask").tag("ask")
            }
            .help("Applies to the menu bar, widgets and links. Inside the app, the account on screen is always used.")

            Divider()

            ForEach(model.handlerRows) { row in
                DefaultHandlerRow(
                    item: DefaultHandlerRow.Item(
                        id: row.id,
                        label: row.label,
                        handler: row.handler,
                        isClaimed: row.isMagical
                    ),
                    appName: "Magical",
                    canClaim: model.canClaimDefaults
                ) {
                    model.claimHandler(row.target)
                }
            }
        }
    }
}

// MARK: - Notifications Tab

struct NotificationsTab: View {
    @EnvironmentObject var model: SettingsModel

    var body: some View {
        Form {
            Section("Meeting alerts") {
                Toggle("Alert me before meetings start", isOn: $model.meetingAlertsEnabled)

                Picker("Alert me:", selection: $model.meetingAlertLeadMinutes) {
                    Text("1 minute before").tag(1)
                    Text("5 minutes before").tag(5)
                    Text("10 minutes before").tag(10)
                    Text("15 minutes before").tag(15)
                    Text("30 minutes before").tag(30)
                }
                .disabled(!model.meetingAlertsEnabled)

                // An event that sets its own notification time in Google Calendar is
                // alerted at that time; this picker covers the rest. Saying so stops it
                // reading as an override of what Google Calendar is set to.
                Text(
                    "Used for meetings that have no notification time of their own. A meeting that sets one in Google Calendar is alerted at that time instead."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }

            Section("Alerts by calendar") {
                calendarBox
                    .disabled(!model.meetingAlertsEnabled)

                Text(
                    "Muted calendars do not raise upcoming meeting alerts or dock badge invitation counts."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }

            Section("Joining calls") {
                Toggle("Always open calls in the browser", isOn: $model.alwaysJoinInBrowser)

                Text(
                    "Zoom and Teams calls open in their desktop apps by default. Turn this on if you are signed in to the meeting's account in a browser rather than in the desktop app."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }

            Section("Focus Filters") {
                HStack {
                    Text("Focus Status:")
                    Spacer()
                    Text(model.focusFilterStatus)
                        .foregroundStyle(.secondary)
                }

                Text(
                    "Configure Focus Filters in macOS System Settings to select which accounts and calendars stay active, and whether to prevent access to silenced accounts."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

                Button("Open Focus Settings…") {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.Focus-Settings.extension") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        }
    }

    private var calendarBox: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 6) {
                if model.availableCalendars.isEmpty {
                    Text("No calendars available")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 20)
                } else {
                    if model.accountsList.count > 1 {
                        ForEach(Array(model.accountsList.enumerated()), id: \.element.id) { index, account in
                            let accountCalendars = model.availableCalendars.filter { $0.accountId == account.id }
                            if !accountCalendars.isEmpty {
                                accountRow(account)
                                    .padding(.top, index == 0 ? 0 : 4)

                                ForEach(accountCalendars) { cal in
                                    calendarRow(cal)
                                        .padding(.leading, 16)
                                }
                            }
                        }
                    } else {
                        ForEach(model.availableCalendars) { cal in
                            calendarRow(cal)
                        }
                    }

                    let unassigned = model.availableCalendars.filter { cal in
                        !model.accountsList.contains(where: { $0.id == cal.accountId })
                    }
                    if !unassigned.isEmpty {
                        if model.accountsList.count > 1 {
                            Text("Other")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .padding(.top, 4)
                        }
                        ForEach(unassigned) { cal in
                            calendarRow(cal)
                        }
                    }
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: 140)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
        )
    }

    /// The account's own row: a group header that is also the switch for the whole group.
    ///
    /// Muting an account means muting each of its calendars, which is six ticks on a busy
    /// account and the same six again to put back. Ticking the header does both, and the
    /// calendars underneath stay individually adjustable afterwards.
    private func accountRow(_ account: TrayAccount) -> some View {
        Toggle(isOn: Binding(
            get: { model.isAlertsEnabled(forAccount: account.id) },
            set: { enabled in model.setAlertsEnabled(enabled, forAccount: account.id) }
        )) {
            Text(account.name)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .toggleStyle(.checkbox)
    }

    private func calendarRow(_ cal: TrayCalendarItem) -> some View {
        Toggle(isOn: Binding(
            get: { model.isAlertsEnabled(for: cal) },
            set: { enabled in model.setAlertsEnabled(enabled, for: cal) }
        )) {
            HStack(spacing: 6) {
                Image(nsImage: AccountDot.image(hex: cal.colorHex))
                Text(cal.name)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .toggleStyle(.checkbox)
    }
}

// MARK: - Advanced Tab

struct AdvancedTab: View {
    @EnvironmentObject var model: SettingsModel

    var body: some View {
        Form {
            Section("Memory") {
                Picker("Unload inactive after:", selection: $model.inactiveAccountSuspendMinutes) {
                    Text("1 minute").tag(1)
                    Text("5 minutes").tag(5)
                    Text("10 minutes").tag(10)
                    Text("30 minutes").tag(30)
                    Text("1 hour").tag(60)
                    Text("Never").tag(0)
                }
                Text(
                    "An account you switch away from stays in memory for this long, then unloads to free around 300MB. Background events and alerts keep arriving either way, and returning to an unloaded account reopens it where you left off."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }

            Divider()

            Section("Diagnostics") {
                Text(
                    "Assembles application and extension logs along with system environment info into a redacted archive for troubleshooting."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                Button("Collect Diagnostics…") {
                    model.transport?.sendEvent(method: "settings.changed", params: [
                        "key": "collectDiagnostics",
                        "value": true,
                    ])
                }
            }
        }
    }
}

// MARK: - Appearance Tab

struct AppearanceTab: View {
    @EnvironmentObject var model: SettingsModel

    var body: some View {
        Form {
            Section("Theme") {
                Picker("Theme:", selection: $model.theme) {
                    Text("System Default").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
                .pickerStyle(.segmented)
                Text(
                    "Keep Google Calendar's own Appearance setting on \"Device\" and it will follow this."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Divider()

            Section("Window") {
                Toggle("Transparent background", isOn: $model.transparentBackground)
            }

            Divider()

            Section("Google Calendar") {
                Toggle("Hide app sidebar", isOn: $model.hideSidebar)
                Toggle("Hide Tasks tab", isOn: $model.hideTasksTab)
                Text(
                    "Hides the Calendar/Tasks switcher at the top of the app. Tasks stays reachable from the sidebar."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

                // Not a Google Calendar setting, but it sits beside "Hide Tasks tab"
                // so the caption has to say where it does apply.
                Toggle("Show completed tasks", isOn: $model.showCompletedTasks)
                Text(
                    "Applies to the menu bar popover and the widgets, not the Tasks view inside the app."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }

            Divider()

            Section("Dock & Menu Bar") {
                Picker("Dock badge:", selection: $model.dockBadgeMode) {
                    Text("All outstanding invitations").tag("allPending")
                    Text("Unread invitations").tag("newInvitations")
                }

                Text(
                    "The badge counts invitations, never meetings. All outstanding keeps counting every invitation awaiting a reply. Unread invitations counts only those that arrived and have not been answered or marked read. Either way, only answering an invitation takes the number down."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

                Toggle("Show menu bar icon", isOn: $model.showMenuBarIcon)

                if model.showMenuBarIcon {
                    Picker("Menu bar display:", selection: $model.menuBarDisplayMode) {
                        Text("Next event").tag("nextEvent")
                        Text("Day of month").tag("dayOfMonth")
                        Text("Day and month").tag("dayAndMonth")
                        Text("Icon only").tag("iconOnly")
                    }

                    if model.menuBarDisplayMode == "nextEvent" {
                        Toggle("Color by account", isOn: $model.showMenuBarAccountColor)
                    }
                }
            }
        }
    }
}
