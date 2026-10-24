import AppKit
import HelperRPC
import MagimailHelperLib

// MagimailHelper — standalone Swift process for native UI.
// Communicates with Electron over stdin/stdout JSON-RPC.

let app = NSApplication.shared
let transport = StdioTransport()

// MARK: - Quitting

/// Forwards a quit aimed at this process to the main process, which owns the
/// shutdown.
///
/// Both processes register under the same bundle id, so a quit addressed to the
/// application by name may be delivered to either. The reverse needs no
/// handling: Electron signals the child directly, which never runs this path.
/// See `docs/shared/process-model-and-ipc.md#process-roles`.
final class HelperAppDelegate: NSObject, NSApplicationDelegate {
    private let transport: StdioTransport

    init(transport: StdioTransport) {
        self.transport = transport
    }

    func applicationShouldTerminate(_: NSApplication) -> NSApplication.TerminateReply {
        // Written synchronously, so it is on the pipe before this process goes.
        transport.sendEvent(method: "app.quit")
        return .terminateNow
    }
}

let appDelegate = HelperAppDelegate(transport: transport)
app.delegate = appDelegate

HelperLog.info("Lifecycle", "MagimailHelper started")

Task { @MainActor in
    FocusFilterController.shared.setup(transport: transport)
}

transport.onMessage { request in
    switch request.method {
    case "settings.show":
        // Update model with current state
        var pane: String?
        if let params = request.params?.dict {
            if let targetPane = params["pane"] as? String {
                pane = targetPane
            }
            if let settings = params["settings"] as? [String: Any] {
                SettingsModel.shared.update(from: settings)
            }
            if let accounts = params["accounts"] as? [[String: Any]] {
                SettingsModel.shared.accounts = accounts
            }
            if let version = params["appVersion"] as? String {
                SettingsModel.shared.appVersion = version
            }
        }
        HelperLog.info("Settings", "Showing settings window, pane=\(pane ?? "default")")
        SettingsWindow.show(transport: transport, pane: pane)
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    case "settings.update":
        HelperLog.info("Settings", "Settings updated")
        if let settings = request.params?.dict?["settings"] as? [String: Any] {
            SettingsModel.shared.update(from: settings)
        }
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    case "accounts.update":
        let accounts = request.params?.dict?["accounts"] as? [[String: Any]] ?? []
        HelperLog.info("Accounts", "Accounts updated: \(accounts.count) account(s)")
        SettingsModel.shared.accounts = accounts
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    // MARK: - Menu Bar Tray

    case "tray.create":
        HelperLog.info("Tray", "Creating menu bar tray")
        MenuBarController.shared.create(transport: transport)
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    case "tray.destroy":
        HelperLog.info("Tray", "Destroying menu bar tray")
        MenuBarController.shared.destroy()
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    case "tray.update":
        if let params = request.params?.dict {
            MenuBarController.shared.updateData(params: params)
        }
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    case "tray.messages":
        // Response from Electron with messages for an account
        if let params = request.params?.dict,
           let accountId = params["accountId"] as? String,
           let messages = params["messages"] as? [[String: Any]]
        {
            MenuBarController.shared.updateMessages(accountId: accountId, messages: messages)
        }
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    // MARK: - Notifications

    case "notify.setup":
        // Sent once at launch, so Magimail appears in System Settings >
        // Notifications before there is anything to notify about.
        NotificationController.shared.prepare(transport: transport)
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    case "notify.clearAll":
        // Sent as the app removes itself, so no banner survives pointing at an account
        // whose data has gone.
        NotificationController.shared.clearAll()
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    case "notify.dispatch":
        if let params = request.params?.dict {
            NotificationController.shared.dispatch(transport: transport, params: params)
        }
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    // MARK: - Focus Filters

    case "focusFilter.get":
        Task { @MainActor in
            if let id = request.id {
                transport.sendResponse(id: id, result: [
                    "activeAccountIds": FocusFilterController.shared.activeAccountIds,
                    "disableExcludedAccounts": FocusFilterController.shared.disableExcludedAccounts,
                    "isFilterActive": FocusFilterController.shared.isFilterActive,
                ])
            }
        }

    case "focusFilter.set":
        Task { @MainActor in
            if let params = request.params?.dict {
                let activeAccountIds = params["activeAccountIds"] as? [String] ?? []
                let disableExcludedAccounts = params["disableExcludedAccounts"] as? Bool ?? false
                FocusFilterController.shared.applyFilter(
                    activeAccountIds: activeAccountIds,
                    disableExcludedAccounts: disableExcludedAccounts
                )
            }
            if let id = request.id {
                transport.sendResponse(id: id, result: "ok")
            }
        }

    default:
        HelperLog.warn("RPC", "Unknown method: \(request.method)")
        if let id = request.id {
            transport.sendResponse(id: id, error: "Unknown method: \(request.method)")
        }
    }
}

transport.startReading()

// Run the AppKit event loop (required for windows)
app.setActivationPolicy(.accessory)
app.run()
