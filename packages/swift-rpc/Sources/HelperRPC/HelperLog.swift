import Foundation
import os.log

/// Diagnostics from a helper process, routed to the app's log file.
///
/// Writes to **stderr**, never stdout. Stdout is the JSON-RPC pipe, and the
/// Electron side drops anything on it that does not parse as JSON — so a bare
/// `print()` here is not merely untidy, it is invisible.
///
/// Each line is `LEVEL|Category|message`, which the supervisor in
/// `packages/core/src/swift-helper.ts` splits to recover the level. Without it
/// a helper error arrives in the log as an info line that happens to read like
/// an error.
///
/// Also mirrors to Apple's Unified Logging (`os.Logger`) so helper diagnostics
/// stream in real-time in Console.app and `log stream`.
///
/// Redaction is the caller's job, as it is on the Electron side: the log is
/// written to be attached to a bug report. See `docs/shared/logging.md`.
public enum HelperLog {
    public static var subsystem = Bundle.main.bundleIdentifier ?? "com.alexhaslam.magimail"

    public static func info(_ category: String, _ message: String) {
        write("I", category, message)
        let logger = Logger(subsystem: subsystem, category: category)
        logger.info("\(message, privacy: .public)")
    }

    public static func warn(_ category: String, _ message: String) {
        write("W", category, message)
        let logger = Logger(subsystem: subsystem, category: category)
        logger.warning("\(message, privacy: .public)")
    }

    public static func error(_ category: String, _ message: String) {
        write("E", category, message)
        let logger = Logger(subsystem: subsystem, category: category)
        logger.error("\(message, privacy: .public)")
    }

    public static func formatRecord(_ level: String, _ category: String, _ message: String) -> String {
        // Newlines would be read as separate records and lose their level.
        let flattened = message
            .replacingOccurrences(of: "\r\n", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
        return "\(level)|\(category)|\(flattened)\n"
    }

    private static func write(_ level: String, _ category: String, _ message: String) {
        guard let data = formatRecord(level, category, message).data(using: .utf8) else { return }
        FileHandle.standardError.write(data)
    }
}
