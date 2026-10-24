import Combine
import Foundation
@testable import MagicalHelperLib
import Testing

@Suite("TrayModel nextEvent Tests")
@MainActor
struct TrayModelTests {
    private let calendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        return cal
    }()

    private var fixedNow: Date {
        // 2026-09-24 10:00:00 UTC
        Date(timeIntervalSince1970: 1_790_244_000)
    }

    private func makeEvent(
        id: String,
        startOffsetMinutes: Int,
        durationMinutes: Int = 30,
        isAllDay: Bool = false,
        isCompleted: Bool = false
    ) -> TrayEvent {
        let start = fixedNow.addingTimeInterval(Double(startOffsetMinutes) * 60)
        let end = start.addingTimeInterval(Double(durationMinutes) * 60)
        let dict: [String: Any] = [
            "id": id,
            "accountId": "acc_1",
            "summary": "Event \(id)",
            "startTime": start.timeIntervalSince1970 * 1000,
            "endTime": end.timeIntervalSince1970 * 1000,
            "isAllDay": isAllDay,
            "isCompleted": isCompleted,
            "calendarIds": ["cal_1"],
        ]
        return TrayEvent(from: dict)
    }

    @Test func rule1SkipsAllDayEventsAndCompletedTasks() {
        let model = TrayModel()
        let allDay = makeEvent(id: "allday", startOffsetMinutes: 10, isAllDay: true)
        let completed = makeEvent(id: "completed", startOffsetMinutes: 15, isCompleted: true)
        let normal = makeEvent(id: "normal", startOffsetMinutes: 30)

        model.events = [allDay, completed, normal]

        let next = model.nextEvent(within: nil, now: fixedNow, calendar: calendar)
        #expect(next?.event.id == "normal")
        #expect(next?.minutesUntil == 30)
    }

    @Test func rule2EventUnderWayReturnsZeroMinutes() {
        let model = TrayModel()
        // Started 10 mins ago, finishes in 20 mins
        let inProgress = makeEvent(id: "current", startOffsetMinutes: -10, durationMinutes: 30)
        let upcoming = makeEvent(id: "later", startOffsetMinutes: 45)

        model.events = [inProgress, upcoming]

        let next = model.nextEvent(within: nil, now: fixedNow, calendar: calendar)
        #expect(next?.event.id == "current")
        #expect(next?.minutesUntil == 0)
    }

    @Test func rule3UpcomingEventTodayReturnsMinutesUntil() {
        let model = TrayModel()
        let upcoming = makeEvent(id: "soon", startOffsetMinutes: 45)

        model.events = [upcoming]

        let next = model.nextEvent(within: 60, now: fixedNow, calendar: calendar)
        #expect(next?.event.id == "soon")
        #expect(next?.minutesUntil == 45)
    }

    @Test func rule4FiltersPastEventsEventsBeyondThresholdAndTomorrowEvents() {
        let model = TrayModel()
        // Past event
        let past = makeEvent(id: "past", startOffsetMinutes: -60, durationMinutes: 30)
        // Event beyond 60m threshold (90 mins away)
        let beyondLimit = makeEvent(id: "far", startOffsetMinutes: 90)
        // Event tomorrow (18 hours away from 10:00 UTC)
        let tomorrow = makeEvent(id: "tomorrow", startOffsetMinutes: 18 * 60)

        model.events = [past, beyondLimit, tomorrow]

        // Within 60 minutes limit: should match nothing
        let nextLimited = model.nextEvent(within: 60, now: fixedNow, calendar: calendar)
        #expect(nextLimited == nil)

        // Without minute limit: should match 'far' today, but not 'past' or 'tomorrow'
        let nextToday = model.nextEvent(within: nil, now: fixedNow, calendar: calendar)
        #expect(nextToday?.event.id == "far")
        #expect(nextToday?.minutesUntil == 90)
    }

    @Test func eventStartingExactlyNowIsUnderWay() {
        let model = TrayModel()
        let startingNow = makeEvent(id: "now_evt", startOffsetMinutes: 0, durationMinutes: 30)
        model.events = [startingNow]

        let next = model.nextEvent(within: nil, now: fixedNow, calendar: calendar)
        #expect(next?.event.id == "now_evt")
        #expect(next?.minutesUntil == 0)
    }

    @Test func eventEndingExactlyNowIsFinishedAndSkipped() {
        let model = TrayModel()
        let endingNow = makeEvent(id: "ended", startOffsetMinutes: -30, durationMinutes: 30)
        let later = makeEvent(id: "later", startOffsetMinutes: 20)
        model.events = [endingNow, later]

        let next = model.nextEvent(within: nil, now: fixedNow, calendar: calendar)
        #expect(next?.event.id == "later")
        #expect(next?.minutesUntil == 20)
    }

    @Test func disabledCalendarHidesEventFromNextEvent() {
        let model = TrayModel()
        let hiddenEvent = makeEvent(id: "hidden", startOffsetMinutes: 15)

        // Make visibleEvent on cal_2
        let visibleDict: [String: Any] = [
            "id": "visible",
            "accountId": "acc_1",
            "summary": "Visible Event",
            "startTime": fixedNow.addingTimeInterval(30 * 60).timeIntervalSince1970 * 1000,
            "endTime": fixedNow.addingTimeInterval(60 * 60).timeIntervalSince1970 * 1000,
            "calendarIds": ["cal_2"],
        ]
        model.events = [hiddenEvent, TrayEvent(from: visibleDict)]
        model.disabledCalendars = [CalendarRef(accountId: "acc_1", calendarId: "cal_1")]

        let next = model.nextEvent(within: nil, now: fixedNow, calendar: calendar)
        #expect(next?.event.id == "visible")
        #expect(next?.minutesUntil == 30)
    }

    @Test func aSharedCalendarIdHidesPerAccount() {
        let model = TrayModel()
        // Google gives Birthdays, Tasks and each locale's holidays the same id in every
        // account, so a filter keyed on the id alone would hide both accounts' copies.
        let shared = "en-gb.uk#holiday@group.v.calendar.google.com"
        func holiday(id: String, accountId: String) -> TrayEvent {
            TrayEvent(from: [
                "id": id,
                "accountId": accountId,
                "summary": "Daylight Saving Time ends",
                "startTime": fixedNow.addingTimeInterval(30 * 60).timeIntervalSince1970 * 1000,
                "endTime": fixedNow.addingTimeInterval(60 * 60).timeIntervalSince1970 * 1000,
                "calendarIds": [shared],
            ])
        }

        model.events = [
            holiday(id: "dst_work", accountId: "acc_work"),
            holiday(id: "dst_personal", accountId: "acc_personal"),
        ]
        model.disabledCalendars = [CalendarRef(accountId: "acc_work", calendarId: shared)]

        #expect(model.filteredEvents.map(\.id) == ["dst_personal"])
    }

    @Test func heroLimitOmitsEventsBeyondFourHours() {
        let model = TrayModel()
        // 5 hours away
        let fiveHoursAway = makeEvent(id: "far_meeting", startOffsetMinutes: 300)
        model.events = [fiveHoursAway]

        // Status item (within: nil) still sees it today
        let statusItemNext = model.nextEvent(within: nil, now: fixedNow, calendar: calendar)
        #expect(statusItemNext?.event.id == "far_meeting")

        // Hero card (within: 240) omits it
        let heroNext = model.nextEvent(within: 240, now: fixedNow, calendar: calendar)
        #expect(heroNext == nil)
    }

    @Test func eventStartingInUnderOneMinuteReturnsZeroMinutes() {
        let model = TrayModel()
        let dict: [String: Any] = [
            "id": "starting_in_30s",
            "accountId": "acc_1",
            "summary": "Imminent Meeting",
            "startTime": fixedNow.addingTimeInterval(30).timeIntervalSince1970 * 1000,
            "endTime": fixedNow.addingTimeInterval(30 * 60).timeIntervalSince1970 * 1000,
            "calendarIds": ["cal_1"],
        ]
        model.events = [TrayEvent(from: dict)]

        let next = model.nextEvent(within: nil, now: fixedNow, calendar: calendar)
        #expect(next?.event.id == "starting_in_30s")
        #expect(next?.minutesUntil == 0)
    }

    @Test func unsortedEventsAreEvaluatedInChronologicalOrder() {
        let model = TrayModel()
        let later = makeEvent(id: "later", startOffsetMinutes: 90)
        let sooner = makeEvent(id: "sooner", startOffsetMinutes: 15)
        // Supply out of chronological order
        model.events = [later, sooner]

        let next = model.nextEvent(within: nil, now: fixedNow, calendar: calendar)
        #expect(next?.event.id == "sooner")
        #expect(next?.minutesUntil == 15)
    }

    @Test func updatesFromRealFixturePayload() throws {
        let thisFile = URL(fileURLWithPath: #filePath)
        let fixtureURL = thisFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("tests/fixtures/tray-update.json")

        let data = try Data(contentsOf: fixtureURL)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            Issue.record("Failed to parse fixture as JSON object")
            return
        }

        let model = TrayModel()
        model.update(from: json)

        #expect(model.accounts.count == 2)
        #expect(model.accounts[0].id == "account_work")
        #expect(model.accounts[0].name == "Work")
        #expect(model.accounts[0].unreadCount == 1)
        #expect(model.accounts[1].id == "account_personal")
        #expect(model.accounts[1].unreadCount == 0)

        #expect(model.explicitCalendars.count == 5)
        #expect(model.disabledCalendars.count == 1)

        #expect(model.events.count == 8)
        let rsvpInvite = model.events.first { $0.id == "evt_invite_needs_rsvp_003" }
        #expect(rsvpInvite?.myResponseStatus == 0)

        let taskIncomplete = model.events.first { $0.id == "task_review_pr_004" }
        #expect(taskIncomplete?.eventType == 9)
        #expect(taskIncomplete?.isCompleted == false)

        let taskComplete = model.events.first { $0.id == "task_done_005" }
        #expect(taskComplete?.eventType == 9)
        #expect(taskComplete?.isCompleted == true)

        let focusTime = model.events.first { $0.id == "focus_time_006" }
        #expect(focusTime?.eventType == 7)

        let workingLoc = model.events.first { $0.id == "working_location_007" }
        #expect(workingLoc?.eventType == 10)

        let birthday = model.events.first { $0.id == "birthday_008" }
        #expect(birthday?.eventType == 13)

        // Optional fields on TrayEvent
        let firstEvent = try #require(model.events.first { $0.id == "evt_standup_001" })
        #expect(firstEvent.conferenceUrl == "https://meet.google.com/abc-defg-hij")
        #expect(firstEvent.location == "Meeting Room 3B")
        #expect(firstEvent.organizerEmail == "lead@example.com")
        #expect(firstEvent.webUrl?.contains("REDACTED_EID_001") == true)

        #expect(model.selectedAccountId == "account_work")
        #expect(model.isCalendarCollapsed == false)
        #expect(model.isOffline == false)
        #expect(model.isRestricted == false)
        #expect(model.menuBarDisplayMode == "iconOnly")
        #expect(model.showMenuBarAccountColor == true)
        #expect(model.showCompletedTasks == true)

        // lastSyncedAt parses from both Double and Int millisecond representations
        var jsonWithSync = json
        jsonWithSync["lastSyncedAt"] = 1_789_750_800_000.0
        model.update(from: jsonWithSync)
        #expect(model.lastSyncedAt == Date(timeIntervalSince1970: 1_789_750_800))

        jsonWithSync["lastSyncedAt"] = 1_789_750_800_000 as Int
        model.update(from: jsonWithSync)
        #expect(model.lastSyncedAt == Date(timeIntervalSince1970: 1_789_750_800))

        // A tenant policy block is its own state, not the offline or sign-in one.
        var jsonRestricted = json
        jsonRestricted["isRestricted"] = true
        model.update(from: jsonRestricted)
        #expect(model.isRestricted == true)
        #expect(model.isOffline == false)
    }

    @Test func prepareForPresentationResetsSelectionAndMonthToToday() {
        let model = TrayModel()
        let pastDate = Date(timeIntervalSince1970: 1_000_000_000)
        model.selectedDate = pastDate
        model.displayedMonthDate = pastDate
        model.requestedScrollDate = pastDate

        model.prepareForPresentation()

        let cal = Calendar.current
        #expect(cal.isDateInToday(model.selectedDate))
        #expect(cal.isDate(model.displayedMonthDate, equalTo: Date(), toGranularity: .month))
        #expect(model.requestedScrollDate.map { cal.isDateInToday($0) } == true)
    }

    @Test func backToBackMeetingsSwitchPreciselyAtBoundary() {
        let model = TrayModel()
        // Meeting A: 10:00–10:30 (starts 30m ago, ends now)
        let meetingA = makeEvent(id: "meeting_a", startOffsetMinutes: -30, durationMinutes: 30)
        // Meeting B: 10:30–11:00 (starts now, ends in 30m)
        let meetingB = makeEvent(id: "meeting_b", startOffsetMinutes: 0, durationMinutes: 30)
        model.events = [meetingA, meetingB]

        // 1 second before 10:30: Meeting A is still active
        let justBeforeBoundary = fixedNow.addingTimeInterval(-1)
        let nextBefore = model.nextEvent(within: nil, now: justBeforeBoundary, calendar: calendar)
        #expect(nextBefore?.event.id == "meeting_a")
        #expect(nextBefore?.minutesUntil == 0)

        // Precisely at 10:30: Meeting A has ended, Meeting B immediately takes over
        let nextAtBoundary = model.nextEvent(within: nil, now: fixedNow, calendar: calendar)
        #expect(nextAtBoundary?.event.id == "meeting_b")
        #expect(nextAtBoundary?.minutesUntil == 0)
    }

    @Test func overlappingActiveMeetingsPicksMostRecentlyStarted() {
        let model = TrayModel()
        // Meeting A: 10:00–10:35 (still running, scheduled to end 5m late)
        let meetingA = makeEvent(id: "meeting_a", startOffsetMinutes: -30, durationMinutes: 35)
        // Meeting B: 10:30–11:00 (starting now)
        let meetingB = makeEvent(id: "meeting_b", startOffsetMinutes: 0, durationMinutes: 30)
        model.events = [meetingA, meetingB]

        // At 10:30, both are active, but Meeting B started most recently so it takes priority
        let next = model.nextEvent(within: nil, now: fixedNow, calendar: calendar)
        #expect(next?.event.id == "meeting_b")
        #expect(next?.minutesUntil == 0)
    }

    @Test func nextScheduleTransitionDateCalculatesExactNextStartOrEndTime() {
        let model = TrayModel()
        let meetingA = makeEvent(id: "meeting_a", startOffsetMinutes: -30, durationMinutes: 30)
        let meetingB = makeEvent(id: "meeting_b", startOffsetMinutes: 0, durationMinutes: 30)
        model.events = [meetingA, meetingB]

        // At 10:15 (-15m), next transition is 10:30 (when Meeting A ends and Meeting B starts)
        let at1015 = fixedNow.addingTimeInterval(-15 * 60)
        let transition1 = model.nextScheduleTransitionDate(after: at1015)
        #expect(transition1 == fixedNow)

        // At 10:30 (fixedNow), next transition is 11:00 (when Meeting B ends)
        let transition2 = model.nextScheduleTransitionDate(after: fixedNow)
        #expect(transition2 == fixedNow.addingTimeInterval(30 * 60))
    }

    @Test func refreshNowEmitsObjectWillChange() {
        let model = TrayModel()
        var emitted = false
        let cancellable = model.objectWillChange.sink { _ in
            emitted = true
        }
        model.refreshNow()
        #expect(emitted == true)
        _ = cancellable
    }

    @Test func nextScheduleTransitionDateIgnoresCompletedTasksAndAllDayEvents() {
        let model = TrayModel()
        let allDay = makeEvent(id: "all_day", startOffsetMinutes: 10, isAllDay: true)
        let completed = makeEvent(id: "completed", startOffsetMinutes: 15, isCompleted: true)
        let timed = makeEvent(id: "timed", startOffsetMinutes: 30, durationMinutes: 30)
        model.events = [allDay, completed, timed]

        let nextTransition = model.nextScheduleTransitionDate(after: fixedNow)
        // Should ignore allDay (+10m) and completed (+15m), and pick timed (+30m)
        #expect(nextTransition == fixedNow.addingTimeInterval(30 * 60))
    }

    @Test func activeAndUpcomingEventsDistinguishCorrectly() {
        let model = TrayModel()
        let meetingA = makeEvent(id: "meeting_a", startOffsetMinutes: -30, durationMinutes: 30)
        let meetingB = makeEvent(id: "meeting_b", startOffsetMinutes: 0, durationMinutes: 30)
        model.events = [meetingA, meetingB]

        // At 10:15 (midway through Meeting A)
        let midway = fixedNow.addingTimeInterval(-15 * 60)
        #expect(model.activeEvent(now: midway)?.id == "meeting_a")
        #expect(model.upcomingEvent(within: nil, now: midway)?.event.id == "meeting_b")
        #expect(model.upcomingEvent(within: nil, now: midway)?.minutesUntil == 15)

        // At 10:30 (Meeting A ended, Meeting B active)
        #expect(model.activeEvent(now: fixedNow)?.id == "meeting_b")
        #expect(model.upcomingEvent(within: nil, now: fixedNow) == nil)
    }
}
