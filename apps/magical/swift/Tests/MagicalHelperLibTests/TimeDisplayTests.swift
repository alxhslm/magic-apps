import Foundation
@testable import MagicalHelperLib
import Testing

@Suite("TimeDisplay Tests")
struct TimeDisplayTests {
    private let london = TimeZone(identifier: "Europe/London")!

    /// A fixed winter date in London, so no test depends on the machine's region or on
    /// daylight saving.
    private func date(hour: Int, minute: Int = 5) -> Date {
        var components = DateComponents()
        components.year = 2026
        components.month = 3
        components.day = 3
        components.hour = hour
        components.minute = minute

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = london
        return calendar.date(from: components)!
    }

    @Test func hourCycleComesFromTheLocale() {
        #expect(TimeDisplay.uses24Hour(in: Locale(identifier: "en_GB")))
        #expect(TimeDisplay.uses24Hour(in: Locale(identifier: "de_DE")))
        #expect(!TimeDisplay.uses24Hour(in: Locale(identifier: "en_US")))
        #expect(!TimeDisplay.uses24Hour(in: Locale(identifier: "en_AU")))
    }

    @Test func a24HourLocaleDropsTheMeridiem() {
        let formatter = TimeDisplay.timeFormatter(locale: Locale(identifier: "en_GB"), timeZone: london)

        #expect(formatter.string(from: date(hour: 13)) == "13:05")
        #expect(formatter.string(from: date(hour: 0)) == "00:05")
    }

    @Test func a12HourLocaleKeepsTheMeridiem() {
        let formatter = TimeDisplay.timeFormatter(locale: Locale(identifier: "en_US"), timeZone: london)
        let afternoon = formatter.string(from: date(hour: 13))

        #expect(afternoon.contains("1:05"))
        #expect(afternoon.lowercased().contains("pm"))
        #expect(!afternoon.contains("13"))
    }

    @Test func theHourGutterFollowsTheSameClockAsTheRest() {
        let twentyFour = TimeDisplay.hourFormatter(locale: Locale(identifier: "en_GB"), timeZone: london)
        let twelve = TimeDisplay.hourFormatter(locale: Locale(identifier: "en_US"), timeZone: london)

        #expect(twentyFour.string(from: date(hour: 13)) == "13")
        #expect(twentyFour.string(from: date(hour: 0)) == "00")
        #expect(twelve.string(from: date(hour: 13)).contains("1"))
        #expect(twelve.string(from: date(hour: 13)).contains("PM"))
    }
}
