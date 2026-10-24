import Foundation
@testable import MagicalHelperLib
import Testing

/// The all-day display round's Swift surfaces, west of UTC.
///
/// An all-day entry reaches the helper as a bare epoch at exactly midnight UTC and is a
/// calendar date; a timed entry is an instant and is read on the Mac's clock. The popover's
/// agenda and mini month, and the widget's agenda, file an all-day entry by the instant's
/// local day, so west of UTC — where midnight UTC is the evening before — a bank holiday on
/// the 18th is drawn, grouped and dotted on the 17th, and a New Year's Day entry on 31 December.
///
/// The zone the suite runs in decides which of these it catches: `TZ=America/New_York` fails
/// every all-day case below, and `TZ=Pacific/Auckland` is the control, where the Mac's date for
/// a midnight-UTC instant already is the UTC date and the same assertions pass. Nothing here
/// asserts a machine-local reading of an all-day instant, and the timed controls are built from
/// local fields, so they hold in every zone.
///
/// The widget's day filters — `upcoming`, `allDayToday` and `byDay` — are pinned at the end
/// of this suite, and each of those cases states the covered date range in the abstract.
/// What they expect is the same in every zone; which zone catches a fault is not, because the
/// two halves of a range fail in opposite directions: an instant comparison lets a finished
/// one-day entry linger into the next local day east of UTC, and counts tomorrow's entry as
/// today's west of UTC.
@Suite("Magical all-day display Tests")
@MainActor
struct AllDayDisplayTests {
    /// An all-day entry as the poller sends one: a bare epoch at midnight UTC, no zone.
    ///
    /// The end is exclusive — a one-day entry ends at midnight UTC on the following date.
    private func allDayEvent(id: String, start: String, end: String) throws -> TrayEvent {
        let from = try instant(start)
        let to = try instant(end)

        return TrayEvent(from: [
            "id": id,
            "accountId": "acc_1",
            "summary": "Bank holiday",
            "startTime": from.timeIntervalSince1970 * 1000,
            "endTime": to.timeIntervalSince1970 * 1000,
            "isAllDay": true,
            "calendarIds": ["holidays@group.v.calendar.google.com"],
        ])
    }

    /// The same entry in the widget's snapshot, which carries milliseconds rather than dates.
    private func cachedAllDay(id: String, start: String, end: String) throws -> CachedEvent {
        let from = try instant(start)
        let to = try instant(end)

        return CachedEvent(
            id: id,
            accountId: "acc_1",
            calendarIds: ["holidays@group.v.calendar.google.com"],
            title: "Bank holiday",
            start: from.timeIntervalSince1970 * 1000,
            end: to.timeIntervalSince1970 * 1000,
            isAllDay: true
        )
    }

    /// A timed entry built from local fields, so its day is the Mac's in every zone.
    private func timedEvent(id: String, on day: Date, hour: Int) -> TrayEvent {
        let start = day.addingTimeInterval(Double(hour) * 3600)

        return TrayEvent(from: [
            "id": id,
            "accountId": "acc_1",
            "summary": "Standup",
            "startTime": start.timeIntervalSince1970 * 1000,
            "endTime": start.addingTimeInterval(3600).timeIntervalSince1970 * 1000,
            "isAllDay": false,
            "calendarIds": ["cal_1"],
        ])
    }

    private func instant(_ iso: String) throws -> Date {
        try #require(ISO8601DateFormatter().date(from: iso))
    }

    /// Local midnight on a calendar date: the day a mini-month cell and an agenda head name.
    private func localDay(_ year: Int, _ month: Int, _ day: Int) throws -> Date {
        try #require(Calendar.current.date(from: DateComponents(year: year, month: month, day: day)))
    }

    /// `EEE` for a day, worded as `TrayFormatters.dayOfWeekFormatter` words it.
    private func weekdayLabel(_ day: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE"
        formatter.timeZone = .current

        return formatter.string(from: day).uppercased()
    }

    @Test func anAllDayEventKeepsItsOwnDate() throws {
        let holiday = try allDayEvent(
            id: "holiday",
            start: "2026-09-18T00:00:00Z",
            end: "2026-09-19T00:00:00Z"
        )

        #expect(holiday.dateKey == "2026-09-18")
    }

    @Test func theMiniMonthDotsTheDayAnAllDayEventIsOn() throws {
        let holiday = try allDayEvent(
            id: "holiday",
            start: "2026-09-18T00:00:00Z",
            end: "2026-09-19T00:00:00Z"
        )
        let model = TrayModel()
        model.events = [holiday]

        // One day, the day the entry is on: not the 17th west of UTC, and not the 19th from an
        // exclusive end read on the machine's clock.
        #expect(model.densityDotsByDay.keys.sorted() == ["2026-09-18"])
    }

    @Test func theAgendaGroupsAnAllDayEventUnderItsOwnDay() throws {
        let holidayEvent = try allDayEvent(
            id: "holiday",
            start: "2026-09-18T00:00:00Z",
            end: "2026-09-19T00:00:00Z"
        )
        let model = TrayModel()
        model.events = [holidayEvent]

        let days = model.groupedScheduleDays
        let holiday = try localDay(2026, 9, 18)

        #expect(days.count == 1)
        #expect(days.first?.id == "2026-09-18")
        #expect(days.first?.date == holiday)
        #expect(days.first?.dateNumber == "18")
        #expect(days.first?.dayLabel == weekdayLabel(holiday))
    }

    @Test func aMultiDayAllDayEventStartsOnItsOwnDateAcrossNewYear() throws {
        // 30 December to 1 January inclusive: the end is exclusive midnight UTC, so the last
        // date the entry covers is 1 January and 29 December is not part of it.
        let winter = try allDayEvent(
            id: "winter",
            start: "2026-12-30T00:00:00Z",
            end: "2027-01-02T00:00:00Z"
        )
        let model = TrayModel()
        model.events = [winter]

        #expect(winter.dateKey == "2026-12-30")

        let dotted = Set(model.densityDotsByDay.keys)
        #expect(dotted.contains("2026-12-30"))
        #expect(!dotted.contains("2026-12-29"))
        #expect(!dotted.contains("2027-01-02"))

        let grouped = Set(model.groupedScheduleDays.map(\.id))
        #expect(grouped.contains("2026-12-30"))
        #expect(!grouped.contains("2026-12-29"))
    }

    @Test func aNewYearAllDayEventFilesOnTheFirstOfJanuary() throws {
        let newYear = try allDayEvent(
            id: "new-year",
            start: "2027-01-01T00:00:00Z",
            end: "2027-01-02T00:00:00Z"
        )
        let model = TrayModel()
        model.events = [newYear]

        let firstOfJanuary = try localDay(2027, 1, 1)
        let groups = model.groupedScheduleDays

        #expect(newYear.dateKey == "2027-01-01")
        #expect(model.densityDotsByDay.keys.sorted() == ["2027-01-01"])
        #expect(groups.map(\.id) == ["2027-01-01"])
        #expect(groups.first?.date == firstOfJanuary)
    }

    @Test func aTimedEventStaysOnTheMachinesDay() throws {
        // A 22:00 meeting belongs to the evening the user is having, which is the Mac's day in
        // every zone. Built from local fields, so the expectation holds wherever the suite runs.
        let day = try localDay(2026, 9, 18)
        let evening = timedEvent(id: "standup", on: day, hour: 22)
        let model = TrayModel()
        model.events = [evening]

        #expect(evening.dateKey == "2026-09-18")
        #expect(model.densityDotsByDay.keys.sorted() == ["2026-09-18"])
    }

    @Test func theWidgetAgendaFilesAnAllDayEventOnItsOwnDay() throws {
        let holiday = try cachedAllDay(
            id: "holiday",
            start: "2026-09-18T00:00:00Z",
            end: "2026-09-19T00:00:00Z"
        )
        let cache = WidgetCache(updatedAt: 0, events: [holiday], densityDots: [:])
        let now = try localDay(2026, 9, 10)

        let days = cache.byDay(from: now)
        let first = try #require(days.first)
        let itsDay = try localDay(2026, 9, 18)

        #expect(days.count == 1)
        #expect(first.day == itsDay)
        #expect(first.events.map(\.id) == ["holiday"])
        // The key the snapshot files the day's dots under, so the cell and the dot agree.
        #expect(WidgetFormat.dayKey(first.day) == "2026-09-18")
    }

    @Test func theWidgetAgendaKeepsTheNewYearBoundary() throws {
        let winter = try cachedAllDay(
            id: "winter",
            start: "2026-12-30T00:00:00Z",
            end: "2027-01-02T00:00:00Z"
        )
        let newYear = try cachedAllDay(
            id: "new-year",
            start: "2027-01-01T00:00:00Z",
            end: "2027-01-02T00:00:00Z"
        )
        let cache = WidgetCache(updatedAt: 0, events: [winter, newYear], densityDots: [:])
        let now = try localDay(2026, 12, 1)

        let days = cache.byDay(from: now)
        let keys = Set(days.map { WidgetFormat.dayKey($0.day) })
        let start = try localDay(2026, 12, 30)

        #expect(days.first?.day == start)
        #expect(keys.contains("2026-12-30"))
        #expect(keys.contains("2027-01-01"))
        #expect(!keys.contains("2026-12-29"))
    }

    @Test func theWidgetAgendaFilesANewYearAllDayEventOnTheFirstOfJanuary() throws {
        let newYear = try cachedAllDay(
            id: "new-year",
            start: "2027-01-01T00:00:00Z",
            end: "2027-01-02T00:00:00Z"
        )
        let cache = WidgetCache(updatedAt: 0, events: [newYear], densityDots: [:])
        let now = try localDay(2026, 12, 20)

        let days = cache.byDay(from: now)
        let first = try #require(days.first)
        let firstOfJanuary = try localDay(2027, 1, 1)

        #expect(days.count == 1)
        #expect(first.day == firstOfJanuary)
        #expect(WidgetFormat.dayKey(first.day) == "2027-01-01")
    }

    // MARK: - The widget's day filters

    /// A local wall-clock moment, so a case reads as the hour the user is in.
    private func localMoment(
        _ year: Int,
        _ month: Int,
        _ day: Int,
        _ hour: Int,
        _ minute: Int = 0
    ) throws -> Date {
        try #require(Calendar.current.date(
            from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute)
        ))
    }

    /// A timed entry in the widget's snapshot, built from the instants it starts and ends at.
    private func cachedTimed(id: String, start: Date, end: Date) -> CachedEvent {
        CachedEvent(
            id: id,
            accountId: "acc_1",
            calendarIds: ["cal_1"],
            title: "Standup",
            start: start.timeIntervalSince1970 * 1000,
            end: end.timeIntervalSince1970 * 1000,
            isAllDay: false
        )
    }

    /// The days a cache's agenda offers, as the `YYYY-MM-DD` keys its headings and cells read.
    private func dayKeys(_ cache: WidgetCache, from now: Date) -> [String] {
        cache.byDay(from: now).map { WidgetFormat.dayKey($0.day) }
    }

    /// The day an all-day entry is on, with the agenda read on it: it is today's, and it heads
    /// today. The baseline the cases below move one day off.
    @Test func anAllDayEntryHeadsItsOwnDayWhenThatDayIsToday() throws {
        let holiday = try cachedAllDay(
            id: "holiday",
            start: "2026-09-18T00:00:00Z",
            end: "2026-09-19T00:00:00Z"
        )
        let cache = WidgetCache(updatedAt: 0, events: [holiday], densityDots: [:])
        let now = try localMoment(2026, 9, 18, 9)

        #expect(dayKeys(cache, from: now) == ["2026-09-18"])
        #expect(cache.allDayToday(from: now).map(\.id) == ["holiday"])
    }

    /// An 18 September one-day entry read on 19 September is over, so it must not be carried
    /// onto today's heading. Its end instant is still ahead east of UTC — midnight UTC on the
    /// 19th is noon in Auckland — which is what let the instant comparison keep it and then
    /// clamp it to the 19th.
    @Test func anAllDayEntryWhoseOwnDateHasPassedIsNotFiledUnderToday() throws {
        let holiday = try cachedAllDay(
            id: "holiday",
            start: "2026-09-18T00:00:00Z",
            end: "2026-09-19T00:00:00Z"
        )
        let cache = WidgetCache(updatedAt: 0, events: [holiday], densityDots: [:])
        let now = try localMoment(2026, 9, 19, 9)

        #expect(cache.upcoming(from: now).isEmpty)
        #expect(dayKeys(cache, from: now).isEmpty)
        #expect(cache.allDayToday(from: now).isEmpty)
    }

    /// Tomorrow's all-day entry is not today's, at any hour of the evening before it. West of
    /// UTC the 18th's midnight-UTC start falls on the 17th's evening, which is what
    /// `startDate < tomorrow` let through as today's.
    @Test func allDayTodayDoesNotCountAnEntryThatStartsTomorrow() throws {
        let holiday = try cachedAllDay(
            id: "holiday",
            start: "2026-09-18T00:00:00Z",
            end: "2026-09-19T00:00:00Z"
        )
        let cache = WidgetCache(updatedAt: 0, events: [holiday], densityDots: [:])
        let now = try localMoment(2026, 9, 17, 22)

        #expect(cache.allDayToday(from: now).isEmpty)
        // Kept for the agenda all the same, on its own date.
        #expect(dayKeys(cache, from: now) == ["2026-09-18"])
    }

    /// A holiday running from the 17th to the 19th is on, on the 18th: it appears in the
    /// agenda and counts as today's. The filter must not drop it for having started yesterday,
    /// which is the direction an over-eager range test fails in.
    @Test func aRunningMultiDayAllDayEntryAppearsAndCountsOnItsMiddleDay() throws {
        let winter = try cachedAllDay(
            id: "winter",
            start: "2026-09-17T00:00:00Z",
            end: "2026-09-20T00:00:00Z"
        )
        let cache = WidgetCache(updatedAt: 0, events: [winter], densityDots: [:])
        let now = try localMoment(2026, 9, 18, 9)

        #expect(cache.upcoming(from: now).map(\.id) == ["winter"])
        // One day, its own: not a second copy under today's heading.
        #expect(dayKeys(cache, from: now).count == 1)
        #expect(cache.byDay(from: now).flatMap(\.events).map(\.id) == ["winter"])
        #expect(cache.allDayToday(from: now).map(\.id) == ["winter"])
    }

    /// And that entry is filed on its own date, the 17th, rather than clamped onto today. An
    /// all-day entry is a range of dates, not an instant that happens to be running, so moving
    /// it to today's heading is the same fault that put the 18th's entry under the 19th.
    @Test func aRunningMultiDayAllDayEntryIsFiledOnItsOwnDateNotOnToday() throws {
        let winter = try cachedAllDay(
            id: "winter",
            start: "2026-09-17T00:00:00Z",
            end: "2026-09-20T00:00:00Z"
        )
        let cache = WidgetCache(updatedAt: 0, events: [winter], densityDots: [:])
        let now = try localMoment(2026, 9, 18, 9)
        let itsOwnDay = try localDay(2026, 9, 17)

        let first = try #require(cache.byDay(from: now).first)

        #expect(first.day == itsOwnDay)
        #expect(WidgetFormat.dayKey(first.day) == "2026-09-17")
    }

    /// A one-day entry on the 16th, read on the 18th, is over in every zone.
    @Test func aPastOneDayAllDayEntryIsGoneToday() throws {
        let holiday = try cachedAllDay(
            id: "holiday",
            start: "2026-09-16T00:00:00Z",
            end: "2026-09-17T00:00:00Z"
        )
        let cache = WidgetCache(updatedAt: 0, events: [holiday], densityDots: [:])
        let now = try localMoment(2026, 9, 18, 9)

        #expect(cache.upcoming(from: now).isEmpty)
        #expect(dayKeys(cache, from: now).isEmpty)
        #expect(cache.allDayToday(from: now).isEmpty)
    }

    /// The same for the 17th's entry read on the 18th, which is where an instant comparison
    /// still shows it: east of UTC a 17th one-day entry ends at noon on the 18th, so it was
    /// kept and clamped onto today's heading.
    @Test func aOneDayAllDayEntryIsGoneTheMorningAfterItsOwnDate() throws {
        let holiday = try cachedAllDay(
            id: "holiday",
            start: "2026-09-17T00:00:00Z",
            end: "2026-09-18T00:00:00Z"
        )
        let cache = WidgetCache(updatedAt: 0, events: [holiday], densityDots: [:])
        let now = try localMoment(2026, 9, 18, 9)

        #expect(cache.upcoming(from: now).isEmpty)
        #expect(dayKeys(cache, from: now).isEmpty)
        #expect(cache.allDayToday(from: now).isEmpty)
    }

    /// The end is exclusive, so the 17th-to-19th entry's last covered date is the 19th: it
    /// counts on the 19th and is gone on the 20th.
    @Test func anAllDayEntryDoesNotCountAfterItsLastCoveredDate() throws {
        let winter = try cachedAllDay(
            id: "winter",
            start: "2026-09-17T00:00:00Z",
            end: "2026-09-20T00:00:00Z"
        )
        let cache = WidgetCache(updatedAt: 0, events: [winter], densityDots: [:])

        let itsLastCoveredDay = try localMoment(2026, 9, 19, 9)
        #expect(cache.allDayToday(from: itsLastCoveredDay).map(\.id) == ["winter"])
        #expect(cache.byDay(from: itsLastCoveredDay).flatMap(\.events).map(\.id) == ["winter"])

        let theDayAfter = try localMoment(2026, 9, 20, 9)
        #expect(cache.upcoming(from: theDayAfter).isEmpty)
        #expect(dayKeys(cache, from: theDayAfter).isEmpty)
        #expect(cache.allDayToday(from: theDayAfter).isEmpty)
    }

    /// A timed entry keeps the Mac's day at whatever hour it sits: one at 23:30 belongs to the
    /// day the user is having, and one at 00:30 belongs to the day that has just begun.
    @Test func aTimedEntryAroundMidnightStaysOnTheMachinesDay() throws {
        let eveningStart = try localMoment(2026, 9, 18, 23, 30)
        let eveningEnd = try localMoment(2026, 9, 19, 0, 30)
        let midnightStart = try localMoment(2026, 9, 19, 0, 30)
        let midnightEnd = try localMoment(2026, 9, 19, 1, 30)
        let events = [
            cachedTimed(id: "evening", start: eveningStart, end: eveningEnd),
            cachedTimed(id: "after-midnight", start: midnightStart, end: midnightEnd),
        ]
        let cache = WidgetCache(updatedAt: 0, events: events, densityDots: [:])
        let now = try localMoment(2026, 9, 18, 9)

        #expect(dayKeys(cache, from: now) == ["2026-09-18", "2026-09-19"])
        #expect(cache.byDay(from: now).first?.events.map(\.id) == ["evening"])
        #expect(cache.byDay(from: now).last?.events.map(\.id) == ["after-midnight"])
        // Neither is all-day, so neither is an all-day entry on today.
        #expect(cache.allDayToday(from: now).isEmpty)
    }

    /// A timed entry is an instant, so its day is the Mac's day for that instant and not the
    /// date its UTC fields spell. The same instant is the 19th in Auckland and the 18th in New
    /// York; this expectation is written the way both zones agree on.
    @Test func aTimedEntryIsReadOnTheMachinesClockNotItsUtcDate() throws {
        let start = try instant("2026-09-18T22:00:00Z")
        let call = cachedTimed(id: "call", start: start, end: start.addingTimeInterval(1800))
        let cache = WidgetCache(updatedAt: 0, events: [call], densityDots: [:])
        let now = try localMoment(2026, 9, 18, 9)
        let itsDay = Calendar.current.startOfDay(for: start)

        let first = try #require(cache.byDay(from: now).first)

        #expect(first.day == itsDay)
        #expect(first.events.map(\.id) == ["call"])
    }

    /// The Month widgets' TODAY panel is a view of today's date, not of `byDay`'s first group: a
    /// still-running all-day entry is filed on its own earlier date, so reading the first group
    /// would show the entry and drop today's meeting.
    @Test func theMonthPanelShowsARunningAllDayEntryAndTodaysMeeting() throws {
        let winter = try cachedAllDay(
            id: "winter",
            start: "2026-09-17T00:00:00Z",
            end: "2026-09-20T00:00:00Z"
        )
        let meetingStart = try localMoment(2026, 9, 18, 10)
        let meetingEnd = try localMoment(2026, 9, 18, 11)
        let meeting = cachedTimed(id: "standup", start: meetingStart, end: meetingEnd)
        let cache = WidgetCache(updatedAt: 0, events: [winter, meeting], densityDots: [:])
        let now = try localMoment(2026, 9, 18, 9)
        let itsOwnDay = try localDay(2026, 9, 17)

        // What the panel must not read: the agenda's first group is the running entry's own date.
        #expect(cache.byDay(from: now).first?.day == itsOwnDay)

        let panel = cache.todayEvents(from: now)
        #expect(panel.map(\.id) == ["winter", "standup"])
        #expect(Set(panel.map(\.id)).count == panel.count)
    }

    /// A one-day all-day entry on today is in both the all-day set and today's group, and must
    /// show once.
    @Test func theMonthPanelShowsAOneDayAllDayEntryTodayOnce() throws {
        let holiday = try cachedAllDay(
            id: "holiday",
            start: "2026-09-18T00:00:00Z",
            end: "2026-09-19T00:00:00Z"
        )
        let cache = WidgetCache(updatedAt: 0, events: [holiday], densityDots: [:])
        let now = try localMoment(2026, 9, 18, 9)

        #expect(cache.todayEvents(from: now).map(\.id) == ["holiday"])
    }

    /// A one-day entry on the 16th, read on the 18th, is over and must not reach the panel.
    @Test func theMonthPanelDropsAPastOneDayAllDayEntry() throws {
        let holiday = try cachedAllDay(
            id: "holiday",
            start: "2026-09-16T00:00:00Z",
            end: "2026-09-17T00:00:00Z"
        )
        let cache = WidgetCache(updatedAt: 0, events: [holiday], densityDots: [:])
        let now = try localMoment(2026, 9, 18, 9)

        #expect(cache.todayEvents(from: now).isEmpty)
    }

    /// The agenda is chronological even when a still-running all-day entry is filed on an earlier
    /// date than a later-starting timed entry. The sender orders by instant, and west of UTC an
    /// all-day midnight-UTC start is the previous evening, which put the 18th above the 17th.
    @Test func theAgendaOrdersItsDaysChronologicallyWhenAnAllDayEntryRunsOn() throws {
        let holiday = try cachedAllDay(
            id: "holiday",
            start: "2026-09-18T00:00:00Z",
            end: "2026-09-19T00:00:00Z"
        )
        let meeting = try cachedTimed(
            id: "meeting",
            start: localMoment(2026, 9, 17, 23),
            end: localMoment(2026, 9, 17, 23, 30)
        )
        let cache = WidgetCache(updatedAt: 0, events: [holiday, meeting], densityDots: [:])
        let now = try localMoment(2026, 9, 17, 22)

        #expect(dayKeys(cache, from: now) == ["2026-09-17", "2026-09-18"])
    }

    /// The popover feed is ordered by day for the same reason: a running all-day entry is filed on
    /// its own earlier date, so arrival order cannot be trusted for the headings.
    @Test func thePopoverAgendaOrdersItsDaysChronologicallyWhenAnAllDayEntryRunsOn() throws {
        let holiday = try allDayEvent(
            id: "holiday",
            start: "2026-09-18T00:00:00Z",
            end: "2026-09-19T00:00:00Z"
        )
        let meeting = try timedEvent(id: "meeting", on: localDay(2026, 9, 17), hour: 23)
        let model = TrayModel()
        model.events = [holiday, meeting]

        let days = model.groupedScheduleDays.map { WidgetFormat.dayKey($0.date) }
        #expect(days == ["2026-09-17", "2026-09-18"])
    }
}
