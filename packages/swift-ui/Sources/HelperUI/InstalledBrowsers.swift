import AppKit

/// Which of the browsers the main process offers macOS actually has.
///
/// Offering Brave or Edge to a Mac without it is worse than clutter: the launch fails and the
/// link opens somewhere else. Asked of LaunchServices, because a browser counts as installed when
/// macOS can launch it, wherever the user put it.
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
