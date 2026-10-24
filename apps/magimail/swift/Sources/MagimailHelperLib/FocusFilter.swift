import Foundation
import HelperRPC

/// The macOS Focus filter Magimail is under, and which accounts it silences.
///
/// The filter itself is declared once, in `MagimailAppIntents.appex` — the only bundle the
/// AppIntents runtime enumerates. This file holds no copy of the intent, the entity or the
/// query: a second declaration of all three lived here, and the picker drew its rows from
/// whichever copy the runtime reached, which is why an account's colour dot never appeared
/// however the extension's entity was written. Magical's helper has only ever held the
/// controller, and its picker draws dots. See `docs/magimail/focus-filters.md`.
///
/// What is left is the part the helper genuinely owns: the filter's current state, read from
/// `focus-filter.json`, and the question `NotificationController` asks of it before posting
/// a banner.
@MainActor
public final class FocusFilterController {
    public static let shared = FocusFilterController()

    public private(set) var activeAccountIds: [String] = []
    public private(set) var disableExcludedAccounts: Bool = false
    public private(set) var isFilterActive: Bool = false
    private var transport: StdioTransport?

    public init() {}

    public func setup(transport: StdioTransport) {
        self.transport = transport

        // The extension cannot call into this process, so it posts a distributed
        // notification after writing the file and this reads it back. Both halves matter:
        // the notification says *when*, the file says *what*, and the file is also what a
        // helper started after the fact reads to catch up.
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("com.alexhaslam.magimail.focusFilterChanged"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.loadPersistedFocusFilter()
            }
        }

        loadPersistedFocusFilter()
    }

    /// Re-reads `focus-filter.json`.
    ///
    /// A missing file is the ordinary case on a machine where no Focus has ever carried a
    /// Magimail filter, and means no filter rather than an error.
    public func loadPersistedFocusFilter() {
        // The App Intents extension writes into the App Group container, which
        // this helper is entitled for. The Application Support path is the
        // pre-group location, read once so an existing filter survives the
        // upgrade; a build with no group only has that fallback.
        let candidate = AppGroup.fileURL("focus-filter.json") ?? legacyFocusFilterURL()
        // A file that cannot be read clears the filter rather than leaving the
        // last one in force. Keeping it would mute accounts with no file left
        // to explain why and no Focus change coming to lift it.
        guard let candidate, FileManager.default.fileExists(atPath: candidate.path) else {
            applyFilter(activeAccountIds: [], disableExcludedAccounts: false)
            return
        }
        guard let data = try? Data(contentsOf: candidate),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            HelperLog.error("Focus", "focus-filter.json could not be read; clearing the filter")
            applyFilter(activeAccountIds: [], disableExcludedAccounts: false)
            return
        }

        let activeAccountIds = json["activeAccountIds"] as? [String] ?? []
        let disableExcludedAccounts = json["disableExcludedAccounts"] as? Bool ?? false
        applyFilter(activeAccountIds: activeAccountIds, disableExcludedAccounts: disableExcludedAccounts)

        // A file written before an account was removed still names it. Prune at every read,
        // not only on an account update, so a Focus change does not bring the stale entry
        // back into force between two `tray.update`s.
        prune(to: Set(TrayModel.shared.accounts.map(\.id)))
    }

    /// The pre-group location, read so an existing filter survives the upgrade.
    private func legacyFocusFilterURL() -> URL? {
        guard let pw = getpwuid(getuid()) else { return nil }
        let home = String(cString: pw.pointee.pw_dir) as NSString
        return URL(fileURLWithPath: home.appendingPathComponent(
            "Library/Application Support/Magimail/focus-filter.json"
        ))
    }

    public func applyFilter(activeAccountIds: [String], disableExcludedAccounts: Bool) {
        self.activeAccountIds = activeAccountIds
        self.disableExcludedAccounts = disableExcludedAccounts
        isFilterActive = !activeAccountIds.isEmpty

        HelperLog.info(
            "Focus",
            isFilterActive
                ? "Filter active; \(activeAccountIds.count) account(s) stay on, excluded accounts \(disableExcludedAccounts ? "disabled" : "silenced")"
                : "No filter; everything stays on"
        )

        updateSettingsStatus()

        // Electron owns the Dock badge and the window's account switcher, so it needs the
        // filter as well as the helper.
        transport?.sendEvent(method: "focusFilter.changed", params: [
            "activeAccountIds": activeAccountIds,
            "disableExcludedAccounts": disableExcludedAccounts,
            "isFilterActive": isFilterActive,
        ])
    }

    public func isAccountMuted(_ accountId: String) -> Bool {
        guard isFilterActive, !activeAccountIds.isEmpty else { return false }
        return !activeAccountIds.contains(accountId)
    }

    /// Drops filter entries naming accounts the app no longer has.
    ///
    /// The picker offers what `accounts.json` holds, so removing an account leaves its id
    /// in the stored Focus pointing at nothing. A filter naming only that account would
    /// otherwise mute every account that remains, with nothing on screen to say why.
    public func prune(to liveAccountIds: Set<String>) {
        // An empty list is "not known yet", not "everything was removed".
        guard !liveAccountIds.isEmpty else { return }

        let accounts = activeAccountIds.filter { liveAccountIds.contains($0) }
        guard accounts.count != activeAccountIds.count else { return }

        HelperLog.info(
            "Focus",
            "Dropped filter entries for \(activeAccountIds.count - accounts.count) removed account(s)"
        )
        applyFilter(activeAccountIds: accounts, disableExcludedAccounts: disableExcludedAccounts)
    }

    private func updateSettingsStatus() {
        if !isFilterActive {
            SettingsModel.shared.focusFilterStatus = String(localized: "Inactive (All accounts active)")
        } else if disableExcludedAccounts {
            SettingsModel.shared.focusFilterStatus =
                String(localized: "Active: \(activeAccountIds.count) accounts visible (others hidden)")
        } else {
            SettingsModel.shared.focusFilterStatus =
                String(localized: "Active: \(activeAccountIds.count) accounts active (others silenced)")
        }
    }
}
