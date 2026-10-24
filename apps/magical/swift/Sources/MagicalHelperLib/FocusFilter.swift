import Foundation
import HelperRPC

/// The macOS Focus filter Magical is under, and what it silences.
///
/// The filter is written by `MagicalAppIntents.appex` — the only bundle the AppIntents
/// runtime will enumerate — into `focus-filter.json`, which this reads. See
/// `docs/magical/focus-filters.md`.
///
/// It is an allow-list: a filter names the calendars that stay active, and everything else
/// it could have named is silenced. Naming nothing is not a filter that silences
/// everything; it is no filter at all, which is what macOS hands us when a Focus has none.
///
/// The controller lives in the helper rather than in Electron because the helper is where
/// the two surfaces it acts on already are: the banner is posted here, and the popover is
/// drawn here. Electron keeps its own copy for the Dock badge, forwarded from here.
@MainActor
public final class FocusFilterController: ObservableObject {
    public static let shared = FocusFilterController()

    /// Accounts the active filter keeps on. An account left off silences every calendar it
    /// has, whatever the calendar list says.
    @Published public private(set) var activeAccounts: Set<String> = []
    /// Calendars the active filter keeps on, each keyed `accountId|calendarId`.
    ///
    /// Both halves, because a Google calendar id does not identify a calendar on its own:
    /// Birthdays, Tasks and each locale's holidays carry the same id in every account.
    @Published public private(set) var activeCalendars: Set<String> = []
    /// Whether an account with nothing left on is greyed out and unselectable, rather than
    /// merely quiet.
    @Published public private(set) var preventAccess: Bool = false
    @Published public private(set) var isFilterActive: Bool = false

    private var transport: StdioTransport?

    /// Called after the filter changes, for the surfaces that are not SwiftUI and so do
    /// not redraw on their own.
    public var onFilterChanged: (() -> Void)?

    private static let notificationName = "com.alexhaslam.magical.focusFilterChanged"

    public init() {}

    public func setup(transport: StdioTransport) {
        self.transport = transport

        // The extension cannot call into this process, so it posts a distributed
        // notification after writing the file and this reads it back. Both halves matter:
        // the notification says *when*, and the file says *what*, and the file is also what
        // a helper started after the fact reads to catch up.
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name(Self.notificationName),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.load()
            }
        }

        load()
    }

    /// Re-reads `focus-filter.json`.
    ///
    /// A missing file is the ordinary case on a machine where no Focus has ever carried a
    /// Magical filter, and means no filter rather than an error.
    public func load() {
        // The App Intents extension writes into the App Group container, which
        // this helper is entitled for. The Application Support path is the
        // pre-group location, read once so an existing filter survives the
        // upgrade; a build with no group only has that fallback. A demo keeps
        // clear of the group for the same reason it keeps clear of the accounts.
        let candidate = isDemoMode
            ? demoFocusFilterURL()
            : (AppGroup.fileURL("focus-filter.json") ?? legacyFocusFilterURL())

        guard let candidate,
              let data = try? Data(contentsOf: candidate),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            apply(accounts: [], calendars: [], preventAccess: false)
            return
        }

        apply(
            accounts: json["activeAccounts"] as? [String] ?? [],
            calendars: json["activeCalendars"] as? [String] ?? [],
            preventAccess: json["preventAccess"] as? Bool ?? false
        )

        // A file written before an account was removed still names it. Prune at every read,
        // not only on an account update, so a Focus change does not bring the stale entry
        // back into force between two `tray.update`s.
        prune(to: Set(TrayModel.shared.accounts.map(\.id)))
    }

    /// Whether this helper was spawned by a demo run of the app.
    ///
    /// The main process sets the flag on the environment it hands the helper, so the two
    /// agree on the profile without a second copy of the argv parsing.
    private var isDemoMode: Bool {
        ProcessInfo.processInfo.environment["MAGIC_SUITE_DEMO"] == "1"
    }

    /// `focus-filter.json` in the demo profile, the one the demo's accounts live in.
    ///
    /// The App Group is shared whatever profile is in use, so a demo that read it would
    /// pick up the real install's filter. The path comes from `MAGICAL_USER_DATA_DIR`,
    /// which the main process sets to the resolved profile, so a `--user-data-dir` demo
    /// lands beside its accounts file.
    private func demoFocusFilterURL() -> URL? {
        if let dir = ProcessInfo.processInfo.environment["MAGICAL_USER_DATA_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: dir).appendingPathComponent("focus-filter.json")
        }
        guard let pw = getpwuid(getuid()) else { return nil }
        let home = String(cString: pw.pointee.pw_dir) as NSString
        return URL(fileURLWithPath: home.appendingPathComponent(
            "Library/Application Support/Magical-demo/focus-filter.json"
        ))
    }

    /// The pre-group location, read so an existing filter survives the upgrade.
    private func legacyFocusFilterURL() -> URL? {
        guard let pw = getpwuid(getuid()) else { return nil }
        let home = String(cString: pw.pointee.pw_dir) as NSString
        return URL(fileURLWithPath: home.appendingPathComponent(
            "Library/Application Support/Magical/focus-filter.json"
        ))
    }

    public func apply(accounts: [String], calendars: [String], preventAccess: Bool) {
        activeAccounts = Set(accounts)
        activeCalendars = Set(calendars)
        self.preventAccess = preventAccess
        // Both empty is no filter rather than silence everywhere. The picker starts with
        // everything on, so the only way to reach it is a filter written before the app
        // knew of any account.
        isFilterActive = !(accounts.isEmpty && calendars.isEmpty)

        HelperLog.info(
            "Focus",
            isFilterActive
                ? "Filter active: \(accounts.count) account(s) and \(calendars.count) calendar(s) stay on"
                : "No filter; everything stays on"
        )

        updateSettingsStatus()

        TrayModel.shared.focusFilterRevision &+= 1

        // Electron owns the Dock badge and the toolbar's account switcher, so it needs the
        // filter as well as the helper.
        transport?.sendEvent(method: "focusFilter.changed", params: [
            "activeAccounts": accounts,
            "activeCalendars": calendars,
            "preventAccess": preventAccess,
            "isFilterActive": isFilterActive,
        ])

        onFilterChanged?()
    }

    /// Drops filter entries naming accounts the app no longer has.
    ///
    /// The picker offers what `accounts.json` holds, so removing an account leaves its id
    /// in the stored Focus and in `focus-filter.json` pointing at nothing. A filter that
    /// named only that account would otherwise silence every account that remains, with
    /// nothing on screen to say why. Entries for live accounts are untouched, and the file
    /// itself is left to the extension that owns it: macOS rewrites it when the Focus next
    /// runs, by which time the picker can no longer offer the removed account.
    public func prune(to liveAccountIds: Set<String>) {
        // An empty list is "not known yet", not "everything was removed": pruning against
        // it would clear a live filter on an update that arrives before the accounts do.
        guard !liveAccountIds.isEmpty else { return }

        let accounts = activeAccounts.filter { liveAccountIds.contains($0) }
        let calendars = activeCalendars.filter { entry in
            guard let separator = entry.firstIndex(of: "|") else { return true }
            return liveAccountIds.contains(String(entry[entry.startIndex ..< separator]))
        }
        guard accounts != activeAccounts || calendars != activeCalendars else { return }

        HelperLog.info(
            "Focus",
            "Dropped filter entries for \(activeAccounts.count - accounts.count) removed account(s)"
        )
        apply(accounts: accounts.sorted(), calendars: calendars.sorted(), preventAccess: preventAccess)
    }

    /// Mirrors the wording Magimail's Settings window uses, so the two apps describe the
    /// same state the same way. The count is of accounts, not calendars: the picker asks
    /// which accounts are in scope and then narrows within them, and an account is the unit
    /// the access toggle acts on.
    private func updateSettingsStatus() {
        if !isFilterActive {
            SettingsModel.shared.focusFilterStatus = String(localized: "Inactive (All calendars active)")
        } else if preventAccess {
            SettingsModel.shared.focusFilterStatus =
                String(localized: "Active: \(activeAccounts.count) accounts visible (others hidden)")
        } else {
            SettingsModel.shared.focusFilterStatus =
                String(localized: "Active: \(activeAccounts.count) accounts active (others silenced)")
        }
    }

    /// Whether the active filter silences this calendar.
    ///
    /// A Focus only ever silences. It cannot un-silence a calendar the user muted in
    /// Settings, which is why nothing here consults that set: the two are combined by
    /// whoever asks, and each can only take a calendar away.
    public func isSilenced(calendarId: String, accountId: String) -> Bool {
        guard isFilterActive else { return false }
        guard activeAccounts.contains(accountId) else { return true }
        if isWhollyActive(accountId: accountId) {
            return false
        }
        return !aliases(calendarId: calendarId, accountId: accountId)
            .contains { activeCalendars.contains("\(accountId)|\($0)") }
    }

    /// Whether the filter has silenced everything this account has.
    ///
    /// The only state the switcher can act on: a segment is one account, so an account
    /// with even one calendar left on stays fully available.
    public func isAccountSilenced(_ accountId: String) -> Bool {
        guard isFilterActive else { return false }
        if !activeAccounts.contains(accountId) {
            return true
        }

        let owned = TrayModel.shared.availableCalendars.filter { $0.accountId == accountId }
        guard !owned.isEmpty else { return false }
        return owned.allSatisfy { isSilenced(calendarId: $0.id, accountId: accountId) }
    }

    /// Whether every calendar this account has is on.
    ///
    /// Such an account is treated as wholly on, so a calendar added to it later is audible
    /// rather than silenced. The filter is a list of calendar ids fixed when it was
    /// configured and a new calendar cannot be in it, and this is the case where the user
    /// plainly did not mean to hold anything back from that account. An account they have
    /// partly filtered is one they are curating, so a new calendar there stays quiet until
    /// they say otherwise.
    ///
    /// An account with no known calendars counts as wholly on. There is nothing to have
    /// ticked, so silence would be the app's decision rather than the user's.
    private func isWhollyActive(accountId: String) -> Bool {
        let owned = TrayModel.shared.availableCalendars.filter { $0.accountId == accountId }
        guard !owned.isEmpty else { return true }
        return owned.allSatisfy { activeCalendars.contains("\(accountId)|\($0.id)") }
    }

    /// Every id that names this calendar.
    ///
    /// Google reports an account's primary calendar under three names — `primary`, the
    /// account id, and the account's own email address — and which one arrives depends on
    /// the endpoint that returned the event. Left unreconciled, a filter naming the email
    /// silences the events that came back as `primary`.
    ///
    /// Only the primary expands. A secondary calendar's id is already unique within its
    /// account.
    private func aliases(calendarId: String, accountId: String) -> Set<String> {
        let email = TrayModel.shared.accounts.first { $0.id == accountId }?.email ?? ""
        let isPrimary = calendarId == "primary" || calendarId == accountId
            || (!email.isEmpty && calendarId == email)
        guard isPrimary else { return [calendarId] }

        var ids: Set<String> = [calendarId, "primary", accountId]
        if !email.isEmpty {
            ids.insert(email)
        }
        return ids
    }
}
