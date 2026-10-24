import Foundation
import HelperRPC
import HelperUI
import SwiftUI

// MARK: - Tray Models

public struct TrayAccount: Identifiable, Equatable {
    public let id: String
    public let name: String
    public let color: String
    public let unreadCount: Int
    public let email: String
    public let needsAuth: Bool

    public init(from dict: [String: Any]) {
        id = dict["id"] as? String ?? ""
        name = dict["name"] as? String ?? String(localized: "Unknown")
        color = dict["color"] as? String ?? "#039be5"
        unreadCount = dict["unreadCount"] as? Int ?? (dict["pendingRsvpCount"] as? Int ?? 0)
        email = dict["email"] as? String ?? ""
        needsAuth = dict["needsAuth"] as? Bool ?? false
    }

    public init(id: String, name: String, color: String, unreadCount: Int = 0, email: String = "", needsAuth: Bool = false) {
        self.id = id
        self.name = name
        self.color = color
        self.unreadCount = unreadCount
        self.email = email
        self.needsAuth = needsAuth
    }
}

enum TrayFormatters {
    static let dateFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        return df
    }()

    static let timeFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "HH:mm"
        df.timeZone = .current
        return df
    }()

    static let monthYearFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "MMMM yyyy"
        df.timeZone = .current
        return df
    }()

    static let dayOfWeekFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "EEE"
        df.timeZone = .current
        return df
    }()

    static let dayNumberFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "d"
        df.timeZone = .current
        return df
    }()

    static let monthNameFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "MMMM"
        df.timeZone = .current
        return df
    }()
}

public struct TrayCalendarItem: Identifiable, Equatable {
    public let id: String
    public let accountId: String
    public let name: String
    public let colorHex: String

    public init(id: String, accountId: String, name: String, colorHex: String) {
        self.id = id
        self.accountId = accountId
        self.name = name
        self.colorHex = colorHex
    }

    public init(from dict: [String: Any]) {
        id = dict["id"] as? String ?? ""
        accountId = dict["accountId"] as? String ?? ""
        name = dict["name"] as? String ?? String(localized: "Calendar")
        colorHex = dict["colorHex"] as? String ?? "#039be5"
    }
}

/// The answers `tray.rsvp` carries.
///
/// Spelled out rather than numbered. Nothing downstream is numeric — the main process turns
/// the value straight back into a string and clicks Google's own Yes, No or Maybe button —
/// so a number was only ever an encoding to get wrong, and it was: the numbering collided
/// with the `myResponseStatus` codes the poller reports, where `2` means tentative rather
/// than declined.
public enum RsvpReply {
    public static let yes = "yes"
    public static let maybe = "maybe"
    public static let no = "no"
}

/// What kind of entry an event is, as the poller reports it.
///
/// Mirrors `EVENT_TYPE` in `calendar-decoder.ts`, which reads it off the wire. Only the
/// kinds something here draws differently are named.
public enum TrayEventKind {
    public static let focusTime = 7
    public static let task = 9
    public static let workingLocation = 10
    public static let workingLocationOneOff = 11
    public static let birthday = 13
}

public struct TrayEvent: Identifiable, Equatable {
    public let id: String
    public let accountId: String
    /// Every calendar of the account's that holds this event.
    ///
    /// Plural because an event sits on several at once: an interview is on the recruiting
    /// calendar that created it and on the calendar of everyone attending. The filter drops
    /// the event only when it hides all of them.
    public let calendarIds: [String]
    public let calendarName: String?
    public let summary: String
    public let startTime: Date
    public let endTime: Date
    public let isAllDay: Bool
    public let eventType: Int
    public let colorHex: String
    public let conferenceUrl: String?
    public let location: String?
    public let myResponseStatus: Int
    public let organizerEmail: String?
    public let webUrl: String?
    public let isCompleted: Bool

    public init(from dict: [String: Any]) {
        id = dict["id"] as? String ?? UUID().uuidString
        accountId = dict["accountId"] as? String ?? ""
        calendarIds = dict["calendarIds"] as? [String] ?? []
        calendarName = dict["calendarName"] as? String
        summary = dict["summary"] as? String ?? String(localized: "Untitled Event")

        if let startMs = dict["startTime"] as? Double {
            startTime = Date(timeIntervalSince1970: startMs / 1000)
        } else if let startMs = dict["startTime"] as? Int {
            startTime = Date(timeIntervalSince1970: Double(startMs) / 1000)
        } else if let startIso = dict["startTime"] as? String, let parsed = ISO8601DateFormatter().date(from: startIso) {
            startTime = parsed
        } else {
            startTime = Date()
        }

        if let endMs = dict["endTime"] as? Double {
            endTime = Date(timeIntervalSince1970: endMs / 1000)
        } else if let endMs = dict["endTime"] as? Int {
            endTime = Date(timeIntervalSince1970: Double(endMs) / 1000)
        } else if let endIso = dict["endTime"] as? String, let parsed = ISO8601DateFormatter().date(from: endIso) {
            endTime = parsed
        } else {
            endTime = startTime.addingTimeInterval(3600)
        }

        isAllDay = dict["isAllDay"] as? Bool ?? false
        eventType = dict["eventType"] as? Int ?? 0
        colorHex = dict["colorHex"] as? String ?? (dict["color"] as? String ?? "#039be5")
        conferenceUrl = dict["conferenceUrl"] as? String
        location = dict["location"] as? String
        myResponseStatus = dict["myResponseStatus"] as? Int ?? -1
        organizerEmail = dict["organizerEmail"] as? String
        webUrl = dict["webUrl"] as? String
        isCompleted = dict["isCompleted"] as? Bool ?? false
    }

    /// The glyph that says what kind of entry this is, drawn before the title.
    ///
    /// One glyph, because `eventType` holds one value: an entry is a birthday, or a task,
    /// or a working location, never two at once.
    ///
    /// A birthday and a task each arrive down the primary calendar's feed rather than on a
    /// calendar of their own, so only this separates them from an appointment.
    public var kindGlyph: EventKindGlyph? {
        switch eventType {
        case TrayEventKind.birthday:
            EventKindGlyph(symbol: "birthday.cake", label: String(localized: "Birthday"))
        case TrayEventKind.focusTime:
            EventKindGlyph(symbol: "headphones", label: String(localized: "Focus time"))
        case TrayEventKind.task:
            if isCompleted {
                EventKindGlyph(symbol: "checkmark.circle", label: String(localized: "Completed task"))
            } else {
                EventKindGlyph(symbol: "circle", label: String(localized: "Task"))
            }
        case TrayEventKind.workingLocation, TrayEventKind.workingLocationOneOff:
            workingLocationGlyph(title: summary)
        default:
            nil
        }
    }

    /// Whether this is a Google Task rather than an appointment.
    ///
    /// A task is completed and deleted through controls of its own, and neither the word
    /// "event" nor an editor route applies to it.
    public var isTask: Bool {
        eventType == TrayEventKind.task
    }

    /// Identifies the row rather than the event, for `ForEach`.
    ///
    /// Google's event id is not unique across accounts: it serves the holiday and
    /// birthday feeds under one id to every account, and the same meeting can sit on two
    /// accounts' calendars at once. `id` stays what the action methods send back, so a
    /// row still names the copy it drew; this keeps one account's copy from taking the
    /// other's row when the two are collapsed into one Agenda.
    public var identity: String {
        "\(accountId)\u{1F}\(id)"
    }

    public var needsRsvp: Bool {
        myResponseStatus == 0
    }

    /// `-1` means the poller found no invitation for this user, which is what an event they
    /// own looks like. Anything from `0` up is an invitation they can answer.
    public var isInvitation: Bool {
        myResponseStatus >= 0
    }

    public var isTentative: Bool {
        myResponseStatus == 2
    }

    /// The calendar day this entry is filed under, as local midnight.
    ///
    /// The agenda, the mini month and the density dots all read this through `dateKey`, so an
    /// all-day entry is grouped, labelled and dotted on the date it is on rather than the Mac's
    /// day for the midnight-UTC instant that carries it. A timed entry keeps the Mac's day.
    var scheduleDay: Date {
        allDayCalendarDay(startTime, isAllDay: isAllDay)
    }

    public var dateKey: String {
        TrayFormatters.dateFormatter.string(from: scheduleDay)
    }

    public var formattedTime: String {
        if isAllDay {
            return String(localized: "All day")
        }
        let start = TrayFormatters.timeFormatter.string(from: startTime)
        let end = TrayFormatters.timeFormatter.string(from: endTime)
        return "\(start) – \(end)"
    }

    /// Named only where the name earns its place, and worded exactly as
    /// `conferenceLabel` in `notification-manager.ts` words it. One meeting reaching the
    /// user twice, once in a banner and once here, must not read two ways.
    public var conferenceServiceName: String? {
        guard let url = conferenceUrl?.lowercased() else { return nil }
        if url.contains("meet.google.com") {
            return "Google Meet"
        }
        if url.contains("zoom.us") {
            return "Zoom"
        }
        if url.contains("teams.microsoft.com") || url.contains("teams.live.com") {
            return "Microsoft Teams"
        }
        return String(localized: "Video call")
    }
}

// MARK: - Tray Observable Model

@MainActor
public final class TrayModel: ObservableObject {
    public static let shared = TrayModel()

    @Published public var accounts: [TrayAccount] = []
    @Published public var disabledCalendars: Set<CalendarRef> = [] {
        didSet { invalidateCaches() }
    }

    /// Bumped by `FocusFilterController` when the active Focus filter changes.
    ///
    /// The filter itself is held there, because the banner path needs it and has no model.
    /// The popover reads it through this model, and SwiftUI redraws on a change to the
    /// object it observes, not on a change to whatever that object's properties consult.
    @Published public var focusFilterRevision: Int = 0 {
        didSet { invalidateCaches() }
    }

    @Published public var selectedAccountId: String? = nil
    @Published public var events: [TrayEvent] = [] {
        didSet { invalidateCaches() }
    }

    @Published public var isCalendarCollapsed: Bool = false
    @Published public var selectedDate: Date = .init()
    @Published public var displayedMonthDate: Date = .init()
    @Published public var requestedScrollDate: Date? = nil
    @Published public var isOffline: Bool = false
    /// A Workspace administrator is refusing Calendar's own web endpoint for an account.
    ///
    /// Separate from `isOffline` (the network is fine) and from the sign-in state (no
    /// credential the user can enter will lift an organisation policy).
    @Published public var isRestricted: Bool = false
    /// When the calendars that have stopped reading last read successfully.
    ///
    /// The oldest among them, chosen in the main process, so the banner names the worst
    /// case rather than an average nothing experienced. Nil while everything is reading.
    @Published public var lastSyncedAt: Date? = nil
    @Published public var showCountdown: Bool = true
    @Published public var menuBarDisplayMode: String = "iconOnly"

    @Published public var showMenuBarAccountColor: Bool = true
    @Published public var showCompletedTasks: Bool = true {
        didSet { invalidateCaches() }
    }

    @Published public var isRefreshing: Bool = false

    private var cachedFilteredEvents: [TrayEvent]?
    private var cachedDensityDots: [String: [Color]]?
    private var cachedGroupedDays: [DayScheduleGroup]?
    private var cachedFeedItems: [ScheduleFeedItem]?

    public func invalidateCaches() {
        cachedFilteredEvents = nil
        cachedDensityDots = nil
        cachedGroupedDays = nil
        cachedFeedItems = nil
    }

    /// Callback when collapse state changes so it can be saved in preferences
    public var onCollapseToggled: ((Bool) -> Void)?

    /// Fired when the user hides or shows a calendar. The controller persists the set and
    /// redraws the status item; the title reads `filteredEvents`, so without this it keeps
    /// counting down to a meeting on a calendar that has just been hidden.
    public var onCalendarFilterChanged: (([[String: String]]) -> Void)?

    /// Fired when the user toggles showing completed tasks in the menu bar.
    public var onShowCompletedTasksChanged: ((Bool) -> Void)?

    public func setShowCompletedTasks(_ show: Bool) {
        showCompletedTasks = show
        onShowCompletedTasksChanged?(show)
    }

    public func toggleShowCompletedTasks() {
        setShowCompletedTasks(!showCompletedTasks)
    }

    public var hasTasks: Bool {
        events.contains { $0.isTask }
    }

    public init() {}

    public func update(from params: [String: Any]) {
        isRefreshing = false
        if let rawAccounts = params["accounts"] as? [[String: Any]] {
            let parsed = rawAccounts.map { TrayAccount(from: $0) }
            if parsed != accounts {
                accounts = parsed
            }
        }
        if let rawCalendars = params["calendars"] as? [[String: Any]] {
            let parsed = rawCalendars.map { TrayCalendarItem(from: $0) }
            if parsed != explicitCalendars {
                explicitCalendars = parsed
            }
        }
        // The persisted set wins until the user touches the filter in this session; after
        // that their live choice does, so a `tray.update` mid-toggle cannot undo it.
        //
        // Logged because the two halves fail identically from the outside: a filter that
        // was never saved and one that was saved and never applied both read as a filter
        // that forgot itself, and only the main process logs the saving half.
        if let hidden = params["hiddenCalendars"] as? [[String: Any]] {
            if hasUserToggledCalendars {
                HelperLog.info("Tray", "Keeping this session's filter over the \(hidden.count) stored")
            } else {
                let parsed: Set<CalendarRef> = Set(hidden.compactMap { entry in
                    guard let accountId = entry["accountId"] as? String,
                          let calendarId = entry["calendarId"] as? String else { return nil }
                    return CalendarRef(accountId: accountId, calendarId: calendarId)
                })
                if parsed != disabledCalendars {
                    disabledCalendars = parsed
                }
                HelperLog.info("Tray", "Applied \(hidden.count) stored hidden calendar(s)")
            }
        }
        if let rawEvents = params["events"] as? [[String: Any]] {
            // Validate timestamps are within the plausible calendar century span (1900–2100)
            let minDate = Date(timeIntervalSince1970: -2_208_988_800) // 1900-01-01
            let maxDate = Date(timeIntervalSince1970: 4_102_444_800) // 2100-01-01
            let parsed = rawEvents
                .map { TrayEvent(from: $0) }
                .filter { $0.startTime >= minDate && $0.startTime <= maxDate }
                .sorted { $0.startTime < $1.startTime }
            if parsed != events {
                events = parsed
            }
        }
        if let activeAcc = params["activeAccountId"] as? String, accounts.contains(where: { $0.id == activeAcc }) {
            if selectedAccountId == nil || !accounts.contains(where: { $0.id == selectedAccountId }) {
                selectedAccountId = activeAcc
            }
        } else if selectedAccountId == nil || !accounts.contains(where: { $0.id == selectedAccountId }) {
            selectedAccountId = accounts.first?.id
        }
        if let collapsed = params["isCalendarCollapsed"] as? Bool, collapsed != isCalendarCollapsed {
            isCalendarCollapsed = collapsed
        }
        if let offline = params["isOffline"] as? Bool, offline != isOffline {
            isOffline = offline
        }
        if let restricted = params["isRestricted"] as? Bool, restricted != isRestricted {
            isRestricted = restricted
        }
        // Absent means nothing is stalled, so the banner has to clear rather than keep
        // the last age it was told; a stale reading left on screen is the defect this
        // banner exists to prevent, one level up.
        // Both number types, as the event timestamps are read: a whole number of
        // milliseconds arrives from `JSON.stringify` with no decimal point, decodes as
        // `Int`, and `as? Double` alone returns nil for it.
        let parsedSyncedAt: Date? = if let synced = params["lastSyncedAt"] as? Double {
            Date(timeIntervalSince1970: synced / 1000)
        } else if let synced = params["lastSyncedAt"] as? Int {
            Date(timeIntervalSince1970: Double(synced) / 1000)
        } else {
            nil
        }
        if parsedSyncedAt != lastSyncedAt {
            lastSyncedAt = parsedSyncedAt
        }
        if let colored = params["showMenuBarAccountColor"] as? Bool, colored != showMenuBarAccountColor {
            showMenuBarAccountColor = colored
        }
        if let mode = params["menuBarDisplayMode"] as? String, mode != menuBarDisplayMode {
            menuBarDisplayMode = mode
        }
        if let showCompleted = params["showCompletedTasks"] as? Bool, showCompleted != showCompletedTasks {
            showCompletedTasks = showCompleted
        }
    }

    @Published public var explicitCalendars: [TrayCalendarItem] = []
    private var hasUserToggledCalendars: Bool = false

    /// Available calendars derived from explicit list or fallback to accounts
    public var availableCalendars: [TrayCalendarItem] {
        if !explicitCalendars.isEmpty {
            return explicitCalendars
        }

        var list: [TrayCalendarItem] = []
        var seen = Set<String>()

        // Fallback: configured accounts only (never meeting organizers from events)
        for account in accounts {
            if !seen.contains(account.id) {
                seen.insert(account.id)
                list.append(TrayCalendarItem(
                    id: account.id,
                    accountId: account.id,
                    name: account.name,
                    colorHex: account.color
                ))
            }
        }
        return list
    }

    /// Whether anything is being held back, by the user's own filter or by a Focus. Drives
    /// the filled filter glyph, which is the only thing on the popover that says the
    /// agenda is not the whole day.
    public var isFilteringCalendars: Bool {
        !disabledCalendars.isEmpty || FocusFilterController.shared.isFilterActive
    }

    /// Whether the user's own filter is holding something back, which is the only part
    /// "Show All Calendars" can give back.
    public var isUserFilteringCalendars: Bool {
        !disabledCalendars.isEmpty
    }

    public func toggleCalendar(_ calendar: TrayCalendarItem) {
        hasUserToggledCalendars = true
        let ref = CalendarRef(accountId: calendar.accountId, calendarId: calendar.id)
        if disabledCalendars.contains(ref) {
            disabledCalendars.remove(ref)
        } else {
            disabledCalendars.insert(ref)
        }
        HelperLog.info("Tray", "Calendar filter changed; \(disabledCalendars.count) hidden")
        onCalendarFilterChanged?(serialisedFilter())
    }

    public func showAllCalendars() {
        hasUserToggledCalendars = true
        disabledCalendars.removeAll()
        HelperLog.info("Tray", "Showing all calendars")
        onCalendarFilterChanged?([])
    }

    /// The filter as the main process stores it, ordered so a rewrite is stable.
    private func serialisedFilter() -> [[String: String]] {
        disabledCalendars
            .sorted { ($0.accountId, $0.calendarId) < ($1.accountId, $1.calendarId) }
            .map { ["accountId": $0.accountId, "calendarId": $0.calendarId] }
    }

    public func isCalendarVisible(_ calendar: TrayCalendarItem) -> Bool {
        !disabledCalendars.contains(CalendarRef(accountId: calendar.accountId, calendarId: calendar.id))
            && !isSilencedByFocus(calendar)
    }

    /// Whether the active Focus filter silences this calendar.
    ///
    /// Takes the row rather than its id, because a calendar id does not identify a calendar
    /// on its own. Google gives Birthdays, Tasks and each locale's holidays the same id in
    /// every account, so an id looked up across the whole list finds whichever account
    /// happens to come first and answers for that one.
    ///
    /// Kept apart from `disabledCalendarIds` rather than folded into it. That set is the
    /// user's own filter and is persisted by the main process, so a Focus writing into it
    /// would edit a choice the user made and not give it back when the Focus ended.
    public func isSilencedByFocus(_ calendar: TrayCalendarItem) -> Bool {
        FocusFilterController.shared.isSilenced(
            calendarId: calendar.id,
            accountId: calendar.accountId
        )
    }

    /// Whether a Focus silences every calendar the event is on.
    ///
    /// Every rather than any: a Work Focus that quietens a recruiting calendar has not asked
    /// to lose an interview the user is attending on their own calendar.
    private func isSilencedByFocus(_ event: TrayEvent) -> Bool {
        guard !event.calendarIds.isEmpty else { return false }
        return event.calendarIds.allSatisfy {
            FocusFilterController.shared.isSilenced(calendarId: $0, accountId: event.accountId)
        }
    }

    /// Everything the menu bar draws: the status item title, the agenda, the mini month's
    /// dots, and the hero card.
    ///
    /// One list for all of them, so they cannot contradict each other. A title counting
    /// down to a lunch the agenda does not list reads as a bug whichever half is right, and
    /// a Focus that quietens the popover while leaving the title announcing the same
    /// meeting has not done what was asked of it.
    public var filteredEvents: [TrayEvent] {
        if let cached = cachedFilteredEvents {
            return cached
        }
        let filtered = events.filter { event in
            if !showCompletedTasks, event.isTask, event.isCompleted {
                return false
            }
            // The account's own row carries its id as a calendar id, so hiding a whole
            // account is the same shape as hiding one of its calendars.
            if disabledCalendars.contains(CalendarRef(accountId: event.accountId, calendarId: event.accountId)) {
                return false
            }
            // Only when every calendar holding the event is hidden. Hiding one of them says
            // nothing about the others: an interview on a recruiting calendar and on the
            // user's own stays in their day when they hide the recruiting one.
            if !event.calendarIds.isEmpty, event.calendarIds.allSatisfy({
                disabledCalendars.contains(CalendarRef(accountId: event.accountId, calendarId: $0))
            }) {
                return false
            }
            return !isSilencedByFocus(event)
        }
        cachedFilteredEvents = filtered
        return filtered
    }

    /// Pre-computed density dots by local day key "yyyy-MM-dd"
    public var densityDotsByDay: [String: [Color]] {
        if let cached = cachedDensityDots {
            return cached
        }
        var map: [String: [Color]] = [:]
        for event in filteredEvents {
            let key = event.dateKey
            let color = Color(hex: event.colorHex)
            var list = map[key] ?? []
            if !list.contains(color), list.count < 4 {
                list.append(color)
            }
            map[key] = list
        }
        cachedDensityDots = map
        return map
    }

    public struct DayScheduleGroup: Identifiable, Equatable {
        public let id: String
        public let date: Date
        public let dayLabel: String
        public let dateNumber: String
        public let events: [TrayEvent]
    }

    /// Events grouped by calendar day
    public var groupedScheduleDays: [DayScheduleGroup] {
        if let cached = cachedGroupedDays {
            return cached
        }
        let calendar = Calendar.current
        var groups: [String: [TrayEvent]] = [:]
        var order: [String] = []

        for event in filteredEvents {
            let key = event.dateKey
            if groups[key] == nil {
                groups[key] = []
                order.append(key)
            }
            groups[key]?.append(event)
        }

        // Sorted by the day each group belongs to, not by arrival: the sender's order is by instant,
        // and a still-running all-day entry's midnight-UTC start is the previous evening west of UTC,
        // so left alone it would head the feed with a later date below an earlier one.
        let sortedOrder = order.sorted { a, b in
            (groups[a]?.first?.scheduleDay ?? .distantPast) <
                (groups[b]?.first?.scheduleDay ?? .distantPast)
        }
        let result = sortedOrder.compactMap { key -> DayScheduleGroup? in
            // Sorted here rather than trusted from the sender. `tray.update` happens to
            // arrive in time order, but the agenda is a chronological feed and the now
            // rule is placed by position, so the order has to be this view's own promise.
            guard let groupEvents = groups[key]?.sorted(by: { $0.startTime < $1.startTime }),
                  let first = groupEvents.first
            else { return nil }
            // The group is headed by the day its entries belong to, not by the instant the
            // earliest one carries: an all-day entry's midnight-UTC start is the evening before
            // west of UTC, which would head the group with the wrong date.
            let day = first.scheduleDay
            let dayLabel = TrayFormatters.dayOfWeekFormatter.string(from: day).uppercased()
            let dayNum = TrayFormatters.dayNumberFormatter.string(from: day)
            return DayScheduleGroup(
                id: key,
                date: calendar.startOfDay(for: day),
                dayLabel: dayLabel,
                dateNumber: dayNum,
                events: groupEvents
            )
        }
        cachedGroupedDays = result
        return result
    }

    public enum ScheduleFeedItem: Identifiable, Equatable {
        case day(DayScheduleGroup)
        case emptyPeriod(id: String, text: String, date: Date)
        case monthHeader(id: String, title: String, date: Date)

        public var id: String {
            switch self {
            case let .day(group): group.id
            case let .emptyPeriod(id, _, _): id
            case let .monthHeader(id, _, _): id
            }
        }

        public var date: Date {
            switch self {
            case let .day(group): group.date
            case let .emptyPeriod(_, _, date): date
            case let .monthHeader(_, _, date): date
            }
        }
    }

    /// Complete chronological schedule feed with day groups, empty period dividers,
    /// and month boundary headers matching Google Calendar iOS / Web.
    public var scheduleFeedItems: [ScheduleFeedItem] {
        if let cached = cachedFeedItems {
            return cached
        }
        let days = groupedScheduleDays
        guard !days.isEmpty else { return [] }

        let calendar = Calendar.current
        var items: [ScheduleFeedItem] = []
        var prevDate: Date? = nil

        for group in days {
            let currDate = calendar.startOfDay(for: group.date)

            if let prev = prevDate {
                // 1. Check for gap between events (>= 2 days apart)
                let daysBetween = calendar.dateComponents([.day], from: prev, to: currDate).day ?? 0
                if daysBetween >= 2,
                   let gapStart = calendar.date(byAdding: .day, value: 1, to: prev),
                   let gapEnd = calendar.date(byAdding: .day, value: -1, to: currDate)
                {
                    let startDay = calendar.component(.day, from: gapStart)
                    let endDay = calendar.component(.day, from: gapEnd)
                    let startMonth = TrayFormatters.monthNameFormatter.string(from: gapStart)
                    let endMonth = TrayFormatters.monthNameFormatter.string(from: gapEnd)

                    let gapText: String = if startMonth == endMonth {
                        startDay == endDay
                            ? "\(startMonth) \(startDay)"
                            : "\(startMonth) \(startDay) – \(endDay)"
                    } else {
                        "\(startMonth) \(startDay) – \(endMonth) \(endDay)"
                    }

                    let gapId = "gap_\(TrayFormatters.dateFormatter.string(from: gapStart))_\(TrayFormatters.dateFormatter.string(from: gapEnd))"
                    items.append(.emptyPeriod(id: gapId, text: gapText, date: gapStart))
                }

                // 2. Check for month boundary
                if !calendar.isDate(prev, equalTo: currDate, toGranularity: .month) {
                    let monthTitle = TrayFormatters.monthYearFormatter.string(from: currDate)
                    let headerId = "month_\(TrayFormatters.dateFormatter.string(from: currDate))"
                    items.append(.monthHeader(id: headerId, title: monthTitle, date: currDate))
                }
            }

            items.append(.day(group))
            prevDate = currDate
        }

        cachedFeedItems = items
        return items
    }

    /// The event currently under way, if any.
    ///
    /// If multiple meetings overlap, the one that started most recently wins so back-to-back
    /// and newly started meetings immediately take over the Join action.
    public func activeEvent(now: Date = Date()) -> TrayEvent? {
        let active = filteredEvents.filter { event in
            !event.isAllDay && !event.isCompleted && event.startTime <= now && event.endTime > now
        }
        return active.max(by: { $0.startTime < $1.startTime })
    }

    /// The next event starting later today, if any.
    public func upcomingEvent(
        within minutes: Int? = nil,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> (event: TrayEvent, minutesUntil: Int)? {
        let endOfToday = calendar.date(bySettingHour: 23, minute: 59, second: 59, of: now) ?? now
        let upcoming = filteredEvents.filter { event in
            !event.isAllDay && !event.isCompleted && event.startTime > now && event.startTime <= endOfToday
        }
        guard let next = upcoming.min(by: { $0.startTime < $1.startTime }) else {
            return nil
        }
        let minsUntil = Int(next.startTime.timeIntervalSince(now) / 60)
        if let minutes, minsUntil > minutes {
            return nil
        }
        return (next, minsUntil)
    }

    /// The meeting under way, or the next one left today — whichever comes first.
    ///
    /// Events from tomorrow are never returned: late in the day, counting down to
    /// tomorrow's stand-up reads as though it were about to start.
    ///
    /// `within` bounds how far ahead to look. The hero card is a "happening now" card and
    /// stops at four hours; the menu bar title takes whatever is left today, because the
    /// alternative is the countdown disappearing mid-afternoon and the date coming back.
    ///
    /// Reads `filteredEvents`, so hiding a calendar in the popover hides it here too, and
    /// so does a Focus silencing one.
    public func nextEvent(
        within minutes: Int?,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> (event: TrayEvent, minutesUntil: Int)? {
        if let active = activeEvent(now: now) {
            return (active, 0)
        }
        return upcomingEvent(within: minutes, now: now, calendar: calendar)
    }

    /// The next boundary in the schedule of events where an event will start or end.
    ///
    /// The menu bar uses this to advance precisely on schedule rather than waiting for the next poll.
    public func nextScheduleTransitionDate(after now: Date = Date()) -> Date? {
        var nextDate: Date? = nil
        for event in filteredEvents where !event.isAllDay && !event.isCompleted {
            if event.startTime > now {
                if let current = nextDate {
                    if event.startTime < current {
                        nextDate = event.startTime
                    }
                } else {
                    nextDate = event.startTime
                }
            }
            if event.endTime > now {
                if let current = nextDate {
                    if event.endTime < current {
                        nextDate = event.endTime
                    }
                } else {
                    nextDate = event.endTime
                }
            }
        }
        return nextDate
    }

    /// Notifies observers that time has moved or a transition occurred so views such as
    /// the popover hero card refresh without needing data to be re-fetched.
    public func refreshNow() {
        objectWillChange.send()
    }

    /// What the popover's hero card shows.
    public var heroNextEvent: (event: TrayEvent, minutesUntil: Int)? {
        nextEvent(within: 240)
    }

    /// Next event used for status item countdown text
    public var onEnsureRange: ((Date) -> Void)?
    private var lastEnsuredRangeDate: Date?

    // MARK: - Navigation

    public var displayedMonthTitle: String {
        TrayFormatters.monthYearFormatter.string(from: displayedMonthDate)
    }

    public func previousMonth() {
        if let prev = Calendar.current.date(byAdding: .month, value: -1, to: displayedMonthDate) {
            displayedMonthDate = prev
            requestMoreEvents(around: prev)
        }
    }

    public func nextMonth() {
        if let next = Calendar.current.date(byAdding: .month, value: 1, to: displayedMonthDate) {
            displayedMonthDate = next
            requestMoreEvents(around: next)
        }
    }

    public func jumpToToday() {
        let today = Date()
        requestScrollTo(date: today)
    }

    public func requestScrollTo(date: Date) {
        selectedDate = date
        requestedScrollDate = date
        let calendar = Calendar.current
        if !calendar.isDate(date, equalTo: displayedMonthDate, toGranularity: .month) {
            displayedMonthDate = date
            requestMoreEvents(around: date)
        }
    }

    public func toggleCalendarCollapse() {
        isCalendarCollapsed.toggle()
        onCollapseToggled?(isCalendarCollapsed)
    }

    public func selectDate(_ date: Date) {
        selectedDate = date
        let calendar = Calendar.current
        if !calendar.isDate(date, equalTo: displayedMonthDate, toGranularity: .month) {
            displayedMonthDate = date
            requestMoreEvents(around: date)
        }
    }

    public func requestMoreEvents(around date: Date) {
        if let last = lastEnsuredRangeDate, abs(date.timeIntervalSince(last)) < 30 * 86400 {
            return
        }
        lastEnsuredRangeDate = date
        onEnsureRange?(date)
    }

    public func prepareForPresentation() {
        let today = Date()
        let cal = Calendar.current
        if !cal.isDateInToday(selectedDate) {
            selectedDate = today
        }
        if !cal.isDate(displayedMonthDate, equalTo: today, toGranularity: .month) {
            displayedMonthDate = today
        }
        if requestedScrollDate == nil || !cal.isDateInToday(requestedScrollDate!) {
            requestedScrollDate = today
        }
    }
}
