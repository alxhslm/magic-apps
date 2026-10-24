import Foundation
import os.log

/// Structured, non-blocking logging for the WidgetKit extension.
///
/// Writes asynchronously to `<groupContainer>/logs/widgets-extension.log`
/// in the shared App Group container, and mirrors to `os.Logger`.
///
/// Async dispatch off the calling thread ensures timeline / snapshot providers
/// are never stalled or killed by WidgetKit's strict execution budget.
/// The App Group the extension is entitled for.
///
/// `build.sh` stamps the team-prefixed identifier into `Info.plist` at build
/// time, so the team ID is never hardcoded here. Nil on a build signed without a
/// team, where the entitlement is dropped and the group would be rejected
/// anyway; every widget then renders its placeholder.
var widgetAppGroupId: String? {
    guard let configured = Bundle.main.object(forInfoDictionaryKey: "AppGroupIdentifier") as? String,
          !configured.isEmpty
    else {
        return nil
    }
    return configured
}

final class WidgetsLogger {
    static let shared = WidgetsLogger()

    private var appGroupId: String? {
        widgetAppGroupId
    }

    private let logFileName = "widgets-extension.log"
    private let maxSizeBytes: Int64 = 5 * 1024 * 1024 // 5 MB

    private let osLogger = Logger(subsystem: "com.alexhaslam.magical", category: "Widgets")
    private let serialQueue = DispatchQueue(label: "com.alexhaslam.magical.widgets-logger", qos: .utility)

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
            guard let self else { return }
            writeToFile(level: level, message: message)
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

        let line = "[\(timestamp)] [\(level)] (Widgets) \(cleanMessage)\n"
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
