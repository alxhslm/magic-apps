import AppIntents
import CoreGraphics
import Dispatch
import ExtensionFoundation
import Foundation
import ImageIO
import os.log
import UniformTypeIdentifiers

// MARK: - Account Dot

/// A filled circle in an account's own colour, as PNG data.
///
/// The picker takes an image per row and offers no tint, so the colour has to be drawn. It
/// is the same dot the toolbar switcher and the accounts menu use, and it is what makes two
/// accounts called Personal and Work tell themselves apart at a glance.
///
/// Drawn with Core Graphics rather than `NSImage`: this runs in a sandboxed extension whose
/// only job is to answer a picker, and AppKit is a large thing to load for one circle.
///
/// The canvas is wider than it is tall because the filter sheet draws these rows inline and
/// stretches the image to a frame about half again as wide as it is high. A square canvas
/// comes out an obvious ellipse; one already in the frame's aspect, with the circle centred
/// in it, comes out round. Magical's extension draws its dots the same way.
enum AccountDot {
    /// Measured from the inline rows in the Focus filter sheet.
    static let inlineRowAspect = 1.5

    static func png(hex: String, height: Int = 48, aspect: Double = inlineRowAspect) -> Data? {
        let (red, green, blue) = components(hex: hex)
        let width = Int((Double(height) * aspect).rounded())
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return nil
        }

        context.setFillColor(red: red, green: green, blue: blue, alpha: 1)
        // Inset, so the circle is not clipped by the bitmap's own edge once scaled, and
        // centred, so a canvas wider than it is tall leaves equal transparent margins.
        let inset = CGFloat(height) * 0.1
        let diameter = CGFloat(height) - inset * 2
        context.fillEllipse(in: CGRect(
            x: (CGFloat(width) - diameter) / 2,
            y: inset,
            width: diameter,
            height: diameter
        ))

        guard let image = context.makeImage() else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            out, UTType.png.identifier as CFString, 1, nil
        ) else {
            return nil
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return out as Data
    }

    /// `#rrggbb`, which is what `accounts.json` holds. An unparseable value falls back to
    /// the first colour `ACCOUNT_COLORS` hands out rather than to no dot, so one bad value
    /// cannot leave a single row looking like a different kind of thing.
    private static func components(hex: String) -> (CGFloat, CGFloat, CGFloat) {
        var value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("#") {
            value.removeFirst()
        }
        guard value.count == 6, let rgb = UInt32(value, radix: 16) else {
            return (0xA8 / 255, 0x55 / 255, 0xF7 / 255)
        }
        return (
            CGFloat((rgb >> 16) & 0xFF) / 255,
            CGFloat((rgb >> 8) & 0xFF) / 255,
            CGFloat(rgb & 0xFF) / 255
        )
    }
}

// MARK: - Account Entity

@available(macOS 14.0, *)
public struct MagimailAccountEntity: AppEntity {
    public static var defaultQuery = MagimailAccountQuery()
    public static var typeDisplayRepresentation: TypeDisplayRepresentation = "Magimail Account"

    public var id: String
    public var name: String
    /// `#rrggbb`, the colour this account is drawn in everywhere else in the app.
    public var colorHex: String

    public init(id: String, name: String, colorHex: String = "") {
        self.id = id
        self.name = name
        self.colorHex = colorHex
    }

    public var displayRepresentation: DisplayRepresentation {
        guard let dot = AccountDot.png(hex: colorHex) else {
            return DisplayRepresentation(title: "\(name)")
        }
        return DisplayRepresentation(
            title: "\(name)",
            // Not a template: a template image is a mask the system tints, which would
            // throw away the one thing the dot carries.
            image: DisplayRepresentation.Image(data: dot, isTemplate: false)
        )
    }
}

// MARK: - Paths

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

/// `focus-filter.json` for `perform()`: the group container when entitled,
/// Application Support otherwise, for a build whose signature carries no group.
private func focusFilterFile() -> URL? {
    if let groupURL = appGroupFile("focus-filter.json") {
        return groupURL
    }
    guard let pw = getpwuid(getuid()) else { return nil }
    let home = String(cString: pw.pointee.pw_dir) as NSString
    return URL(fileURLWithPath: home.appendingPathComponent(
        "Library/Application Support/Magimail/focus-filter.json"
    ))
}

// MARK: - Account Entity Query

@available(macOS 14.0, *)
public struct MagimailAccountQuery: EntityQuery, EnumerableEntityQuery {
    public init() {}

    func loadAccounts() -> [MagimailAccountEntity] {
        let logger = AppIntentsLogger.shared
        var urls: [URL] = []
        // The app writes accounts.json into the App Group container, which this
        // extension is entitled for. Application Support is a fallback for a
        // build with no group; the sandbox refuses it otherwise.
        if let groupURL = appGroupFile("accounts.json") {
            urls.append(groupURL)
        }
        if let pw = getpwuid(getuid()) {
            let home = String(cString: pw.pointee.pw_dir)
            urls.append(URL(fileURLWithPath: (home as NSString).appendingPathComponent("Library/Application Support/Magimail/accounts.json")))
        }

        for url in urls {
            guard let data = try? Data(contentsOf: url),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
            else {
                continue
            }

            let accounts = json.compactMap { dict -> MagimailAccountEntity? in
                guard let id = dict["id"] as? String,
                      let name = dict["name"] as? String else { return nil }
                return MagimailAccountEntity(
                    id: id,
                    name: name,
                    colorHex: (dict["color"] as? String) ?? ""
                )
            }
            if !accounts.isEmpty {
                logger.info("loadAccounts: loaded \(accounts.count) account(s)")
                return accounts
            }
        }

        logger.info("loadAccounts: accounts.json not found, falling back to default Personal account")
        return [
            // The colour `DEFAULT_ACCOUNTS` gives this account, so the fallback row looks
            // like the real one rather than like a different kind of thing.
            MagimailAccountEntity(id: "account_personal", name: "Personal", colorHex: "#a855f7"),
        ]
    }

    public func entities(for identifiers: [String]) async throws -> [MagimailAccountEntity] {
        let all = loadAccounts()
        return all.filter { identifiers.contains($0.id) }
    }

    public func allEntities() async throws -> [MagimailAccountEntity] {
        loadAccounts()
    }

    public func suggestedEntities() async throws -> [MagimailAccountEntity] {
        loadAccounts()
    }
}

// MARK: - Focus Filter Intent

@available(macOS 14.0, *)
public struct MagimailFocusFilter: SetFocusFilterIntent {
    public static var title: LocalizedStringResource = "Filter Accounts"
    public static var description: LocalizedStringResource? =
        "Choose which accounts stay active during this Focus. The rest are silenced and left out of the menu bar, widgets and unread count."

    @Parameter(title: "Accounts", description: "Turning an account off silences it.")
    public var accounts: [MagimailAccountEntity]

    @Parameter(title: "Prevent Access to Silenced Accounts", description: "Gray out silenced accounts so they cannot be opened.", default: false)
    public var disableExcludedAccounts: Bool

    public var displayRepresentation: DisplayRepresentation {
        let title: LocalizedStringResource = if accounts.isEmpty {
            "All Accounts"
        } else {
            "\(accounts.map(\.name).joined(separator: ", "))"
        }
        let subtitle: LocalizedStringResource = disableExcludedAccounts
            ? "Others silenced and blocked"
            : "Others silenced"
        return DisplayRepresentation(title: title, subtitle: subtitle)
    }

    /// No notification predicate.
    ///
    /// macOS can drop a banner itself, from a `filterCriteria` matched against a predicate fixed
    /// when the filter was configured. It would never do so: `MagimailHelper` is the only thing
    /// that posts a Magimail banner, and it checks the filter first, so the predicate could only
    /// agree or be out of date. Keeping it would mean a second snapshot of the account list, and an
    /// account created since would be missing from it.
    public var appContext: FocusFilterAppContext {
        FocusFilterAppContext()
    }

    /// Starts with every account on, as Magical's filter does.
    ///
    /// It also decides whether the picker draws the account's colour: a parameter with
    /// values has those entities resolved and asked for a `displayRepresentation`, and one
    /// left empty is drawn as a bare list of options that is never asked. Storing nothing
    /// still means no filter — the sheet only records what the user actually sets.
    public init() {
        accounts = MagimailAccountQuery().loadAccounts()
        disableExcludedAccounts = false
    }

    public static func suggestedFocusFilters(for _: FocusFilterSuggestionContext) async -> [MagimailFocusFilter] {
        [MagimailFocusFilter()]
    }

    public func perform() async throws -> some IntentResult {
        let logger = AppIntentsLogger.shared
        let accountIds = accounts.map(\.id)
        logger.info("perform: setting Focus Filter with \(accountIds.count) active account(s), disableExcluded: \(disableExcludedAccounts)")

        let payload: [String: Any] = [
            "activeAccountIds": accountIds,
            "disableExcludedAccounts": disableExcludedAccounts,
            "isFilterActive": !accountIds.isEmpty,
            "timestamp": Date().timeIntervalSince1970,
        ]

        guard let target = focusFilterFile() else {
            logger.error("getpwuid failed when resolving home directory")
            throw MagimailFocusFilterError.stateWriteFailed
        }

        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: .prettyPrinted)
            try data.write(to: target, options: .atomic)
            logger.info("Successfully wrote focus-filter.json")
        } catch {
            logger.error("Failed to write focus-filter.json: \(error.localizedDescription)")
            throw error
        }

        DistributedNotificationCenter.default().postNotificationName(
            NSNotification.Name("com.alexhaslam.magimail.focusFilterChanged"),
            object: nil,
            userInfo: nil,
            deliverImmediately: true
        )
        logger.info("Posted com.alexhaslam.magimail.focusFilterChanged notification")

        return .result()
    }
}

// MARK: - Errors

@available(macOS 14.0, *)
enum MagimailFocusFilterError: Error, CustomLocalizedStringResourceConvertible {
    case stateWriteFailed

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .stateWriteFailed:
            "Magimail could not save the Focus Filter state. Check that Magimail is installed in /Applications."
        }
    }
}

// MARK: - Extension Entry Point

@available(macOS 14.0, *)
@main
struct MagimailAppIntentsExtension: AppIntentsExtension {}

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

final class AppIntentsLogger {
    static let shared = AppIntentsLogger()

    private var appGroupId: String? {
        appIntentsAppGroupId
    }

    private let logFileName = "app-intents-extension.log"
    private let maxSizeBytes: Int64 = 5 * 1024 * 1024 // 5 MB

    private let osLogger = Logger(subsystem: "com.alexhaslam.magimail", category: "AppIntents")
    private let serialQueue = DispatchQueue(label: "com.alexhaslam.magimail.app-intents-logger", qos: .utility)

    private let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    private let realHomeDir: String? = {
        guard let pw = getpwuid(getuid())?.pointee.pw_dir else { return nil }
        return String(cString: pw)
    }()

    private init() {}

    func info(_ message: String) {
        log(level: "info", message: message)
        osLogger.info("\(message, privacy: .public)")
    }

    func warn(_ message: String) {
        log(level: "warn", message: message)
        osLogger.warning("\(message, privacy: .public)")
    }

    func error(_ message: String) {
        log(level: "error", message: message)
        osLogger.error("\(message, privacy: .public)")
    }

    func redactText(_ raw: String) -> String {
        var out = raw
        if let home = realHomeDir, !home.isEmpty, home != "/" {
            out = out.replacingOccurrences(of: home, with: "~")
        }
        let sandboxHome = NSHomeDirectory()
        if !sandboxHome.isEmpty, sandboxHome != "/" {
            out = out.replacingOccurrences(of: sandboxHome, with: "~")
        }
        return out
    }

    private func log(level: String, message: String) {
        serialQueue.async { [weak self] in
            guard let self = self else { return }
            self.writeToFile(level: level, message: message)
        }
    }

    private func writeToFile(level: String, message: String) {
        guard let group = appGroupId,
              let groupUrl = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
        else {
            return
        }

        let logsDir = groupUrl.appendingPathComponent("logs", isDirectory: true)
        let logUrl = logsDir.appendingPathComponent(logFileName)

        let fileManager = FileManager.default
        if !fileManager.fileExists(atPath: logsDir.path) {
            try? fileManager.createDirectory(at: logsDir, withIntermediateDirectories: true)
        }

        rotateIfNeeded(logUrl: logUrl)

        let timestamp = dateFormatter.string(from: Date())
        let cleanMessage = redactText(message)
            .replacingOccurrences(of: "\r\n", with: " ")
            .replacingOccurrences(of: "\n", with: " ")

        let line = "[\(timestamp)] [\(level)] (AppIntents) \(cleanMessage)\n"
        guard let data = line.data(using: .utf8) else { return }

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
