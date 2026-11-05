import Foundation

/// Times and dates the user reads, on every native surface.
///
/// The Mac's region and its 12/24-hour switch are separate settings: the switch writes
/// `AppleICUForce24HourTime` and leaves the region alone, so an `en_US` Mac can run on a
/// 24-hour clock. Foundation resolves that key into `Locale.current` once, at launch, and
/// never refreshes it; a process started on a 24-hour Mac keeps a 24-hour locale after the
/// switch is turned off. So the key is read here instead, and the formatters are rebuilt
/// when it changes.
///
/// The value decides rather than its presence: `1` is 24-hour, `0` is 12-hour, and no key
/// means the region. A presence test pins the clock to 24-hour after the switch is turned
/// off on a Mac that leaves a `0` behind, which is the bug this replaced.
///
/// Fixed patterns such as `HH:mm` bypass all of this and pin one of the two clocks. They
/// belong to sort keys and log timestamps, never to something on screen.
enum TimeDisplay {
    private static let force24HourKey = "AppleICUForce24HourTime"

    /// Reads the switch's stored value. `nil` means never set, or a shape this build does
    /// not know, and the locale's own cycle applies.
    static func forced24Hour(from value: Any?) -> Bool? {
        guard let value else { return nil }
        if let number = value as? NSNumber {
            return number.boolValue
        }
        if let text = value as? String {
            switch text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "1", "true", "yes": return true
            case "0", "false", "no": return false
            default: return nil
            }
        }
        return nil
    }

    /// The Mac's switch, read live.
    static var forced24Hour: Bool? {
        forced24Hour(from: UserDefaults.standard.object(forKey: force24HourKey))
    }

    /// `base` with the forced cycle applied.
    ///
    /// The locale is rebuilt from its identifier so an inherited hour cycle cannot survive
    /// into the off state: `Locale.current` on a 24-hour Mac asks for 24-hour even after the
    /// switch is turned off, while the same identifier built fresh asks the region.
    static func displayLocale(_ base: Locale = .current, forced24Hour: Bool? = nil) -> Locale {
        let fixed = Locale(identifier: base.identifier)
        guard let forced24Hour else { return fixed }

        var components = Locale.Components(locale: fixed)
        components.hourCycle = forced24Hour ? .zeroToTwentyThree : .oneToTwelve
        return Locale(components: components)
    }

    /// Whether the clock is 24-hour, as `locale` resolves it.
    static func uses24Hour(in locale: Locale) -> Bool {
        let pattern = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: locale) ?? ""
        return pattern.contains("H") || pattern.contains("k")
    }

    /// Time of day, following the Mac's clock style. Used for event times, the now
    /// indicator and the menu bar, so all three read the same.
    static func timeFormatter(
        locale: Locale = .current,
        timeZone: TimeZone = .current,
        forced24Hour: Bool? = nil
    ) -> DateFormatter {
        let df = DateFormatter()
        df.locale = displayLocale(locale, forced24Hour: forced24Hour)
        df.timeZone = timeZone
        df.dateStyle = .none
        df.timeStyle = .short
        return df
    }

    /// The hour alone, for a day grid's gutter: `09` on a 24-hour clock, `9 AM` on a
    /// 12-hour one. A `timeStyle` formatter would add minutes the gutter has no room for.
    static func hourFormatter(
        locale: Locale = .current,
        timeZone: TimeZone = .current,
        forced24Hour: Bool? = nil
    ) -> DateFormatter {
        let effective = displayLocale(locale, forced24Hour: forced24Hour)
        let df = DateFormatter()
        df.locale = effective
        df.timeZone = timeZone
        df.dateFormat = uses24Hour(in: effective) ? "HH" : "ha"
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
        df.locale = displayLocale(locale)
        df.timeZone = timeZone
        df.setLocalizedDateFormatFromTemplate(template)
        return df
    }

    // MARK: - Cached clock formatters

    private struct ClockFormatters {
        let signature: String
        let time: DateFormatter
        let hour: DateFormatter
    }

    private static var cached: ClockFormatters?

    /// Rebuilt only when the key or the locale changes, so a view body pays one defaults
    /// lookup rather than a `DateFormatter` construction.
    private static func formatters() -> ClockFormatters {
        let forced = forced24Hour
        let base = Locale.current
        let signature = "\(base.identifier)|\(forced.map { $0 ? "24" : "12" } ?? "auto")"

        if let cached, cached.signature == signature {
            return cached
        }

        let built = ClockFormatters(
            signature: signature,
            time: timeFormatter(locale: base, forced24Hour: forced),
            hour: hourFormatter(locale: base, forced24Hour: forced)
        )
        cached = built
        return built
    }

    static var time: DateFormatter {
        formatters().time
    }

    static var hour: DateFormatter {
        formatters().hour
    }
}
