import Foundation
@testable import MagicalHelperLib
import Testing

@Suite("TrayCountdown Tests")
struct TrayCountdownTests {
    @Test func compactFormattingEitherSideOfTheHourAndAtOneMinute() {
        #expect(TrayCountdown.compact(minutes: -5) == "Now")
        #expect(TrayCountdown.compact(minutes: 0) == "Now")
        #expect(TrayCountdown.compact(minutes: 1) == "1m")
        #expect(TrayCountdown.compact(minutes: 59) == "59m")
        #expect(TrayCountdown.compact(minutes: 60) == "1h")
        #expect(TrayCountdown.compact(minutes: 61) == "1h 1m")
        #expect(TrayCountdown.compact(minutes: 119) == "1h 59m")
        #expect(TrayCountdown.compact(minutes: 120) == "2h")
        #expect(TrayCountdown.compact(minutes: 125) == "2h 5m")
    }

    @Test func labelFormattingEitherSideOfTheHourAndAtOneMinute() {
        #expect(TrayCountdown.label(minutes: -1) == "NOW")
        #expect(TrayCountdown.label(minutes: 0) == "NOW")
        #expect(TrayCountdown.label(minutes: 1) == "IN 1 MIN")
        #expect(TrayCountdown.label(minutes: 2) == "IN 2 MINS")
        #expect(TrayCountdown.label(minutes: 59) == "IN 59 MINS")
        #expect(TrayCountdown.label(minutes: 60) == "IN 1 HR")
        #expect(TrayCountdown.label(minutes: 61) == "IN 1 HR 1 MIN")
        #expect(TrayCountdown.label(minutes: 62) == "IN 1 HR 2 MINS")
        #expect(TrayCountdown.label(minutes: 119) == "IN 1 HR 59 MINS")
        #expect(TrayCountdown.label(minutes: 120) == "IN 2 HRS")
        #expect(TrayCountdown.label(minutes: 121) == "IN 2 HRS 1 MIN")
        #expect(TrayCountdown.label(minutes: 122) == "IN 2 HRS 2 MINS")
    }
}
