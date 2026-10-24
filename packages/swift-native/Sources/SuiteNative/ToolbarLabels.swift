import Foundation

// MARK: - Toolbar labels

/// The names the shared toolbar code looks up in either app's label set.
///
/// Only the names live here; the text is the app's, authored in its
/// `ui-strings.json` and pushed across the bridge. See
/// `docs/shared/native-ui.md#localised-labels`.
public enum ToolbarLabelKey {
    public static let search = "toolbar.search"
    public static let signInRequired = "toolbar.signInRequired"
    public static let accountUnknown = "toolbar.account.unknown"
    public static let accountNoUnread = "toolbar.account.noUnread"
    public static let accountOneUnread = "toolbar.account.oneUnread"
    public static let accountUnread = "toolbar.account.unread"
    public static let accountSignInRequired = "toolbar.account.signInRequired"
}

/// The toolbar's user-visible strings, pushed from the app's UI catalogue.
///
/// The addon is a dylib loaded into Electron, not a bundle of its own, so there
/// is nowhere for a String Catalog to live and nothing for Foundation to
/// localise from. The app already authors and validates these strings, so it
/// sends the resolved text over the same JSON bridge that carries the accounts
/// and invitations, and the toolbar only renders it.
public struct ToolbarLabels {
    private let values: [String: String]

    public init(_ values: [String: String] = [:]) {
        self.values = values
    }

    /// The text for a catalogue key, or an empty string when the app did not send
    /// one. A missing label is a programming error in the app, not a reason to
    /// show an English fallback the app did not choose.
    public subscript(key: String) -> String {
        values[key] ?? ""
    }

    /// Fills a template's `{name}` placeholders. The app sends a catalogue
    /// template with the placeholders intact when the value is only known on the
    /// native side, such as an invitation count.
    public func format(_ key: String, _ params: [String: String]) -> String {
        var text = self[key]
        for (name, value) in params {
            text = text.replacingOccurrences(of: "{\(name)}", with: value)
        }
        return text
    }
}
