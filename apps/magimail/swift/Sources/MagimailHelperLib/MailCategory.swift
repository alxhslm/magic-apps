import Foundation

/// The five Gmail category tabs, and the SF Symbol standing in for the glyph
/// Gmail draws on each one.
///
/// Twin of the enum in the widget extension's `WidgetCache.swift`. The two live
/// in separate bundles in separate processes with no shared module between
/// them, so the mapping is duplicated deliberately — they agree today, and are
/// free to diverge.
///
/// The symbols are Apple's nearest equivalents rather than traces of Gmail's
/// own: an inbox tray, two people, a price tag, an info circle and a pair of
/// speech bubbles. Drawing Gmail's glyphs instead would put a foreign icon set
/// in a native list, and would not follow the system's weight or appearance.
public enum MailCategory: String, CaseIterable {
    case primary
    case social
    case promotions
    case updates
    case forums

    /// Anything unrecognised reads as `primary`, which is also what the main
    /// process sends for a thread no poll has classified yet.
    public static func from(_ raw: String?) -> MailCategory {
        guard let raw, let value = MailCategory(rawValue: raw.lowercased()) else {
            return .primary
        }
        return value
    }

    public var symbolName: String {
        switch self {
        case .primary: "tray"
        case .social: "person.2"
        case .promotions: "tag"
        case .updates: "info.circle"
        case .forums: "bubble.left.and.bubble.right"
        }
    }

    public var title: String {
        switch self {
        case .primary: String(localized: "Primary")
        case .social: String(localized: "Social")
        case .promotions: String(localized: "Promotions")
        case .updates: String(localized: "Updates")
        case .forums: String(localized: "Forums")
        }
    }
}
