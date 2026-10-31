@testable import MagicalNative
import XCTest

@MainActor
final class SidebarModelTests: XCTestCase {
    func testInitialState() {
        let model = SidebarModel()
        XCTAssertEqual(model.viewMode, .fantastical)
        XCTAssertTrue(model.isVisible)
        XCTAssertEqual(model.currentWeekDays.count, 7)
    }

    func testSetViewModeWeek() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let anchor = try XCTUnwrap(df.date(from: "2026-10-14"))

        model.setViewMode(.week, anchor: anchor)

        XCTAssertEqual(model.viewMode, .week)
        XCTAssertEqual(model.currentWeekDays.count, 7)

        // Selected date should match anchor
        let selectedStr = df.string(from: model.selectedDate)
        XCTAssertEqual(selectedStr, "2026-10-14")

        // Exactly one day in currentWeekDays should be selected
        let selectedDays = model.currentWeekDays.filter(\.isSelected)
        XCTAssertEqual(selectedDays.count, 1)
        XCTAssertEqual(selectedDays.first?.id, "2026-10-14")
    }

    func testSetViewModeDay() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        let anchor = try XCTUnwrap(df.date(from: "2026-11-05"))

        model.setViewMode(.day, anchor: anchor)

        XCTAssertEqual(model.viewMode, .day)
        XCTAssertEqual(df.string(from: model.selectedDate), "2026-11-05")
    }

    func testSelectDateAdvancesWeekIfOutsideCurrent() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current

        let date1 = try XCTUnwrap(df.date(from: "2026-10-14"))
        model.selectDate(date1)
        XCTAssertTrue(model.currentWeekDays.contains { $0.id == "2026-10-14" })

        let date2 = try XCTUnwrap(df.date(from: "2026-10-28"))
        model.selectDate(date2)
        XCTAssertTrue(model.currentWeekDays.contains { $0.id == "2026-10-28" })
        XCTAssertFalse(model.currentWeekDays.contains { $0.id == "2026-10-14" })
    }

    func testUpdateDataPopulatesEventsAndDensityDots() throws {
        let model = SidebarModel()
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current

        let targetDate = try XCTUnwrap(df.date(from: "2026-10-14"))
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
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.summary, "Product Review")

        // Week pills should have dots
        let matchingPill = model.currentWeekDays.first { $0.id == "2026-10-14" }
        XCTAssertNotNil(matchingPill)
        XCTAssertFalse(try XCTUnwrap(matchingPill?.dots.isEmpty))
    }
}
