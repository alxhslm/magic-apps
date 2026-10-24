import Foundation
@testable import MagicalHelperLib
import Testing

/// The status line every case writes lives on `SettingsModel.shared`, so the suite is
/// serialized rather than letting parallel cases race over it.
@Suite("Magical FocusFilter Tests", .serialized)
@MainActor
struct MagicalFocusFilterTests {
    @Test func inactiveFilterReportsAllCalendarsActive() {
        let controller = FocusFilterController()
        controller.apply(accounts: [], calendars: [], preventAccess: false)

        #expect(!controller.isFilterActive)
        #expect(SettingsModel.shared.focusFilterStatus == "Inactive (All calendars active)")
    }

    @Test func activeFilterReportsSilencedAccounts() {
        let controller = FocusFilterController()
        controller.apply(accounts: ["acc_work"], calendars: ["acc_work|c1"], preventAccess: false)

        #expect(controller.isFilterActive)
        #expect(
            SettingsModel.shared.focusFilterStatus
                == "Active: 1 accounts active (others silenced)"
        )
    }

    @Test func preventedAccessReportsHiddenAccounts() {
        let controller = FocusFilterController()
        controller.apply(accounts: ["acc_work", "acc_personal"], calendars: [], preventAccess: true)

        #expect(
            SettingsModel.shared.focusFilterStatus
                == "Active: 2 accounts visible (others hidden)"
        )
    }

    @Test func clearingFilterReturnsToInactiveStatus() {
        let controller = FocusFilterController()
        controller.apply(accounts: ["acc_work"], calendars: [], preventAccess: true)
        controller.apply(accounts: [], calendars: [], preventAccess: false)

        #expect(!controller.isFilterActive)
        #expect(SettingsModel.shared.focusFilterStatus == "Inactive (All calendars active)")
    }

    @Test func pruneDropsEntriesForAnAccountThatHasGone() {
        let controller = FocusFilterController()
        controller.apply(
            accounts: ["acc_work", "acc_gone"],
            calendars: ["acc_work|c1", "acc_gone|c2"],
            preventAccess: false
        )

        controller.prune(to: ["acc_work"])

        #expect(controller.activeAccounts == ["acc_work"])
        #expect(controller.activeCalendars == ["acc_work|c1"])
        #expect(controller.isFilterActive)
    }

    @Test func pruneOfTheOnlyAccountLeavesNoFilter() {
        let controller = FocusFilterController()
        controller.apply(accounts: ["acc_gone"], calendars: ["acc_gone|c1"], preventAccess: true)

        // Nothing left to point at: the filter has no target, so it must stop silencing
        // every account that remains rather than locking the user out with no explanation.
        controller.prune(to: ["acc_work"])

        #expect(!controller.isFilterActive)
        #expect(controller.activeAccounts.isEmpty)
        #expect(controller.activeCalendars.isEmpty)
    }

    @Test func pruneIsANoOpBeforeAccountsAreKnown() {
        let controller = FocusFilterController()
        controller.apply(accounts: ["acc_work"], calendars: ["acc_work|c1"], preventAccess: false)

        controller.prune(to: [])

        #expect(controller.activeAccounts == ["acc_work"])
        #expect(controller.activeCalendars == ["acc_work|c1"])
    }
}
