import Foundation
@testable import MagimailHelperLib
import Testing

@Suite("FocusFilter Tests")
@MainActor
struct FocusFilterTests {
    @Test func inactiveFilterMutesNoAccounts() {
        let controller = FocusFilterController()
        #expect(!controller.isFilterActive)
        #expect(!controller.isAccountMuted("acc_work"))
        #expect(!controller.isAccountMuted("acc_personal"))
    }

    @Test func activeFilterMutesExcludedAccounts() {
        let controller = FocusFilterController()
        controller.applyFilter(activeAccountIds: ["acc_work"], disableExcludedAccounts: false)

        #expect(controller.isFilterActive)
        #expect(!controller.isAccountMuted("acc_work"))
        #expect(controller.isAccountMuted("acc_personal"))
        #expect(controller.isAccountMuted("acc_other"))
    }

    @Test func clearingFilterUnmutesAllAccounts() {
        let controller = FocusFilterController()
        controller.applyFilter(activeAccountIds: ["acc_work"], disableExcludedAccounts: false)
        #expect(controller.isAccountMuted("acc_personal"))

        controller.applyFilter(activeAccountIds: [], disableExcludedAccounts: false)
        #expect(!controller.isFilterActive)
        #expect(!controller.isAccountMuted("acc_personal"))
    }

    @Test func pruneDropsAnAccountThatHasGone() {
        let controller = FocusFilterController()
        controller.applyFilter(
            activeAccountIds: ["acc_work", "acc_gone"],
            disableExcludedAccounts: false
        )

        controller.prune(to: ["acc_work"])

        #expect(controller.activeAccountIds == ["acc_work"])
        #expect(controller.isFilterActive)
        #expect(!controller.isAccountMuted("acc_work"))
    }

    @Test func pruneOfTheOnlyAccountLeavesNoFilter() {
        let controller = FocusFilterController()
        controller.applyFilter(activeAccountIds: ["acc_gone"], disableExcludedAccounts: true)

        // Nothing left to point at: the filter must stop muting every account that
        // remains rather than locking the user out with no explanation.
        controller.prune(to: ["acc_work"])

        #expect(!controller.isFilterActive)
        #expect(controller.activeAccountIds.isEmpty)
        #expect(!controller.isAccountMuted("acc_work"))
    }

    @Test func pruneIsANoOpBeforeAccountsAreKnown() {
        let controller = FocusFilterController()
        controller.applyFilter(activeAccountIds: ["acc_work"], disableExcludedAccounts: false)

        controller.prune(to: [])

        #expect(controller.activeAccountIds == ["acc_work"])
    }
}
