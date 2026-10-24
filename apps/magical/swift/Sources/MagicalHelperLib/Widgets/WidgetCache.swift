import Foundation
import SwiftUI

// MARK: - Shared cache

/// Snapshot written by the Electron main process whenever the diary changes.
///
/// Read from the App Group container both sides are entitled for, so the
/// extension needs no reach into Application Support, where the Google session
/// cookies also live. See `src/widget-cache.ts` and `entitlements.plist`.
public struct WidgetCache: Codable {
    public var updatedAt: Double
    public var events: [CachedEvent]
    /// Calendars with something on that day, keyed `YYYY-MM-DD`.
    public var densityDots: [String: [CachedDot]]
    /// Every calendar the accounts hold, which is what a widget's own picker offers.
    public var calendars: [CachedCalendar]
    /// The menu bar popover's filter, which seeds a new widget's picker.
    public var hiddenCalendars: [CalendarRef]
    public var activeAccountId: String?
    /// Whether a Focus filter is currently active. Absent in older snapshots.
    public var isFocusActive: Bool?
    /// Calendars silenced by the active Focus filter. Absent when no filter is active.
    public var silencedCalendars: [CalendarRef]?

    /// Set by `showing(_:)` in the extension process; never written to or read from disk.
    ///
    /// True when Focus is active, at least one of this widget's calendars is silenced by
    /// it, and every event that would otherwise show has been hidden by that silencing.
    /// Views use this to distinguish "silenced by Focus" from "genuinely empty".
    public var isSilencedByFocus: Bool = false

    private enum CodingKeys: String, CodingKey {
        case updatedAt, events, densityDots, calendars, hiddenCalendars,
             activeAccountId, isFocusActive, silencedCalendars
        // isSilencedByFocus is intentionally excluded: it is computed per widget
        // instance by showing(_:) and must not round-trip through the snapshot.
    }

    public static let empty = WidgetCache(
        updatedAt: 0,
        events: [],
        densityDots: [:],
        calendars: [],
        hiddenCalendars: [],
        activeAccountId: nil as String?
    )

    public init(
        updatedAt: Double,
        events: [CachedEvent],
        densityDots: [String: [CachedDot]],
        calendars: [CachedCalendar] = [],
        hiddenCalendars: [CalendarRef] = [],
        activeAccountId: String? = nil,
        isFocusActive: Bool? = nil,
        silencedCalendars: [CalendarRef]? = nil,
        isSilencedByFocus: Bool = false
    ) {
        self.updatedAt = updatedAt
        self.events = events
        self.densityDots = densityDots
        self.calendars = calendars
        self.hiddenCalendars = hiddenCalendars
        self.activeAccountId = activeAccountId
        self.isFocusActive = isFocusActive
        self.silencedCalendars = silencedCalendars
        self.isSilencedByFocus = isSilencedByFocus
    }

    private static let fileName = "widget-cache.json"

    /// Nil when this process is not entitled for the group, which is a build
    /// fault rather than a missing snapshot; `load()` renders the placeholder.
    static var fileURL: URL? {
        guard let group = widgetAppGroupId else { return nil }
        return FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: group)?
            .appendingPathComponent(fileName)
    }

    /// Returns `.empty` when the file is absent or unreadable, so widgets render
    /// a sensible placeholder rather than failing to load.
    static func load() -> WidgetCache {
        let logger = WidgetsLogger.shared
        guard let url = fileURL else {
            logger.error("No App Group container; this build is not entitled for \(widgetAppGroupId ?? "any group")")
            return .empty
        }

        guard FileManager.default.fileExists(atPath: url.path) else {
            logger.warn("widget-cache.json not found at \(logger.redactText(url.path))")
            return .empty
        }

        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            logger.error("Failed to read widget-cache.json: \(error.localizedDescription)")
            return .empty
        }

        do {
            let cache = try JSONDecoder().decode(WidgetCache.self, from: data)
            logger.info("Loaded widget cache: \(cache.events.count) event(s), \(cache.densityDots.count) day(s) with dots")
            return cache
        } catch {
            logger.error("Failed to decode widget-cache.json: \(error)")
            return .empty
        }
    }
}

/// One calendar, on one account.
///
/// A calendar id does not identify a calendar on its own. Google gives Birthdays, Tasks
/// and each locale's holidays the same id in every account, so a filter keyed on the id
/// alone hides one account's Birthdays by hiding another's.
public struct CalendarRef: Codable, Hashable {
    public let accountId: String
    public let calendarId: String

    public init(accountId: String, calendarId: String) {
        self.accountId = accountId
        self.calendarId = calendarId
    }
}

/// The glyph that says what kind of entry something is, and the word for it.
public struct EventKindGlyph: Equatable {
    public let symbol: String
    public let label: String

    public init(symbol: String, label: String) {
        self.symbol = symbol
        self.label = label
    }
}

/// Which working location an entry names, taken from its title.
public func workingLocationGlyph(title: String) -> EventKindGlyph {
    let name = title.trimmingCharacters(in: .whitespaces).lowercased()
    if name == "home" {
        return EventKindGlyph(symbol: "house", label: String(localized: "Working from home"))
    }
    if name == "office" || name.hasSuffix("(office)") {
        return EventKindGlyph(symbol: "building.2", label: String(localized: "Working from the office"))
    }
    return EventKindGlyph(symbol: "mappin.and.ellipse", label: String(localized: "Working from \(title)"))
}

/// One calendar a widget's picker offers.
public struct CachedCalendar: Codable {
    public var accountId: String
    public var calendarId: String
    /// How the account is named in the picker, which is its address where it has one.
    public var accountName: String
    public var name: String
    public var colorHex: String

    public init(
        accountId: String,
        calendarId: String,
        accountName: String,
        name: String,
        colorHex: String
    ) {
        self.accountId = accountId
        self.calendarId = calendarId
        self.accountName = accountName
        self.name = name
        self.colorHex = colorHex
    }

    public var ref: CalendarRef {
        CalendarRef(accountId: accountId, calendarId: calendarId)
    }
}

/// One calendar with something on a day, which the month grid draws as a dot.
///
/// Named by calendar rather than by colour alone so that a widget can take out the
/// calendars it does not show; the colours are collapsed when the grid draws them.
public struct CachedDot: Codable {
    public var accountId: String
    public var calendarId: String
    public var colorHex: String

    public init(accountId: String, calendarId: String, colorHex: String) {
        self.accountId = accountId
        self.calendarId = calendarId
        self.colorHex = colorHex
    }

    public var ref: CalendarRef {
        CalendarRef(accountId: accountId, calendarId: calendarId)
    }
}

/// The calendar day an entry belongs to, as local midnight.
///
/// An all-day entry is a calendar date: the wire sends it as a bare epoch at exactly midnight
/// UTC, so the date it is on is that instant's **UTC** fields and the Mac's zone is never the
/// reader. Reading it on the machine's clock files a bank holiday a day early west of UTC and
/// a day late east of it. A timed entry is an instant and belongs to the Mac's day, which is
/// the evening the user is having.
///
/// Shared by the popover's `TrayEvent` and the widget's `CachedEvent`, so one entry cannot be
/// filed under two days. It lives in this file, rather than beside `TrayModel`, because the
/// widget extension target compiles `WidgetCache.swift` and not `TrayModel.swift`.
func allDayCalendarDay(_ instant: Date, isAllDay: Bool) -> Date {
    guard isAllDay else { return Calendar.current.startOfDay(for: instant) }

    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(secondsFromGMT: 0) ?? TimeZone(identifier: "UTC") ?? .current
    let parts = utc.dateComponents([.year, .month, .day], from: instant)
    return Calendar.current.date(from: parts) ?? Calendar.current.startOfDay(for: instant)
}

// One event.
//
// Every field beyond the identity and the times is optional, because a
// snapshot written by an older build is missing whatever that build did not
// write, and a widget that fails to decode shows nothing at all.

public struct CachedEvent: Codable, Identifiable {
    public var id: String
    /// Which account holds it, since a calendar id alone does not name a calendar.
    public var accountId: String
    /// Every calendar of that account's holding it, canonicalised as the popover has them.
    public var calendarIds: [String]
    public var title: String
    /// Milliseconds since the epoch.
    public var start: Double
    public var end: Double
    public var isAllDay: Bool?
    /// What kind of entry this is; mirrors `EVENT_TYPE` in `calendar-decoder.ts`.
    public var eventType: Int?
    public var isCompleted: Bool?
    public var colorHex: String?
    /// Already converted for the desktop client by `toNativeMeetingUrl`.
    public var joinUrl: String?
    public var conferenceService: String?
    /// Opens Magical on the event's day.
    public var openUrl: String?

    public init(
        id: String,
        accountId: String,
        calendarIds: [String],
        title: String,
        start: Double,
        end: Double,
        isAllDay: Bool? = nil,
        eventType: Int? = nil,
        isCompleted: Bool? = nil,
        colorHex: String? = nil,
        joinUrl: String? = nil,
        conferenceService: String? = nil,
        openUrl: String? = nil
    ) {
        self.id = id
        self.accountId = accountId
        self.calendarIds = calendarIds
        self.title = title
        self.start = start
        self.end = end
        self.isAllDay = isAllDay
        self.eventType = eventType
        self.isCompleted = isCompleted
        self.colorHex = colorHex
        self.joinUrl = joinUrl
        self.conferenceService = conferenceService
        self.openUrl = openUrl
    }

    var startDate: Date {
        Date(timeIntervalSince1970: start / 1000)
    }

    var endDate: Date {
        Date(timeIntervalSince1970: end / 1000)
    }

    var allDay: Bool {
        isAllDay ?? false
    }

    /// The calendar day this entry is filed under, as local midnight.
    ///
    /// The agenda groups and heads each day by this, so an all-day entry lands on the date it
    /// is on rather than the Mac's day for the midnight-UTC instant that carries it.
    var scheduleDay: Date {
        allDayCalendarDay(startDate, isAllDay: allDay)
    }

    /// The last calendar day this entry covers, as local midnight.
    ///
    /// An all-day entry is a range of dates whose end is exclusive, so its last covered date is
    /// the one before `endDate`: the same UTC-date read as `scheduleDay`, taken a day back. A
    /// timed entry covers only the day it starts on.
    var lastCoveredDay: Date {
        guard allDay else { return scheduleDay }
        return allDayCalendarDay(endDate.addingTimeInterval(-86400), isAllDay: true)
    }

    /// The glyph that says what kind of entry this is, drawn before the title.
    ///
    /// One glyph, because `eventType` holds one value: an entry is a birthday, or a task,
    /// or a working location, never two at once.
    ///
    /// A birthday and a task each arrive down the primary calendar's feed rather than on a
    /// calendar of their own, so only this separates them from an appointment.
    var kindGlyph: EventKindGlyph? {
        switch eventType {
        case 13:
            EventKindGlyph(symbol: "birthday.cake", label: String(localized: "Birthday"))
        case 7:
            EventKindGlyph(symbol: "headphones", label: String(localized: "Focus time"))
        case 9:
            if isCompleted == true {
                EventKindGlyph(symbol: "checkmark.circle", label: String(localized: "Completed task"))
            } else {
                EventKindGlyph(symbol: "circle", label: String(localized: "Task"))
            }
        case 10, 11:
            workingLocationGlyph(title: title)
        default:
            nil
        }
    }

    var colour: Color {
        Color(hexString: colorHex ?? "#3f51b5")
    }

    func isRunning(at now: Date) -> Bool {
        startDate <= now && endDate > now
    }

    /// `10:00 – 10:15`, or `All day`. Never abbreviated: when a meeting starts
    /// and ends is the one thing on the line that cannot be guessed.
    var timeRange: String {
        guard !allDay else { return String(localized: "All day") }
        return "\(WidgetFormat.time(startDate)) – \(WidgetFormat.time(endDate))"
    }

    /// `10:00 – 10:15 · Google Meet`, on one line where there is only one.
    var timeAndService: String {
        guard let service = conferenceService else { return timeRange }
        return "\(timeRange) · \(service)"
    }

    /// Where clicking the card goes. Falls back to opening the app.
    var destination: URL? {
        URL(string: openUrl ?? "magical://open")
    }
}

// MARK: - Formatting

enum WidgetFormat {
    /// Short time, so it follows the 12- or 24-hour clock the user has set
    /// rather than pinning one of them.
    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    /// Fixed locale and no time zone drift: this has to produce exactly the key
    /// `widget-cache.ts` wrote, or a day's dots go missing.
    private static let dayKeyFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    static func time(_ date: Date) -> String {
        timeFormatter.string(from: date)
    }

    /// The key the snapshot files a day under, in the local zone.
    static func dayKey(_ date: Date) -> String {
        dayKeyFormatter.string(from: date)
    }

    /// The countdown, worded as `TrayCountdown.label` words it for the popover.
    ///
    /// `Text(_:style: .relative)` was tried and is the wrong tool: it always
    /// carries seconds, so the pill read `44 min, 59 secs` and repainted every
    /// second. Beyond an hour this returns nil and the caller shows the start
    /// time instead, because a countdown that only refreshes when the timeline
    /// does would be wrong by however long the gap between entries is.
    static func countdown(to start: Date, from now: Date) -> String? {
        let minutes = Int((start.timeIntervalSince(now) / 60).rounded(.down))
        if minutes <= 0 {
            return String(localized: "NOW")
        }
        if minutes >= 60 {
            return nil
        }
        return String(localized: "IN \(minutes) MINS")
    }

    /// `SUN 20`, for a header that has to say what day it is in very little room.
    static func shortDay(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE d"
        return formatter.string(from: date).uppercased()
    }

    /// `SUNDAY`.
    static func weekday(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEEE"
        return formatter.string(from: date).uppercased()
    }

    /// `TODAY`, `TOMORROW`, then the weekday and the date.
    static func dayHeading(_ date: Date, now: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) {
            return String(localized: "TODAY")
        }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
           calendar.isDate(date, inSameDayAs: tomorrow)
        {
            return String(localized: "TOMORROW")
        }
        let formatter = DateFormatter()
        formatter.dateFormat = "EEEE d"
        return formatter.string(from: date).uppercased()
    }
}

// MARK: - Grouping

extension WidgetCache {
    /// Events still worth showing: what is running, and what has not started.
    ///
    /// An all-day entry is a range of dates rather than an instant, so it is kept while its last
    /// covered date is today or later. Comparing its exclusive end instant instead lets a finished
    /// one-day entry linger into the next local day east of UTC, where that end is still ahead.
    func upcoming(from now: Date) -> [CachedEvent] {
        let today = Calendar.current.startOfDay(for: now)
        return events.filter { event in
            event.allDay ? event.lastCoveredDay >= today : event.endDate > now
        }
    }

    /// The meeting to count down to: the one under way, or the next one left.
    ///
    /// All-day entries are skipped. A countdown to something that fills the
    /// whole day says nothing about when to stop what you are doing.
    func nextEvent(from now: Date) -> CachedEvent? {
        upcoming(from: now).first { !$0.allDay && $0.isCompleted != true }
    }

    /// Today's all-day entries.
    ///
    /// `nextEvent` skips these, rightly: a countdown to something filling the
    /// whole day says nothing about when to stop what you are doing. But they
    /// are still what is on, so Up next shows them rather than reporting an
    /// empty day over the top of a birthday.
    ///
    /// An all-day entry covers a range of dates, so today counts when it lies inside that range:
    /// a holiday that began before today is still on, and one that starts tomorrow is not today's
    /// even though its midnight-UTC instant lands on this evening.
    func allDayToday(from now: Date) -> [CachedEvent] {
        let today = Calendar.current.startOfDay(for: now)

        // `upcoming` has already dropped anything whose last covered date is past, so an all-day
        // entry that began before today and is still running reaches the range test below.
        return upcoming(from: now).filter { event in
            event.allDay && event.scheduleDay <= today && today <= event.lastCoveredDay
        }
    }

    /// Events grouped by their day, in order, for the agenda.
    ///
    /// An all-day entry is a range of dates and is filed on the date it starts, so one still
    /// running keeps its own — possibly earlier — date rather than being pulled onto today. A
    /// timed entry is an instant, so one that began before today and has not ended is shown
    /// under today.
    func byDay(from now: Date) -> [(day: Date, events: [CachedEvent])] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: now)
        var order: [Date] = []
        var grouped: [Date: [CachedEvent]] = [:]

        for event in upcoming(from: now) {
            let day = event.allDay ? event.scheduleDay : max(event.scheduleDay, today)
            if grouped[day] == nil {
                order.append(day)
                grouped[day] = []
            }
            grouped[day]?.append(event)
        }

        // Sorted so a still-running all-day entry, filed on its own earlier date, cannot sit below a
        // later group's heading: the sender's order is by instant, and an all-day midnight-UTC start
        // is the previous evening west of UTC.
        return order.sorted().map { (day: $0, events: grouped[$0] ?? []) }
    }

    /// Everything on today's date, which is what the Month widgets' TODAY panel shows.
    ///
    /// The panel is a view of today's date, not of `byDay`'s first group: a still-running all-day
    /// entry is filed on its own earlier date, so reading the first group would show it and drop
    /// today's timed entries. Every all-day entry whose covered range includes today leads, then
    /// today's timed entries; a one-day all-day entry on today is in both and appears once.
    func todayEvents(from now: Date) -> [CachedEvent] {
        let allDay = allDayToday(from: now)
        let alreadyShown = Set(allDay.map(\.id))
        let timed = byDay(from: now)
            .first { Calendar.current.isDate($0.day, inSameDayAs: now) }?
            .events.filter { !alreadyShown.contains($0.id) } ?? []
        return allDay + timed
    }

    /// Up to four colours for a day cell in the grid.
    ///
    /// One dot per colour, not per calendar: two calendars Google paints the same colour
    /// are one dot, as they were before a dot named the calendar it came from.
    func dots(on day: Date) -> [Color] {
        var colours: [String] = []
        for dot in densityDots[WidgetFormat.dayKey(day)] ?? [] where !colours.contains(dot.colorHex) {
            colours.append(dot.colorHex)
        }
        return colours.prefix(4).map { Color(hexString: $0) }
    }

    /// Where clicking a day in the grid goes.
    ///
    /// Nil with no account signed in, which leaves the cell inert rather than
    /// sending `openDeepLink` a link it will refuse and log.
    func dayDestination(_ day: Date) -> URL? {
        guard let account = activeAccountId,
              let encoded = account.addingPercentEncoding(withAllowedCharacters: .alphanumerics)
        else {
            return nil
        }

        let at = ISO8601DateFormatter().string(from: Calendar.current.startOfDay(for: day))
        guard let when = at.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else {
            return nil
        }

        return URL(string: "magical://date?account=\(encoded)&at=\(when)")
    }
}

// MARK: - Colour

extension Color {
    /// `#RRGGBB` or `#RGB`, falling back to grey rather than to nothing: an
    /// event drawn in grey is still readable, an event drawn in clear is not.
    init(hexString: String) {
        var hex = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
        if hex.hasPrefix("#") {
            hex.removeFirst()
        }

        if hex.count == 3 {
            hex = hex.map { "\($0)\($0)" }.joined()
        }

        guard hex.count == 6, let value = UInt32(hex, radix: 16) else {
            self = .gray
            return
        }

        self = Color(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255,
            opacity: 1
        )
    }
}
