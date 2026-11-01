import AppKit
import HelperRPC
import HelperUI
import SwiftUI

// MARK: - Settings Window

/// Builds Magimail's settings window and hands it to the shared host.
///
/// The window, the tab host, the account list editor, the two row views and the
/// colour helpers are in `HelperUI`. What is left here is the title, the tab order
/// and the panes, which read Magimail's own settings model.
@MainActor
public enum SettingsWindow {
    /// Starting colours for new accounts, taken in turn so two do not arrive
    /// the same. Only a starting point — any colour can be chosen afterwards.
    private static let startingColors = [
        "#3b82f6", "#a855f7", "#22c55e", "#f97316",
        "#ef4444", "#eab308", "#f472b6", "#78716c",
    ]

    public static func show(transport: StdioTransport, pane: String? = nil) {
        let model = SettingsModel.shared
        model.transport = transport

        // Appearance sits before Notifications so the five tabs run in the same order
        // as Magical's; the two windows are otherwise the same shape.
        SettingsWindowController.shared.show(
            SettingsWindowSpec(
                title: String(localized: "Magimail Preferences"),
                tabs: [
                    SettingsTab(
                        id: "general",
                        label: String(localized: "General"),
                        icon: "gearshape",
                        height: 180
                    ) {
                        GeneralTab().environmentObject(model)
                    },
                    SettingsTab(
                        id: "accounts",
                        label: String(localized: "Accounts"),
                        icon: "person.2",
                        height: 240
                    ) {
                        AccountsTab(model: model, startingColors: Self.startingColors)
                    },
                    SettingsTab(
                        id: "appearance",
                        label: String(localized: "Appearance"),
                        icon: "paintbrush",
                        height: 360
                    ) {
                        AppearanceTab().environmentObject(model)
                    },
                    SettingsTab(
                        id: "notifications",
                        label: String(localized: "Notifications"),
                        icon: "bell",
                        height: 390
                    ) {
                        NotificationsTab().environmentObject(model)
                    },
                    // Advanced carries Fetch Frequency, Memory and Diagnostics sections. The
                    // session Reset lives on the Accounts tab.
                    SettingsTab(
                        id: "advanced",
                        label: String(localized: "Advanced"),
                        icon: "wrench.adjustable",
                        height: 330
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

struct GeneralTab: View {
    @EnvironmentObject var model: SettingsModel

    var body: some View {
        Form {
            Toggle("Launch Magimail at login", isOn: $model.launchAtLogin)
                .onAppear { model.refreshHandlers() }

            Divider()

            Picker("Compose account:", selection: $model.composeAccountPicker) {
                Text("Use active account").tag("active")
                Text("Always ask").tag("ask")
            }
            .help("Applies to the main window, where the active account is on screen. A mailto: link, a widget, the menu bar and the quick compose hotkey always ask, since none of them shows you which account is active.")

            // Tags are Electron accelerator strings, matching QUICK_COMPOSE_CHORDS
            // in settings-store.ts; the labels are their macOS glyphs.
            Picker("Quick compose hotkey:", selection: $model.quickComposeHotkey) {
                Text("Off").tag("off")
                Text(verbatim: "⌥⌘C").tag("Alt+Command+C")
                Text(verbatim: "⌃⌘C").tag("Control+Command+C")
                Text(verbatim: "⇧⌘C").tag("Shift+Command+C")
                Text(verbatim: "⌃⌥⌘C").tag("Control+Alt+Command+C")
            }
            .help("Opens a compose window from any application. It always asks which account to send from when there is more than one, since no account is on screen to be the active one.")

            Divider()

            ForEach(model.handlerRows) { row in
                DefaultHandlerRow(
                    item: DefaultHandlerRow.Item(
                        id: row.id,
                        label: row.label,
                        handler: row.handler,
                        isClaimed: row.isMagimail
                    ),
                    appName: "Magimail",
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
            Section("Category Notification Levels") {
                notifPicker("Primary:", selection: $model.notifPrimary)
                notifPicker("Updates:", selection: $model.notifUpdates)
                notifPicker("Promotions:", selection: $model.notifPromotions)
                notifPicker("Social:", selection: $model.notifSocial)
                notifPicker("Forums:", selection: $model.notifForums)
            }

            Divider()

            Section("Focus Filters") {
                HStack {
                    Text("Focus Status:")
                    Spacer()
                    Text(model.focusFilterStatus)
                        .foregroundColor(.secondary)
                }

                Text("Configure Focus Filters in macOS System Settings to select which accounts are active and whether to hide excluded accounts from the window and menu bar.")
                    .font(.caption)
                    .foregroundColor(.secondary)

                Button("Open Focus Settings…") {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.Focus-Settings.extension") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        }
    }

    private func notifPicker(_ label: LocalizedStringKey, selection: Binding<String>) -> some View {
        Picker(label, selection: selection) {
            Text("Loud").tag("loud")
            Text("Silent").tag("silent")
            Text("Badge only").tag("badge")
            Text("Off").tag("off")
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
                Text("For best results, keep Gmail's own theme set to \"Default\" (light) and let Magimail handle dark mode.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Divider()

            Section("Window") {
                Toggle("Transparent background", isOn: $model.transparentBackground)
            }

            Divider()

            Section("Gmail") {
                Toggle("Hide inbox ads", isOn: $model.hidePromotionAds)
                Toggle("Hide app sidebar", isOn: $model.hideSidebar)
            }

            Divider()

            Section("Dock & Menu Bar") {
                Picker("Dock badge:", selection: $model.dockBadgeMode) {
                    Text("All unread messages").tag("allUnread")
                    Text("New messages only").tag("newArrivals")
                    Text("Off").tag("off")
                }
                if model.dockBadgeMode == "newArrivals" {
                    Text("Counts mail that arrived while you were away, and goes down as you read it. The backlog is left out.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Toggle("Show menu bar tray", isOn: $model.showMenuBarTray)
                Toggle("Show unread count", isOn: $model.menuBarShowCount)
                Toggle("Show color dots", isOn: $model.menuBarShowDots)
                Toggle("Show unread only in the popover", isOn: $model.menuBarUnreadOnly)
                Toggle("Show verification codes", isOn: $model.menuBarVerificationCodes)
                if model.menuBarVerificationCodes {
                    Picker("Keep in menu bar for:", selection: $model.verificationCodeDurationMinutes) {
                        Text("5 minutes").tag(5)
                        Text("10 minutes").tag(10)
                        Text("15 minutes").tag(15)
                        Text("30 minutes").tag(30)
                    }
                }
            }
        }
    }
}

// MARK: - Advanced Tab

struct AdvancedTab: View {
    @EnvironmentObject var model: SettingsModel

    var body: some View {
        Form {
            Section("Fetch Frequency") {
                Picker("On power adapter:", selection: $model.pollIntervalSeconds) {
                    Text("Every 30 seconds").tag(30)
                    Text("Every minute").tag(60)
                    Text("Every 2 minutes").tag(120)
                    Text("Every 5 minutes").tag(300)
                    Text("Every 15 minutes").tag(900)
                }
                Picker("On battery:", selection: $model.pollIntervalBatterySeconds) {
                    Text("Every minute").tag(60)
                    Text("Every 2 minutes").tag(120)
                    Text("Every 3 minutes").tag(180)
                    Text("Every 5 minutes").tag(300)
                    Text("Every 10 minutes").tag(600)
                    Text("Every 15 minutes").tag(900)
                }
                Text("Checks Gmail's background feed to update unread counts and deliver native notifications.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    // Wrap rather than truncate: the form is a fixed 400pt wide,
                    // which is narrower than any of these captions.
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()

            Section("Memory") {
                // Kept terse to match "On battery:" above — a longer label
                // squeezes the popup and the caption on a 400pt form.
                Picker("Unload inactive after:", selection: $model.inactiveAccountSuspendMinutes) {
                    Text("1 minute").tag(1)
                    Text("5 minutes").tag(5)
                    Text("10 minutes").tag(10)
                    Text("30 minutes").tag(30)
                    Text("1 hour").tag(60)
                    Text("Never").tag(0)
                }
                Text("An account you switch away from stays in memory for this long, then unloads to free around 450MB. Unread counts and notifications keep arriving either way, and returning to an unloaded account reopens it where you left off.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()

            Section("Diagnostics") {
                Text("Assembles application and extension logs along with system environment info into a redacted archive for troubleshooting.")
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
