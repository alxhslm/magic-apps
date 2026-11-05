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

    @Test func theForcedCycleOverridesTheLocale() {
        let twentyFour = TimeDisplay.timeFormatter(
            locale: Locale(identifier: "en_US"),
            timeZone: london,
            forced24Hour: true
        )
        #expect(twentyFour.string(from: date(hour: 13)) == "13:05")

        let twelve = TimeDisplay.timeFormatter(
            locale: Locale(identifier: "en_GB"),
            timeZone: london,
            forced24Hour: false
        )
        #expect(twelve.string(from: date(hour: 13)).lowercased().contains("pm"))
    }

    @Test func theStoredSwitchValueDecides() {
        #expect(TimeDisplay.forced24Hour(from: true) == true)
        #expect(TimeDisplay.forced24Hour(from: false) == false)
        #expect(TimeDisplay.forced24Hour(from: 1) == true)
        #expect(TimeDisplay.forced24Hour(from: 0) == false)
        #expect(TimeDisplay.forced24Hour(from: "1") == true)
        #expect(TimeDisplay.forced24Hour(from: "0") == false)
        #expect(TimeDisplay.forced24Hour(from: "true") == true)
        #expect(TimeDisplay.forced24Hour(from: "false") == false)
    }

    @Test func eitherStoredKeyCanForceTheClock() {
        #expect(TimeDisplay.forced24Hour(twentyFour: 1, twelve: nil) == true)
        #expect(TimeDisplay.forced24Hour(twentyFour: nil, twelve: 1) == false)
        #expect(TimeDisplay.forced24Hour(twentyFour: 1, twelve: 1) == true)
        #expect(TimeDisplay.forced24Hour(twentyFour: 0, twelve: 1) == false)
        #expect(TimeDisplay.forced24Hour(twentyFour: nil, twelve: 0) == nil)
        #expect(TimeDisplay.forced24Hour(twentyFour: nil, twelve: nil) == nil)
    }

    @Test func anAbsentOrUnknownSwitchSaysNothing() {
        #expect(TimeDisplay.forced24Hour(from: nil) == nil)
        #expect(TimeDisplay.forced24Hour(from: "") == nil)
        #expect(TimeDisplay.forced24Hour(from: [:]) == nil)
    }

    @Test func withNothingForcedTheRegionAnswers() {
        #expect(!TimeDisplay.uses24Hour(in: TimeDisplay.displayLocale(Locale(identifier: "en_US"))))
        #expect(TimeDisplay.uses24Hour(in: TimeDisplay.displayLocale(Locale(identifier: "en_GB"))))
    }

    @Test func dateLabelsFollowTheLocaleOrderAndPunctuation() {
        let label = { (locale: String, template: String) in
            TimeDisplay.dateFormatter(
                template: template,
                locale: Locale(identifier: locale),
                timeZone: london
            ).string(from: date(hour: 12))
        }

        // English is not one order: the templates are what make these differ, and a
        // literal `d MMMM yyyy` would give every one of them the London reading.
        #expect(label("en_GB", "yMMMMd") == "3 March 2026")
        #expect(label("en_US", "yMMMMd") == "March 3, 2026")
        #expect(label("en_GB", "yMMMM") == "March 2026")
        #expect(label("ja_JP", "yMMMM") == "2026年3月")
        #expect(label("ja_JP", "yMMMMd") == "2026年3月3日")
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
