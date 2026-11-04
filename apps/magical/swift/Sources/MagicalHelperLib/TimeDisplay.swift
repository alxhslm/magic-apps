import Foundation

/// Times and dates the user reads, on every native surface.
///
/// The Mac's region and its 12/24-hour switch are separate settings: the switch writes
/// `AppleICUForce24HourTime` and leaves the region alone, so an `en_US` Mac can run on a
/// 24-hour clock. Foundation already folds the switch into `Locale.current`, so asking
/// the locale's own `j` template yields the hour cycle the user actually sees, and a
/// `timeStyle` formatter then honours it without us reading user defaults.
///
/// Fixed patterns such as `HH:mm` bypass all of that and pin one of the two clocks. They
/// belong to sort keys and log timestamps, never to something on screen.
enum TimeDisplay {
    /// Whether the clock is 24-hour, as Foundation resolves it for `locale`.
    static func uses24Hour(in locale: Locale) -> Bool {
        let pattern = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: locale) ?? ""
        return pattern.contains("H") || pattern.contains("k")
    }

    /// Time of day, following the Mac's clock style. Used for event times, the now
    /// indicator and the menu bar, so all three read the same.
    static func timeFormatter(locale: Locale = .current, timeZone: TimeZone = .current) -> DateFormatter {
        let df = DateFormatter()
        df.locale = locale
        df.timeZone = timeZone
        df.dateStyle = .none
        df.timeStyle = .short
        return df
    }

    /// The hour alone, for a day grid's gutter: `09` on a 24-hour clock, `9 AM` on a
    /// 12-hour one. A `timeStyle` formatter would add minutes the gutter has no room for.
    static func hourFormatter(locale: Locale = .current, timeZone: TimeZone = .current) -> DateFormatter {
        let df = DateFormatter()
        df.locale = locale
        df.timeZone = timeZone
        df.dateFormat = uses24Hour(in: locale) ? "HH" : "ha"
        return df
    }

    /// A date label from a field set rather than a literal pattern. Foundation picks the
    /// order and punctuation for the locale, which is why London reads `3 March 2026` and
    /// New York `March 3, 2026`. A literal pattern fixes both, which is right for a key
    /// and wrong for anything on screen.
    static func dateFormatter(
        template: String,
        locale: Locale = .current,
        timeZone: TimeZone = .current
    ) -> DateFormatter {
        let df = DateFormatter()
        df.locale = locale
        df.timeZone = timeZone
        df.setLocalizedDateFormatFromTemplate(template)
        return df
    }

    static let time = timeFormatter()
    static let hour = hourFormatter()
}
