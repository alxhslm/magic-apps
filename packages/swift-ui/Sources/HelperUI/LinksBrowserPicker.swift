import SwiftUI

/// Which browser leaves the app for the wider web.
///
/// Shared by both apps so "which row is the Mac's default" is answered the same way. The list
/// arrives from the main process, keeping `SUPPORTED_BROWSERS` the only place that knows what we
/// can launch.
///
/// The Mac's browser carries `(default)` instead of a separate "System Default": both resolve to
/// the same browser, and listing it twice would ask the user to choose between two names.
public struct LinksBrowserPicker: View {
    @Binding private var selection: String
    private let browsers: [[String: Any]]
    private let defaultBrowser: [String: Any]

    public init(
        selection: Binding<String>,
        browsers: [[String: Any]],
        defaultBrowser: [String: Any]
    ) {
        _selection = selection
        self.browsers = browsers
        self.defaultBrowser = defaultBrowser
    }

    public var body: some View {
        Picker("Open links in:", selection: resolved) {
            if let name = unlistedDefaultName {
                Text("\(name) (default)").tag("system")
            }

            let offered = InstalledBrowsers.offered(browsers, keeping: selection)
            ForEach(offered.indices, id: \.self) { index in
                let browser = offered[index]
                Text(label(for: browser)).tag(browser["id"] as? String ?? "")
            }
        }
    }

    /// `system` displays as the browser it stands for today.
    ///
    /// An untouched value stays `system`, so it follows the Mac when the default changes; only
    /// picking a row pins a browser. Without this the control would be blank, because the picker
    /// has no `system` row when that browser is listed.
    private var resolved: Binding<String> {
        Binding(
            get: {
                guard selection == "system", unlistedDefaultName == nil else { return selection }
                return defaultBrowserId
            },
            set: { selection = $0 }
        )
    }

    private var defaultBrowserId: String {
        defaultBrowser["id"] as? String ?? "system"
    }

    /// The Mac's default browser when the app cannot launch it, which is the only case
    /// that needs a row of its own.
    private var unlistedDefaultName: String? {
        guard defaultBrowserId == "other",
              let name = defaultBrowser["name"] as? String,
              !name.isEmpty
        else { return nil }
        return name
    }

    /// Marks the row the Mac opens links with, so the inherited value is identifiable.
    private func label(for browser: [String: Any]) -> String {
        let name = browser["name"] as? String ?? browser["id"] as? String ?? ""
        return browser["id"] as? String == defaultBrowserId ? "\(name) (default)" : name
    }
}
