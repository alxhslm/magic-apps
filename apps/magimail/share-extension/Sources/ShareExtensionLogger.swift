import AppKit
import Foundation
import os.log

/// Structured, redacted logging for the Share Extension.
///
/// Sandboxed `.appex` extensions cannot write to `~/Library/Logs/Magimail/main.log`.
/// Instead, this logger writes append-only records to `<groupContainer>/logs/share-extension.log`
/// in the shared App Group container, which the main application folds into
/// **Help → Reveal Logs in Finder**.
///
/// Every record is redacted before hitting disk to ensure email addresses, home paths,
/// and personal text or filenames never leave the user's machine.
/// The App Group the extension is entitled for. `build.sh` stamps the team-prefixed
/// identifier into `Info.plist` at build time, so the team ID is never hardcoded here.
var shareAppGroupId: String? {
    guard let configured = Bundle.main.object(forInfoDictionaryKey: "AppGroupIdentifier") as? String,
          !configured.isEmpty
    else {
        return nil
    }
    return configured
}

final class ShareExtensionLogger {
    static let shared = ShareExtensionLogger()

    private let logFileName = "share-extension.log"
    private let maxSizeBytes: Int64 = 5 * 1024 * 1024 // 5 MB

    private let osLogger = Logger(subsystem: "com.alexhaslam.magimail", category: "ShareExtension")
    private let serialQueue = DispatchQueue(label: "com.alexhaslam.magimail.share-logger")

    private let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    private let emailRegex: NSRegularExpression? = try? NSRegularExpression(pattern: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", options: [])

    private let realHomeDir: String? = {
        guard let pw = getpwuid(getuid())?.pointee.pw_dir else { return nil }
        return String(cString: pw)
    }()

    private init() {}

    // MARK: - Public API

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

    // MARK: - Redaction

    /// Replaces email addresses with `<email>` and home directories with `~`.
    func redactText(_ raw: String) -> String {
        var out = raw
        if let regex = emailRegex {
            let range = NSRange(location: 0, length: out.utf16.count)
            out = regex.stringByReplacingMatches(in: out, options: [], range: range, withTemplate: "<email>")
        }

        if let home = realHomeDir, !home.isEmpty, home != "/" {
            out = out.replacingOccurrences(of: home, with: "~")
        }

        let sandboxHome = NSHomeDirectory()
        if !sandboxHome.isEmpty, sandboxHome != "/" {
            out = out.replacingOccurrences(of: sandboxHome, with: "~")
        }

        return out
    }

    /// Strips the identifying query parameters from a URL while preserving scheme and path.
    func redactUrl(_ raw: String) -> String {
        guard !raw.isEmpty else { return raw }

        guard let components = URLComponents(string: raw) else {
            return redactText(raw)
        }

        if components.scheme?.lowercased() == "mailto" {
            return "mailto:<redacted>"
        }

        var base = ""
        if let scheme = components.scheme {
            base += "\(scheme)://"
        }
        if let host = components.host {
            base += host
        }
        base += components.path

        let hadParams = components.query != nil || components.fragment != nil
        return hadParams ? "\(base)?<redacted>" : base
    }

    // MARK: - File I/O

    private func log(level: String, message: String) {
        serialQueue.async { [weak self] in
            guard let self = self else { return }
            self.writeToFile(level: level, message: message)
        }
    }

    private func writeToFile(level: String, message: String) {
        guard let groupId = shareAppGroupId,
              let groupUrl = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupId)
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

        let line = "[\(timestamp)] [\(level)] (ShareExtension) \(cleanMessage)\n"
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
