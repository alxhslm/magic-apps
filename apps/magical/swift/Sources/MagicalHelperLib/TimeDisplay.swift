import Foundation

/// Times and dates the user reads, on every native surface.
///
/// The Mac's region and its 12/24-hour switch are separate settings, so either region can
/// be on either clock. Foundation resolves both into `Locale.current` once, at launch, and
/// never refreshes it: a process started on a 24-hour Mac keeps a 24-hour locale after the
/// switch is turned off, and a region change never arrives. So the stored keys are read
/// here instead, and the formatters are rebuilt when either one moves.
///
/// The region is `AppleLocale` (`en_GB`), which is what orders and punctuates a date.
///
/// There are two keys, not one. Turning 24-hour on writes `AppleICUForce24HourTime`;
/// turning it off writes `AppleICUForce12HourTime`, so a Mac that prefers 12-hour on a
/// 24-hour region has the first key absent and the second set. Both are read: 24-hour
/// wins when set, then 12-hour, then the region.
///
/// Fixed patterns such as `HH:mm` bypass all of this and pin one of the two clocks. They
/// belong to sort keys and log timestamps, never to something on screen.
public enum TimeDisplay {
    private static let force24HourKey = "AppleICUForce24HourTime"
    private static let force12HourKey = "AppleICUForce12HourTime"
    private static let localeKey = "AppleLocale"

    /// The Mac's region, read live, falling back to the launch-time locale when the key is
    /// absent. Foundation's own `Locale.current` is not consulted first because it carries
    /// whatever the keys said when the process started.
    static func systemLocale() -> Locale {
        let stored = UserDefaults.standard
            .string(forKey: localeKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let stored, !stored.isEmpty {
            return Locale(identifier: stored)
        }
        return Locale(identifier: Locale.current.identifier)
    }

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

    /// Resolves the two stored keys. `true` on the 24-hour key wins, then `true` on the
    /// 12-hour key, and anything else falls through to the region.
    static func forced24Hour(twentyFour: Any?, twelve: Any?) -> Bool? {
        if forced24Hour(from: twentyFour) == true {
            return true
        }
        if forced24Hour(from: twelve) == true {
            return false
        }
        return nil
    }

    /// The Mac's switch, read live.
    static var forced24Hour: Bool? {
        let defaults = UserDefaults.standard
        return forced24Hour(
            twentyFour: defaults.object(forKey: force24HourKey),
            twelve: defaults.object(forKey: force12HourKey)
        )
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
        locale: Locale = systemLocale(),
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
        locale: Locale = systemLocale(),
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
        locale: Locale = systemLocale(),
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

    /// Rebuilt only when a key or the region changes, so a view body pays a defaults lookup
    /// rather than a `DateFormatter` construction.
    private static func formatters() -> ClockFormatters {
        let forced = forced24Hour
        let base = systemLocale()
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

    // MARK: - Change signal

    /// Posted when the stored clock has changed under a running process.
    static let clockDidChangeNotification = Notification.Name("MagicalClockDidChange")

    private static var watcher: Timer?

    /// Checks the stored clock every few seconds and tells the models to redraw when it
    /// moves. macOS posts no notification for the switch, so a timer is the only way a
    /// window that is already open learns about the change; the helper calls this once at
    /// launch. A widget is not watched here, because WidgetKit redraws it on its timeline.
    public static func startWatching(interval: TimeInterval = 5) {
        guard watcher == nil else { return }
        let timer = Timer(timeInterval: interval, repeats: true) { _ in
            _ = refreshIfNeeded()
        }
        RunLoop.main.add(timer, forMode: .common)
        watcher = timer
    }

    /// Rebuilds the cached formatters if the clock moved. Returns whether it did, and posts
    /// `clockDidChangeNotification` so every observing model invalidates.
    @discardableResult
    static func refreshIfNeeded() -> Bool {
        let before = cached?.signature
        _ = formatters()
        guard let before, cached?.signature != before else { return false }

        NotificationCenter.default.post(name: clockDidChangeNotification, object: nil)
        return true
    }
}
