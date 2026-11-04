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

    @Test func jumpToToday() throws {
        let model = SidebarModel()
        let cal = Calendar.current
        let pastDate = try #require(cal.date(byAdding: .month, value: -3, to: Date()))

        model.selectDate(pastDate)
        #expect(!cal.isDateInToday(model.selectedDate))

        model.jumpToToday()
        #expect(cal.isDateInToday(model.selectedDate))
        #expect(cal.isDateInToday(model.displayedMonthDate))
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

    @Test func selectNextDayCrossesWeekBoundary() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current

        // 2026-11-08 is a Sunday (end of week with Monday start)
        let sunday = try #require(df.date(from: "2026-11-08"))
        model.setViewMode(.week, anchor: sunday)
        #expect(model.currentWeekDays.contains { $0.id == "2026-11-08" })
        #expect(!model.currentWeekDays.contains { $0.id == "2026-11-09" })

        // Advancing advances into Monday 2026-11-09 of next week
        model.selectNextDay()
        #expect(df.string(from: model.selectedDate) == "2026-11-09")
        #expect(model.currentWeekDays.contains { $0.id == "2026-11-09" })
        #expect(!model.currentWeekDays.contains { $0.id == "2026-11-08" })

        // Retreating goes back to Sunday of previous week
        model.selectPreviousDay()
        #expect(df.string(from: model.selectedDate) == "2026-11-08")
        #expect(model.currentWeekDays.contains { $0.id == "2026-11-08" })
    }

    @Test func selectNextDayInFourDayModeShiftsAnchor() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current

        let start = try #require(df.date(from: "2026-11-04"))
        model.setViewMode(.fourDay, anchor: start)
        #expect(model.currentWeekDays.map(\.id) == ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"])

        model.selectNextDay() // 11-05
        model.selectNextDay() // 11-06
        model.selectNextDay() // 11-07
        #expect(df.string(from: model.selectedDate) == "2026-11-07")
        #expect(model.currentWeekDays.map(\.id) == ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"])

        // Beyond 4th day -> shifts anchor
        model.selectNextDay() // 11-08
        #expect(df.string(from: model.selectedDate) == "2026-11-08")
        #expect(model.currentWeekDays.first?.id == "2026-11-08")
    }
}
