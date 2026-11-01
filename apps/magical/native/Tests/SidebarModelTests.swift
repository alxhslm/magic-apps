import Foundation
@testable import MagicalNative
import Testing

@MainActor
@Suite("SidebarModel Tests")
struct SidebarModelTests {
    @Test func initialState() {
        let model = SidebarModel()
        #expect(model.viewMode == .fantastical)
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
}
