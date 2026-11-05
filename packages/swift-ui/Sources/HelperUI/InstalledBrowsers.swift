import AppKit

/// Which of the browsers the main process offers macOS actually has.
///
/// The list of browsers we can launch lives in `SUPPORTED_BROWSERS` and is the same on every
/// Mac; what differs is what is installed. Offering Brave and Edge to someone who has neither
/// is not merely clutter: picking one fails at launch and the link quietly opens somewhere
/// else, so the picker states which browsers it can actually act on.
///
/// Asked of LaunchServices rather than of a directory or Spotlight, because a browser counts
/// as installed when macOS can launch it, wherever the user put it.
public enum InstalledBrowsers {
    private static var cache: [String: Bool] = [:]
    private static let lock = NSLock()

    public static func isInstalled(bundleId: String) -> Bool {
        guard !bundleId.isEmpty else { return false }

        lock.lock()
        defer { lock.unlock() }

        if let known = cache[bundleId] {
            return known
        }

        let installed = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) != nil
        cache[bundleId] = installed
        return installed
    }

    /// The browsers to offer, keeping one that is no longer installed only where it is the
    /// current choice: a picker whose selected row has vanished shows nothing at all.
    public static func offered(
        _ browsers: [[String: Any]],
        keeping selection: String
    ) -> [[String: Any]] {
        browsers.filter { browser in
            let id = browser["id"] as? String ?? ""
            let bundleId = browser["bundleId"] as? String ?? ""
            return id == selection || isInstalled(bundleId: bundleId)
        }
    }
}
