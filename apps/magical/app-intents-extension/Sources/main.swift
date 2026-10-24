import AppIntents
import Dispatch
import ExtensionFoundation
import Foundation
import os.log

// MARK: - Paths

/// The real home directory, not the sandbox container.
///
/// This extension is sandboxed, so `NSHomeDirectory()` points inside its own container.
/// `getpwuid` reports the account's actual home, where the pre-group fallback
/// files live. The group container is the ordinary path.
private func realHomeDirectory() -> NSString? {
    guard let pw = getpwuid(getuid()) else { return nil }
    return String(cString: pw.pointee.pw_dir) as NSString
}

private func applicationSupportFile(_ name: String) -> URL? {
    guard let home = realHomeDirectory() else { return nil }
    return URL(fileURLWithPath: home.appendingPathComponent("Library/Application Support/Magical/\(name)"))
}

/// A file in the App Group container, or nil when this build has no group.
///
/// The group identifier is stamped into `Info.plist` by `build.sh`, so the team
/// prefix stays out of source. `accounts.json` and `focus-filter.json` live in
/// the container, which both the app and this extension are entitled for.
private func appGroupFile(_ name: String) -> URL? {
    guard let group = appIntentsAppGroupId,
          let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else {
        return nil
    }
    return container.appendingPathComponent(name)
}

/// `accounts.json`: the group when entitled, Application Support otherwise.
private func accountsFile() -> URL? {
    appGroupFile("accounts.json") ?? applicationSupportFile("accounts.json")
}

/// `focus-filter.json`: the group when entitled, Application Support otherwise.
private func focusFilterFile() -> URL? {
    appGroupFile("focus-filter.json") ?? applicationSupportFile("focus-filter.json")
}

// MARK: - Accounts File

/// What `accounts.json` says, which is the only thing this extension knows about Magical.
///
/// The app writes it; the extension reads it and never writes back. Read afresh on every
/// call rather than cached: the picker is opened rarely, and an extension process outlives
/// several account changes.
enum AccountsFile {
    struct Calendar {
        let id: String
        let name: String
        let color: String
    }

    struct Account {
        let id: String
        let name: String
        let email: String
        let color: String
        let calendars: [Calendar]
    }

    static func load() -> [Account] {
        guard let url = accountsFile(),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        else {
            AppIntentsLogger.shared.info("accounts.json unreadable; offering nothing to filter")
            return []
        }

        return json.compactMap { raw in
            guard let id = raw["id"] as? String else { return nil }
            let color = (raw["color"] as? String) ?? ""
            let calendars = ((raw["calendars"] as? [[String: Any]]) ?? []).compactMap { entry -> Calendar? in
                guard let calendarId = entry["id"] as? String else { return nil }
                return Calendar(
                    id: calendarId,
                    name: (entry["name"] as? String) ?? calendarId,
                    color: (entry["color"] as? String) ?? color
                )
            }
            return Account(
                id: id,
                name: (raw["name"] as? String) ?? id,
                email: (raw["email"] as? String) ?? "",
                color: color,
                calendars: calendars
            )
        }
    }
}

// MARK: - Calendar Entity

/// One account in the Focus filter's picker.
///
/// Separate from the calendars, and asked first, because the two questions are different:
/// which accounts you are working in, and then which of their calendars matter. An account
/// left off is wholly silenced, and is the only thing the access toggle can grey out — a
/// window tab cannot be half-disabled.
@available(macOS 14.0, *)
public struct MagicalAccountEntity: AppEntity {
    public static var defaultQuery = MagicalAccountQuery()
    public static var typeDisplayRepresentation: TypeDisplayRepresentation = "Magical Account"

    public var id: String
    public var name: String
    public var detail: String
    public var colorHex: String

    public init(id: String, name: String, detail: String, colorHex: String) {
        self.id = id
        self.name = name
        self.detail = detail
        self.colorHex = colorHex
    }

    /// Accounts are drawn inline in the filter sheet, which stretches the image, so the dot
    /// is drawn on a canvas already in that frame's aspect.
    public var displayRepresentation: DisplayRepresentation {
        guard let dot = CalendarDot.png(hex: colorHex, aspect: CalendarDot.inlineRowAspect) else {
            return DisplayRepresentation(title: "\(name)", subtitle: "\(detail)")
        }
        return DisplayRepresentation(
            title: "\(name)",
            subtitle: "\(detail)",
            image: DisplayRepresentation.Image(data: dot, isTemplate: false)
        )
    }
}

// MARK: - Account Entity Query

@available(macOS 14.0, *)
public struct MagicalAccountQuery: EntityQuery, EnumerableEntityQuery {
    public init() {}

    func loadEntities() -> [MagicalAccountEntity] {
        AccountsFile.load().map { account in
            MagicalAccountEntity(
                id: account.id,
                name: account.name,
                detail: account.email.isEmpty ? String(localized: "Account") : account.email,
                colorHex: account.color
            )
        }
    }

    public func entities(for identifiers: [String]) async throws -> [MagicalAccountEntity] {
        loadEntities().filter { identifiers.contains($0.id) }
    }

    public func allEntities() async throws -> [MagicalAccountEntity] {
        loadEntities()
    }

    public func suggestedEntities() async throws -> [MagicalAccountEntity] {
        loadEntities()
    }
}

// MARK: - Calendar Entity

/// One calendar in the Focus filter's picker.
///
/// Identified by its account *and* its calendar id, joined by a `|`. A Google calendar id
/// does not identify a calendar on its own: Birthdays, Tasks and each locale's holidays
/// carry the same id in every account, so two accounts produce two rows that would
/// otherwise share an entity id and stop being two rows. `|` cannot appear in either half.
@available(macOS 14.0, *)
public struct MagicalCalendarEntity: AppEntity {
    public static var defaultQuery = MagicalCalendarQuery()
    public static var typeDisplayRepresentation: TypeDisplayRepresentation = "Magical Calendar"

    public var id: String
    public var name: String
    public var detail: String
    /// `#rrggbb`, the colour Google Calendar draws this calendar in. An account row takes
    /// the account's own dot colour, which is the one the switcher and the popover use.
    public var colorHex: String

    public init(id: String, name: String, detail: String, colorHex: String) {
        self.id = id
        self.name = name
        self.detail = detail
        self.colorHex = colorHex
    }

    public var displayRepresentation: DisplayRepresentation {
        guard let dot = CalendarDot.png(hex: colorHex) else {
            return DisplayRepresentation(title: "\(name)", subtitle: "\(detail)")
        }
        return DisplayRepresentation(
            title: "\(name)",
            subtitle: "\(detail)",
            image: DisplayRepresentation.Image(data: dot)
        )
    }
}

// MARK: - Calendar Entity Query

@available(macOS 14.0, *)
public struct MagicalCalendarQuery: EntityQuery, EnumerableEntityQuery {
    public init() {}

    /// Reads `accounts.json`, the same file the app persists its accounts and their
    /// discovered calendars to.
    ///
    /// Calendars only, one row each, grouped by account in the order the accounts appear.
    /// With more than one account every row carries the account's name, because the system
    /// renders this as one flat list: no sections, no headings, and nothing of ours in it.
    /// Two accounts commonly both have a Birthdays, a Tasks and a UK Holidays, so an
    /// unprefixed list offers the same name twice with no way to tell which is which. A
    /// single account needs no prefix and reads worse with one.
    ///
    /// Every account's calendars are offered, including accounts the filter has switched
    /// off; docs/magical/focus-filters.md#picker-behaviour-when-a-calendar-is-added says why
    /// the obvious fix for that is worse.
    func loadEntities() -> [MagicalCalendarEntity] {
        let accounts = AccountsFile.load()
        let prefixed = accounts.count > 1
        return accounts.flatMap { account in
            account.calendars.map { calendar in
                MagicalCalendarEntity(
                    id: "\(account.id)|\(calendar.id)",
                    name: prefixed ? "\(account.name) · \(calendar.name)" : calendar.name,
                    detail: account.email.isEmpty ? account.name : account.email,
                    colorHex: calendar.color
                )
            }
        }
    }

    public func entities(for identifiers: [String]) async throws -> [MagicalCalendarEntity] {
        loadEntities().filter { identifiers.contains($0.id) }
    }

    public func allEntities() async throws -> [MagicalCalendarEntity] {
        loadEntities()
    }

    public func suggestedEntities() async throws -> [MagicalCalendarEntity] {
        loadEntities()
    }
}

// MARK: - Focus Filter Intent

@available(macOS 14.0, *)
public struct MagicalFocusFilter: SetFocusFilterIntent {
    public static var title: LocalizedStringResource = "Filter Calendars"
    public static var description: LocalizedStringResource? =
        "Choose which accounts and calendars stay active during this Focus. The rest are silenced and left out of the menu bar and the popover."

    @Parameter(
        title: "Accounts",
        description: "Turning an account off silences every calendar it has."
    )
    public var accounts: [MagicalAccountEntity]

    @Parameter(
        title: "Calendars",
        description: "Pick which individual calendars remain active for unsilenced accounts."
    )
    public var calendars: [MagicalCalendarEntity]

    @Parameter(
        title: "Prevent Access to Silenced Accounts",
        description: "Gray out silenced accounts so they cannot be opened.",
        default: false
    )
    public var preventAccess: Bool

    public var displayRepresentation: DisplayRepresentation {
        let title: LocalizedStringResource = if accounts.isEmpty {
            "No Accounts"
        } else {
            "\(accounts.map(\.name).joined(separator: ", "))"
        }
        let subtitle: LocalizedStringResource = preventAccess
            ? "Others silenced and blocked"
            : "Others silenced"
        return DisplayRepresentation(title: title, subtitle: subtitle)
    }

    /// No notification predicate.
    ///
    /// macOS can drop a banner itself, from a `filterCriteria` matched against a predicate
    /// fixed when the filter was configured. It would never do so: `MagicalHelper` is the
    /// only thing that posts a Magical banner, and it checks the filter first, so the
    /// predicate can only ever agree or be out of date. Keeping it would mean a second
    /// snapshot of the calendar list, and a calendar created since would be missing from it.
    public var appContext: FocusFilterAppContext {
        FocusFilterAppContext()
    }

    /// Starts with everything on, so configuring a Focus means turning off what should go
    /// quiet rather than turning on the fifteen things that should not.
    ///
    /// Both lists empty is read downstream as no filter rather than as silence everywhere.
    /// That is also the safe reading of the one way it can happen by accident: if
    /// `accounts.json` cannot be read here, the defaults come out empty, and a filter that
    /// silenced the lot would be the app's mistake rather than the user's instruction.
    public init() {
        accounts = MagicalAccountQuery().loadEntities()
        calendars = MagicalCalendarQuery().loadEntities()
        preventAccess = false
    }

    public static func suggestedFocusFilters(for _: FocusFilterSuggestionContext) async -> [MagicalFocusFilter] {
        [MagicalFocusFilter()]
    }

    public func perform() async throws -> some IntentResult {
        let logger = AppIntentsLogger.shared
        let activeAccounts = accounts.map(\.id)
        let activeCalendars = calendars.map(\.id)

        logger.info(
            "perform: \(activeAccounts.count) account(s) and \(activeCalendars.count) calendar(s) on, preventAccess: \(preventAccess)"
        )

        let payload: [String: Any] = [
            "activeAccounts": activeAccounts,
            "activeCalendars": activeCalendars,
            "preventAccess": preventAccess,
            "isFilterActive": !(activeAccounts.isEmpty && activeCalendars.isEmpty),
            "timestamp": Date().timeIntervalSince1970,
        ]

        guard let target = focusFilterFile() else {
            logger.error("getpwuid failed when resolving the home directory")
            throw MagicalFocusFilterError.stateWriteFailed
        }

        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: .prettyPrinted)
            try data.write(to: target, options: .atomic)
            logger.info("Wrote focus-filter.json")
        } catch {
            logger.error("Failed to write focus-filter.json: \(error.localizedDescription)")
            throw MagicalFocusFilterError.stateWriteFailed
        }

        DistributedNotificationCenter.default().postNotificationName(
            NSNotification.Name("com.alexhaslam.magical.focusFilterChanged"),
            object: nil,
            userInfo: nil,
            deliverImmediately: true
        )
        logger.info("Posted com.alexhaslam.magical.focusFilterChanged")

        return .result()
    }
}

// MARK: - Errors

@available(macOS 14.0, *)
enum MagicalFocusFilterError: Error, CustomLocalizedStringResourceConvertible {
    case stateWriteFailed

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .stateWriteFailed:
            "Magical could not save the Focus filter. Check that Magical is installed in /Applications."
        }
    }
}

// MARK: - Extension Entry Point

@available(macOS 14.0, *)
@main
struct MagicalAppIntentsExtension: AppIntentsExtension {}

// MARK: - Logger

/// The App Group the extension is entitled for.
///
/// `build.sh` stamps the team-prefixed identifier into `Info.plist` at build
/// time, so the team ID is never hardcoded here. Nil on a build signed without a
/// team, where the entitlement is dropped and the group would be rejected
/// anyway; the extension then logs only to `os.Logger`.
var appIntentsAppGroupId: String? {
    guard let configured = Bundle.main.object(forInfoDictionaryKey: "AppGroupIdentifier") as? String,
          !configured.isEmpty
    else {
        return nil
    }
    return configured
}

/// Writes into the App Group container, which the app folds into `~/Library/Logs/Magical/`
/// on startup and whenever the logs are revealed.
///
/// The group is narrower than the alternative: writing straight to `~/Library/Logs/Magical/`
/// needs a read-write temporary exception over that whole directory, and the container is
/// reach this extension already has.
final class AppIntentsLogger {
    static let shared = AppIntentsLogger()

    private let logFileName = "app-intents-extension.log"
    private let maxSizeBytes: Int64 = 5 * 1024 * 1024

    private let osLogger = Logger(subsystem: "com.alexhaslam.magical", category: "AppIntents")
    private let serialQueue = DispatchQueue(label: "com.alexhaslam.magical.app-intents-logger", qos: .utility)

    private let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    private init() {}

    func info(_ message: String) {
        osLogger.info("\(message, privacy: .public)")
        write(level: "info", message: message)
    }

    func error(_ message: String) {
        osLogger.error("\(message, privacy: .public)")
        write(level: "error", message: message)
    }

    /// Replaces the home directory with `~`, as the suite's other loggers do.
    private func redact(_ raw: String) -> String {
        var out = raw
        if let home = realHomeDirectory() as String?, !home.isEmpty, home != "/" {
            out = out.replacingOccurrences(of: home, with: "~")
        }
        let sandboxHome = NSHomeDirectory()
        if !sandboxHome.isEmpty, sandboxHome != "/" {
            out = out.replacingOccurrences(of: sandboxHome, with: "~")
        }
        return out
    }

    private func write(level: String, message: String) {
        serialQueue.async { [weak self] in
            guard let self,
                  let group = appIntentsAppGroupId,
                  let groupUrl = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
            else { return }
            let logsDir = groupUrl.appendingPathComponent("logs", isDirectory: true)
            let logUrl = logsDir.appendingPathComponent(self.logFileName)

            let fileManager = FileManager.default
            if !fileManager.fileExists(atPath: logsDir.path) {
                try? fileManager.createDirectory(at: logsDir, withIntermediateDirectories: true)
            }
            self.rotateIfNeeded(logUrl: logUrl)

            let timestamp = self.dateFormatter.string(from: Date())
            let clean = self.redact(message)
                .replacingOccurrences(of: "\r\n", with: " ")
                .replacingOccurrences(of: "\n", with: " ")
            guard let data = "[\(timestamp)] [\(level)] (AppIntents) \(clean)\n".data(using: .utf8) else { return }

            if !fileManager.fileExists(atPath: logUrl.path) {
                fileManager.createFile(atPath: logUrl.path, contents: data)
                return
            }
            if let handle = try? FileHandle(forWritingTo: logUrl) {
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
                try? handle.close()
            }
        }
    }

    private func rotateIfNeeded(logUrl: URL) {
        let fileManager = FileManager.default
        guard let attrs = try? fileManager.attributesOfItem(atPath: logUrl.path),
              let size = attrs[.size] as? Int64,
              size > maxSizeBytes
        else {
            return
        }
        let oldUrl = logUrl.deletingPathExtension().appendingPathExtension("old.log")
        try? fileManager.removeItem(at: oldUrl)
        try? fileManager.moveItem(at: logUrl, to: oldUrl)
    }
}
