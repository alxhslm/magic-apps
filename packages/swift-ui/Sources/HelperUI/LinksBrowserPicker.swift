import SwiftUI

/// Which browser leaves the app for the wider web.
///
/// Shared because both apps ask the same question and because "which row is the Mac's
/// default" has to be answered the same way wherever it is shown. The list arrives from the
/// main process, so `SUPPORTED_BROWSERS` in `@magimail/core` stays the only place that knows
/// which browsers we can launch ourselves.
///
/// The row macOS opens links with carries `(default)` rather than there being a separate
/// "System Default" entry: both resolve to the same browser, and a picker that lists one
/// browser twice asks the user to choose between two names for one thing.
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

            ForEach(browsers.indices, id: \.self) { index in
                let browser = browsers[index]
                Text(label(for: browser)).tag(browser["id"] as? String ?? "")
            }
        }
    }

    /// `system` displays as the browser it stands for today.
    ///
    /// An account or an install that never chose keeps the value, so it follows the Mac
    /// when the Mac's default changes; only picking a row pins a browser. The picker has no
    /// row for `system` when that browser is one it lists, so displaying it unchanged would
    /// leave the control blank.
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
