import Foundation

/// How long until a meeting starts, in the two registers the tray needs.
///
/// Both renderings split the same minute count the same way, so the menu bar and the hero
/// card can never disagree about whether something is an hour and twenty minutes or eighty
/// minutes. They differ only in phrasing: the status item has a few characters of menu bar
/// to work with, the card has a line of its own.
public enum TrayCountdown {
    /// `Now`, `12m`, `1h`, `1h 20m` — the status item's title.
    public static func compact(minutes: Int) -> String {
        guard minutes > 0 else { return String(localized: "Now") }
        let (hours, mins) = split(minutes)
        if hours == 0 {
            return String(localized: "\(mins)m")
        }
        return mins == 0
            ? String(localized: "\(hours)h")
            : String(localized: "\(hours)h \(mins)m")
    }

    /// `NOW`, `IN 1 MIN`, `IN 12 MINS`, `IN 1 HR 20 MINS` — the hero card's label.
    public static func label(minutes: Int) -> String {
        guard minutes > 0 else { return String(localized: "NOW") }
        let (hours, mins) = split(minutes)
        if hours == 0 {
            return mins == 1
                ? String(localized: "IN \(mins) MIN")
                : String(localized: "IN \(mins) MINS")
        }
        if mins == 0 {
            return hours == 1
                ? String(localized: "IN 1 HR")
                : String(localized: "IN \(hours) HRS")
        }
        if mins == 1 {
            return hours == 1
                ? String(localized: "IN 1 HR 1 MIN")
                : String(localized: "IN \(hours) HRS 1 MIN")
        }
        return hours == 1
            ? String(localized: "IN 1 HR \(mins) MINS")
            : String(localized: "IN \(hours) HRS \(mins) MINS")
    }

    private static func split(_ minutes: Int) -> (hours: Int, mins: Int) {
        (minutes / 60, minutes % 60)
    }
}
