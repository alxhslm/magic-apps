import Foundation
import MagicalHelperLib
@testable import MagicalNative
import Testing

@MainActor
@Suite("SidebarModel Tests")
struct SidebarModelTests {
    @Test func initialState() {
        let model = SidebarModel()
        #expect(model.viewMode == .day)
        #expect(model.isVisible)
        #expect(model.currentWeekDays.count == 7)
    }

    @Test func setViewModeWeek() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let anchor = try #require(df.date(from: "2026-10-14"))

        model.setViewMode(.week, anchor: anchor)

        #expect(model.viewMode == .week)
        #expect(model.currentWeekDays.count == 7)

        // Selected date should match anchor
        let selectedStr = df.string(from: model.selectedDate)
        #expect(selectedStr == "2026-10-14")

        // Exactly one day in currentWeekDays should be selected
        let selectedDays = model.currentWeekDays.filter(\.isSelected)
        #expect(selectedDays.count == 1)
        #expect(selectedDays.first?.id == "2026-10-14")
    }

    @Test func setViewModeFourDay() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let anchor = try #require(df.date(from: "2026-10-14"))

        model.setViewMode(.fourDay, anchor: anchor)

        #expect(model.viewMode == .fourDay)
        #expect(model.currentWeekDays.count == 4)
        #expect(model.currentWeekDays[0].id == "2026-10-14")
        #expect(model.currentWeekDays[1].id == "2026-10-15")
        #expect(model.currentWeekDays[2].id == "2026-10-16")
        #expect(model.currentWeekDays[3].id == "2026-10-17")

        let selectedDays = model.currentWeekDays.filter(\.isSelected)
        #expect(selectedDays.count == 1)
        #expect(selectedDays.first?.id == "2026-10-14")
    }

    @Test func setViewModeDay() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let anchor = try #require(df.date(from: "2026-11-05"))

        model.setViewMode(.day, anchor: anchor)

        #expect(model.viewMode == .day)
        #expect(df.string(from: model.selectedDate) == "2026-11-05")
    }

    @Test func selectDateAdvancesWeekIfOutsideCurrent() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current

        let date1 = try #require(df.date(from: "2026-10-14"))
        model.selectDate(date1)
        #expect(model.currentWeekDays.contains { $0.id == "2026-10-14" })

        let date2 = try #require(df.date(from: "2026-10-28"))
        model.selectDate(date2)
        #expect(model.currentWeekDays.contains { $0.id == "2026-10-28" })
        #expect(!model.currentWeekDays.contains { $0.id == "2026-10-14" })
    }

    @Test func updateDataPopulatesEventsAndDensityDots() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current

        let targetDate = try #require(df.date(from: "2026-10-14"))
        let targetStartMs = Int(targetDate.timeIntervalSince1970 * 1000)
        let targetEndMs = targetStartMs + 3_600_000

        let json = """
        {
            "accounts": [
                { "id": "acc_1", "name": "Work", "color": "#1a73e8", "email": "work@example.com" }
            ],
            "calendars": [
                { "id": "work@example.com", "accountId": "acc_1", "name": "Work", "colorHex": "#1a73e8" }
            ],
            "events": [
                {
                    "id": "evt_test_1",
                    "accountId": "acc_1",
                    "calendarIds": ["work@example.com"],
                    "calendarName": "Work",
                    "summary": "Product Review",
                    "startTime": \(targetStartMs),
                    "endTime": \(targetEndMs),
                    "isAllDay": false,
                    "colorHex": "#1a73e8"
                }
            ]
        }
        """

        SidebarManager.shared.updateData(json: json)
        model.selectDate(targetDate)

        let events = model.selectedDayEvents
        #expect(events.count == 1)
        #expect(events.first?.summary == "Product Review")

        // Week pills should have dots
        let matchingPill = model.currentWeekDays.first { $0.id == "2026-10-14" }
        #expect(matchingPill != nil)
        let dots = try #require(matchingPill?.dots)
        #expect(!dots.isEmpty)
    }

    @Test func transparencyState() {
        let model = SidebarModel()
        #expect(model.transparentBackground)
        #expect(model.isDarkMode)

        SidebarManager.shared.setTransparency(false, isDark: false)
        #expect(!SidebarModel.shared.transparentBackground)
        #expect(!SidebarModel.shared.isDarkMode)

        SidebarManager.shared.setTransparency(true, isDark: true)
        #expect(SidebarModel.shared.transparentBackground)
        #expect(SidebarModel.shared.isDarkMode)
    }

    @Test func monthNavigationAndCollapse() throws {
        let model = SidebarModel()
        let cal = Calendar.current
        let initialMonth = model.displayedMonthDate

        model.previousMonth()
        let prevExpected = try #require(cal.date(byAdding: .month, value: -1, to: initialMonth))
        #expect(cal.isDate(model.displayedMonthDate, equalTo: prevExpected, toGranularity: .month))

        model.nextMonth()
        #expect(cal.isDate(model.displayedMonthDate, equalTo: initialMonth, toGranularity: .month))

        #expect(!model.isCalendarCollapsed)
        model.toggleCalendarCollapse()
        #expect(model.isCalendarCollapsed)
        model.toggleCalendarCollapse()
        #expect(!model.isCalendarCollapsed)
    }

    @Test func selectingAdjacentMonthDayKeepsDisplayedMonthOnGCal() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let november = try #require(df.date(from: "2026-11-15"))
        let decemberFirst = try #require(df.date(from: "2026-12-01"))

        model.setViewMode(.fantastical, anchor: november, timeframe: "month")
        model.selectDate(decemberFirst)

        // The agenda follows the selection, but the grid stays on the month Google
        // Calendar is showing.
        #expect(df.string(from: model.selectedDate) == "2026-12-01")
        let cal = Calendar.current
        #expect(cal.component(.month, from: model.displayedMonthDate) == 11)
    }

    @Test func monthGridRangeCoversTheDaysTheMiniMonthDraws() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let november = try #require(df.date(from: "2026-11-15"))

        // A Monday-first grid, which is what Google Calendar does for a Monday region.
        model.setViewMode(.fantastical, anchor: november, timeframe: "month", firstWeekday: 2)

        // November 2026 starts on a Sunday, so a Monday-first grid leads with six October
        // days and trails with six December ones.
        let range = try #require(model.displayedMonthGridRange)
        #expect(df.string(from: range.lowerBound) == "2026-10-26")
        #expect(df.string(from: range.upperBound) == "2026-12-06")
        #expect(model.isMonthTimeframe)
    }

    @Test func monthGridRangeFollowsASundayFirstWeek() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let november = try #require(df.date(from: "2026-11-15"))

        // The same month on Google's Sunday-first setting: the 1st is a Sunday, so the grid
        // needs no lead padding at all and trails five days into December.
        model.setViewMode(.fantastical, anchor: november, timeframe: "month", firstWeekday: 1)

        let range = try #require(model.displayedMonthGridRange)
        #expect(df.string(from: range.lowerBound) == "2026-11-01")
        #expect(df.string(from: range.upperBound) == "2026-12-05")
    }

    @Test func monthAgendaIsBoundedToTheGridDays() throws {
        let tray = TrayModel()
        let model = SidebarModel(trayModel: tray)
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let cal = Calendar.current
        let november = try #require(df.date(from: "2026-11-15"))

        func event(id: String, on dayString: String) throws -> [String: Any] {
            let day = try #require(df.date(from: dayString))
            let start = try #require(cal.date(byAdding: .hour, value: 12, to: day))
            return [
                "id": id,
                "accountId": "acc_1",
                "summary": id,
                "startTime": start.timeIntervalSince1970 * 1000,
                "endTime": start.addingTimeInterval(3600).timeIntervalSince1970 * 1000,
                "isAllDay": false,
                "calendarIds": ["cal_1"],
            ]
        }

        // 3 December is in the grid's trailing week; 10 December is not.
        try tray.update(from: [
            "events": [
                event(id: "inside", on: "2026-12-03"),
                event(id: "outside", on: "2026-12-10"),
            ],
        ])

        func dayGroupDates(_ items: [TrayModel.ScheduleFeedItem]) -> [String] {
            items.compactMap { item in
                guard case let .day(group) = item else { return nil }
                return df.string(from: group.date)
            }
        }

        model.setViewMode(.fantastical, anchor: november, timeframe: "month", firstWeekday: 2)
        let monthDays = dayGroupDates(model.visibleScheduleFeedItems)
        #expect(monthDays.contains("2026-12-03"))
        #expect(!monthDays.contains("2026-12-10"))

        // Schedule view keeps the continuous agenda, which is the whole point of it.
        model.setViewMode(.fantastical, anchor: november, timeframe: "schedule")
        let scheduleDays = dayGroupDates(model.visibleScheduleFeedItems)
        #expect(scheduleDays.contains("2026-12-03"))
        #expect(scheduleDays.contains("2026-12-10"))
    }

    @Test func hoveringAnAgendaRowMovesTheHighlightNotTheScroll() throws {
        let model = SidebarModel(trayModel: TrayModel())
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let november = try #require(df.date(from: "2026-11-15"))
        let december = try #require(df.date(from: "2026-12-03"))

        model.setViewMode(.fantastical, anchor: november, timeframe: "schedule")
        model.hoverScheduleDate(december)

        #expect(df.string(from: model.highlightedDate) == "2026-12-03")
        let cal = Calendar.current
        #expect(cal.component(.month, from: model.displayedMonthDate) == 12)
        // Hovering is not a selection, so the agenda must not scroll under the pointer.
        #expect(model.requestedScrollDate.map { df.string(from: $0) } == "2026-11-15")

        model.hoverScheduleDate(nil)
        #expect(df.string(from: model.highlightedDate) == "2026-11-15")
    }

    @Test func scrollingTheAgendaMovesTheHighlightWithoutRequestingAScroll() throws {
        let model = SidebarModel(trayModel: TrayModel())
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let november = try #require(df.date(from: "2026-11-15"))
        let december = try #require(df.date(from: "2026-12-03"))

        model.setViewMode(.fantastical, anchor: november, timeframe: "schedule")
        model.agendaDidScroll(to: december)

        #expect(df.string(from: model.selectedDate) == "2026-12-03")
        #expect(df.string(from: model.highlightedDate) == "2026-12-03")
        #expect(model.requestedScrollDate.map { df.string(from: $0) } == "2026-11-15")
        let cal = Calendar.current
        #expect(cal.component(.month, from: model.displayedMonthDate) == 12)
    }

    @Test func clickingADateStillRequestsTheScroll() throws {
        let model = SidebarModel(trayModel: TrayModel())
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let december = try #require(df.date(from: "2026-12-01"))

        model.selectDate(december)

        #expect(model.requestedScrollDate.map { df.string(from: $0) } == "2026-12-01")
    }

    @Test func headerSyncReturnsToGCalRangeNotToday() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let november = try #require(df.date(from: "2026-11-15"))
        let december = try #require(df.date(from: "2026-12-20"))

        model.setViewMode(.fantastical, anchor: november, timeframe: "month")
        model.selectDate(december)
        model.syncToGCalRange()

        #expect(df.string(from: model.selectedDate) == "2026-11-15")
        let cal = Calendar.current
        #expect(cal.component(.month, from: model.displayedMonthDate) == 11)
    }

    @Test func setViewModeWithoutAnchorKeepsGCalRange() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let november = try #require(df.date(from: "2026-11-15"))

        model.setViewMode(.week, anchor: november, timeframe: "week")
        model.setViewMode(.week, anchor: nil, timeframe: "week")

        #expect(df.string(from: model.selectedDate) == "2026-11-15")
    }

    @Test func monthStepperOnlyOffersScheduleMonths() throws {
        // A fresh tray model: the shared one carries events other tests loaded, and an
        // event month is a month the agenda covers.
        let model = SidebarModel(trayModel: TrayModel())
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let november = try #require(df.date(from: "2026-11-15"))

        // Month view is bounded by Google Calendar, so there is nothing to step through.
        model.setViewMode(.fantastical, anchor: november, timeframe: "month")
        #expect(!model.isScheduleTimeframe)
        #expect(!model.canStepToPreviousMonth)
        #expect(!model.canStepToNextMonth)

        // Schedule has an open agenda; the arrows exist, and stop when the agenda has no
        // other month to show.
        model.setViewMode(.fantastical, anchor: november, timeframe: "schedule")
        #expect(model.isScheduleTimeframe)
        #expect(!model.canStepToPreviousMonth)
        #expect(!model.canStepToNextMonth)
    }

    @Test func setScrollPositionUpdatesHourHeightAndScrollY() {
        let model = SidebarModel()
        #expect(model.gridHourHeight == 48.0)
        #expect(model.gridScrollY == 0.0)
        #expect(model.gcalGridTop == 148.0)
        #expect(model.gcalGridHeight == 600.0)
        #expect(model.gcalCardTop == 64.0)
        #expect(model.topMargin == 8.0)

        // Set scroll position for 9:30 AM (9.5 hours) with 48pt row height and 64pt cardTop
        model.setScrollPosition(hour: 9.5, hourHeight: 48.0, gridTop: 148.0, gridHeight: 619.0, cardTop: 64.0)
        #expect(model.gridHourHeight == 48.0)
        #expect(model.gridScrollY == 9.5 * 48.0)
        #expect(model.gcalGridTop == 148.0)
        #expect(model.gcalGridHeight == 619.0)
        #expect(model.gcalCardTop == 64.0)

        // Set scroll position with compact 40pt row height and 196pt gridTop, 72pt cardTop
        model.setScrollPosition(hour: 14.0, hourHeight: 40.0, gridTop: 196.0, gridHeight: 550.0, cardTop: 72.0)
        #expect(model.gridHourHeight == 40.0)
        #expect(model.gridScrollY == 14.0 * 40.0)
        #expect(model.gcalGridTop == 196.0)
        #expect(model.gcalGridHeight == 550.0)
        #expect(model.gcalCardTop == 72.0)
    }

    @Test func selectNextDayAndSelectPreviousDay() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current

        let baseDate = try #require(df.date(from: "2026-11-04"))
        model.selectDate(baseDate)
        #expect(df.string(from: model.selectedDate) == "2026-11-04")

        model.selectNextDay()
        #expect(df.string(from: model.selectedDate) == "2026-11-05")

        model.selectNextDay()
        #expect(df.string(from: model.selectedDate) == "2026-11-06")

        model.selectPreviousDay()
        #expect(df.string(from: model.selectedDate) == "2026-11-05")

        model.selectPreviousDay()
        #expect(df.string(from: model.selectedDate) == "2026-11-04")
    }

    @Test func selectNextDayAndPreviousDayClampsAtWeekBoundaries() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current

        // 2026-11-08 is a Sunday (end of week with Monday start)
        let sunday = try #require(df.date(from: "2026-11-08"))
        model.setViewMode(.week, anchor: sunday, firstWeekday: 2)
        #expect(df.string(from: model.selectedDate) == "2026-11-08")
        #expect(model.currentWeekDays.first?.id == "2026-11-02")
        #expect(model.currentWeekDays.last?.id == "2026-11-08")

        // Advancing when already on Sunday must do nothing (clamped to week)
        model.selectNextDay()
        #expect(df.string(from: model.selectedDate) == "2026-11-08")
        #expect(model.currentWeekDays.first?.id == "2026-11-02")
        #expect(model.currentWeekDays.last?.id == "2026-11-08")

        // Retreating through the week down to Monday
        for _ in 0 ..< 6 {
            model.selectPreviousDay()
        }
        #expect(df.string(from: model.selectedDate) == "2026-11-02")

        // Retreating when already on Monday must do nothing (clamped to week)
        model.selectPreviousDay()
        #expect(df.string(from: model.selectedDate) == "2026-11-02")
        #expect(model.currentWeekDays.first?.id == "2026-11-02")
        #expect(model.currentWeekDays.last?.id == "2026-11-08")
    }

    @Test func selectNextDayAndPreviousDayClampsOnASundayFirstWeek() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current

        // Google on Start of the week = Sunday: the week holding Wednesday the 4th runs
        // from the 1st (a Sunday) to the 7th (a Saturday).
        let wednesday = try #require(df.date(from: "2026-11-04"))
        model.setViewMode(.week, anchor: wednesday, firstWeekday: 1)
        #expect(model.currentWeekDays.first?.id == "2026-11-01")
        #expect(model.currentWeekDays.last?.id == "2026-11-07")

        model.selectPreviousDay()
        model.selectPreviousDay()
        model.selectPreviousDay()
        #expect(df.string(from: model.selectedDate) == "2026-11-01")

        // The Saturday now ends the strip, where Monday-first would have let it run on.
        model.selectPreviousDay()
        #expect(df.string(from: model.selectedDate) == "2026-11-01")

        for _ in 0 ..< 6 {
            model.selectNextDay()
        }
        #expect(df.string(from: model.selectedDate) == "2026-11-07")
        model.selectNextDay()
        #expect(df.string(from: model.selectedDate) == "2026-11-07")
    }

    @Test func weekStripStartsOnTheFirstWeekdayItIsGiven() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let wednesday = try #require(df.date(from: "2026-11-04"))

        model.setViewMode(.week, anchor: wednesday, firstWeekday: 2)
        #expect(model.currentWeekDays.map(\.id) == [
            "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05",
            "2026-11-06", "2026-11-07", "2026-11-08",
        ])

        model.setViewMode(.week, anchor: wednesday, firstWeekday: 1)
        #expect(model.currentWeekDays.map(\.id) == [
            "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04",
            "2026-11-05", "2026-11-06", "2026-11-07",
        ])
        #expect(model.firstWeekday == 1)
    }

    @Test func aWeekdayOutsideTheWeekIsIgnored() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let wednesday = try #require(df.date(from: "2026-11-04"))

        model.setViewMode(.week, anchor: wednesday, firstWeekday: 1)
        // A malformed or stale report must not lay out a grid with no sensible answer.
        model.setViewMode(.week, anchor: wednesday, firstWeekday: 9)
        #expect(model.firstWeekday == 1)
        #expect(model.currentWeekDays.first?.id == "2026-11-01")
    }

    @Test func miniMonthLeadFollowsTheFirstWeekday() throws {
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        // 1 November 2026 is a Sunday.
        let november = try #require(df.date(from: "2026-11-01"))

        #expect(MiniMonthLayout.leadDays(of: november, firstWeekday: 1) == 0)
        #expect(MiniMonthLayout.leadDays(of: november, firstWeekday: 2) == 6)
    }

    @Test func miniMonthHeaderRotatesToTheFirstWeekday() {
        // en_US, so the letters are the same seven the app would draw on a Sunday region.
        let sunday = MiniMonthLayout.weekdaySymbols(firstWeekday: 1, locale: Locale(identifier: "en_US"))
        let monday = MiniMonthLayout.weekdaySymbols(firstWeekday: 2, locale: Locale(identifier: "en_US"))

        #expect(sunday == ["S", "M", "T", "W", "T", "F", "S"])
        #expect(monday == ["M", "T", "W", "T", "F", "S", "S"])
        #expect(sunday.first == "S")
    }

    @Test func selectNextDayAndPreviousDayClampsInFourDayMode() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current

        let start = try #require(df.date(from: "2026-11-04"))
        model.setViewMode(.fourDay, anchor: start)
        #expect(model.currentWeekDays.map(\.id) == ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"])
        #expect(df.string(from: model.selectedDate) == "2026-11-04")

        // Retreating from first day must do nothing (clamped to 4-day range)
        model.selectPreviousDay()
        #expect(df.string(from: model.selectedDate) == "2026-11-04")
        #expect(model.currentWeekDays.map(\.id) == ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"])

        // Advance to 4th day
        model.selectNextDay() // 11-05
        model.selectNextDay() // 11-06
        model.selectNextDay() // 11-07
        #expect(df.string(from: model.selectedDate) == "2026-11-07")

        // Beyond 4th day must do nothing (clamped to 4-day range)
        model.selectNextDay()
        #expect(df.string(from: model.selectedDate) == "2026-11-07")
        #expect(model.currentWeekDays.map(\.id) == ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"])
    }

    @Test func selectNextDayInDayModeIsNotClamped() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current

        let sunday = try #require(df.date(from: "2026-11-08"))
        model.setViewMode(.day, anchor: sunday)
        #expect(df.string(from: model.selectedDate) == "2026-11-08")

        model.selectNextDay()
        #expect(df.string(from: model.selectedDate) == "2026-11-09")

        model.selectPreviousDay()
        #expect(df.string(from: model.selectedDate) == "2026-11-08")
    }
}
