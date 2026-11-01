import AppKit
import HelperRPC
import MagicalHelperLib

// MagicalHelper — standalone Swift process owning Magical's native settings
// window. Communicates with Electron over stdin/stdout JSON-RPC.
//
// A separate process rather than a window in Electron because the settings UI
// is SwiftUI over AppKit, which cannot run inside the Electron main process, and
// because Electron's own Notification cannot render the action buttons a meeting
// alert needs. Magimail's helper also owns its menu bar item; Magical has none yet.

let app = NSApplication.shared
let transport = StdioTransport()

/// Forwards a quit aimed at this process to the main process, which owns the
/// shutdown.
///
/// Both processes register under the same bundle id, so a quit addressed to the
/// application by name may be delivered to either. The reverse needs no
/// handling: Electron signals the child directly, which never runs this path.
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

HelperLog.subsystem = "com.alexhaslam.magical"
HelperLog.info("Lifecycle", "MagicalHelper started")

// Before `startReading`, not from `applicationDidFinishLaunching`: requests are answered
// from the moment reading starts, and a launch that has not read the filter yet posts a
// banner a Focus should have silenced. The helper is respawned freely, on a crash or a
// rebuild, so that window can fall anywhere — including just before a meeting alert.
//
// Top-level code runs on the main thread, which is what `assumeIsolated` is asserting.
MainActor.assumeIsolated {
    FocusFilterController.shared.onFilterChanged = {
        // The status item is drawn by AppKit, so nothing redraws it on its own.
        MenuBarController.shared.updateTitle()
    }
    // A Focus already on when the helper came back posts no notification of its own, so the
    // file the App Intents extension last wrote is the only way to learn about it.
    FocusFilterController.shared.setup(transport: transport)
}

transport.onMessage { request in
    switch request.method {
    case "settings.show":
        let pane = request.params?.dict?["pane"] as? String
        HelperLog.info("Settings", "Showing settings window, pane=\(pane ?? "default")")
        if let params = request.params?.dict {
            if let settings = params["settings"] as? [String: Any] {
                SettingsModel.shared.update(from: settings)
            }
            if let accounts = params["accounts"] as? [[String: Any]] {
                SettingsModel.shared.accounts = accounts
                if let browserProfiles = request.params?.dict?["browserProfiles"] as? [String: [[String: String]]] {
                    SettingsModel.shared.browserProfiles = browserProfiles
                }
            }
            if let browserProfiles = params["browserProfiles"] as? [String: [[String: String]]] {
                SettingsModel.shared.browserProfiles = browserProfiles
            }
            if let calendars = params["calendars"] as? [[String: Any]] {
                SettingsModel.shared.calendars = calendars.map { TrayCalendarItem(from: $0) }
            }
            if let version = params["appVersion"] as? String {
                SettingsModel.shared.appVersion = version
            }
        }
        SettingsWindow.show(transport: transport, pane: pane)
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    case "settings.update":
        HelperLog.info("Settings", "Settings updated")
        if let settings = request.params?.dict?["settings"] as? [String: Any] {
            SettingsModel.shared.update(from: settings)
        }
        if let calendars = request.params?.dict?["calendars"] as? [[String: Any]] {
            SettingsModel.shared.calendars = calendars.map { TrayCalendarItem(from: $0) }
        }
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    // MARK: - Notifications

    case "notify.setup":
        // Registered at launch rather than on the first alert: until the app has asked,
        // System Settings has no Magical row to grant, so the first meeting is missed.
        NotificationController.shared.prepare(transport: transport)
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    case "notify.clearAll":
        // Sent as the app removes itself, so no alert survives pointing at a meeting
        // whose data has gone.
        NotificationController.shared.clearAll()
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    case "alert.dispatch":
        if let params = request.params?.dict {
            NotificationController.shared.dispatch(transport: transport, params: params)
        }
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    case "alert.withdraw":
        if let keys = request.params?.dict?["keys"] as? [String] {
            NotificationController.shared.withdraw(keys: keys)
        }
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    // MARK: - Default handlers

    case "defaults.query":
        if let id = request.id {
            transport.sendResponse(id: id, result: DefaultHandler.report())
        }

    case "defaults.claim":
        let raw = request.params?.dict?["target"] as? String ?? ""
        guard let target = DefaultHandler.Target(rawValue: raw) else {
            if let id = request.id {
                transport.sendResponse(id: id, error: "Unknown target \(raw)")
            }
            break
        }
        DefaultHandler.claim(target) { error in
            // Reported as an event as well as a response: the settings window has to
            // redraw its row whether the claim came from there or from the launch prompt.
            transport.sendEvent(method: "defaults.changed", params: DefaultHandler.report())
            if let id = request.id {
                transport.sendResponse(id: id, result: ["ok": error == nil, "error": error ?? ""])
            }
        }

    case "accounts.update":
        let accounts = request.params?.dict?["accounts"] as? [[String: Any]] ?? []
        HelperLog.info("Accounts", "Accounts updated: \(accounts.count) account(s)")
        SettingsModel.shared.accounts = accounts
        if let browserProfiles = request.params?.dict?["browserProfiles"] as? [String: [[String: String]]] {
            SettingsModel.shared.browserProfiles = browserProfiles
        }
        if let calendars = request.params?.dict?["calendars"] as? [[String: Any]] {
            SettingsModel.shared.calendars = calendars.map { TrayCalendarItem(from: $0) }
        }
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    case "calendars.update":
        let calendars = request.params?.dict?["calendars"] as? [[String: Any]] ?? []
        HelperLog.info("Calendars", "Calendars updated: \(calendars.count) calendar(s)")
        SettingsModel.shared.calendars = calendars.map { TrayCalendarItem(from: $0) }
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    // MARK: - Menu Bar Tray

    case "tray.create":
        MenuBarController.shared.create(transport: transport)
        if let id = request.id {
            transport.sendResponse(id: id, result: "ok")
        }

    case "tray.destroy":
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

    default:
        HelperLog.warn("RPC", "Unknown method: \(request.method)")
        if let id = request.id {
            transport.sendResponse(id: id, error: "Unknown method: \(request.method)")
        }
    }
}

transport.startReading()

// `.accessory`: the helper owns a window but must never claim its own Dock tile
// or menu bar — Magical is the application, this is a sidecar.
app.setActivationPolicy(.accessory)
app.run()
