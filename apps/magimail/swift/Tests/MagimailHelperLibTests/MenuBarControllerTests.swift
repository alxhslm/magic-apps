import AppKit
import Foundation
import HelperRPC
@testable import MagimailHelperLib
import Testing

@Suite("Magimail MenuBarController Tests")
@MainActor
struct MenuBarControllerTests {
    private func account(
        _ name: String,
        _ unreadCount: Int,
        needsAuth: Bool = false
    ) -> MenuBarAccount {
        MenuBarAccount(
            name: name,
            color: "#0096ff",
            unreadCount: unreadCount,
            needsAuth: needsAuth
        )
    }

    private func accounts(_ counts: [Int]) -> [MenuBarAccount] {
        counts.enumerated().map { account("Account \($0.offset + 1)", $0.element) }
    }

    private func dotAttachmentCount(_ accounts: [MenuBarAccount]) -> Int {
        let title = MenuBarTitle.attributed(display: .dots, accounts: accounts)
        var count = 0
        title.enumerateAttribute(
            .attachment,
            in: NSRange(location: 0, length: title.length)
        ) { value, _, _ in
            guard let attachment = value as? NSTextAttachment,
                  attachment.image?.size.width == MenuBarTitle.dotDiameter
            else { return }
            count += 1
        }
        return count
    }

    private func makeTestSetup() -> (controller: MenuBarController, getLastEvent: () -> RPCEvent?) {
        var lastEvent: RPCEvent?
        let transport = StdioTransport(outputWriter: { data in
            if let event = try? JSONDecoder().decode(RPCEvent.self, from: data) {
                lastEvent = event
            }
        })
        let controller = MenuBarController()
        controller.transport = transport
        return (controller, { lastEvent })
    }

    @Test func showThreadSendsExpectedMethodAndParams() throws {
        let (controller, getLastEvent) = makeTestSetup()
        let popoverView = controller.makePopoverView()

        popoverView.onShowThread("acc_work", "thread_123")

        let event = try #require(getLastEvent())
        #expect(event.method == "tray.showThread")
        let params = try #require(event.params?.dict)
        #expect(params["accountId"] as? String == "acc_work")
        #expect(params["threadId"] as? String == "thread_123")
    }

    @Test func threadActionSendsExpectedActionString() throws {
        let cases: [(TrayThreadAction, String)] = [
            (.archive, "archive"),
            (.trash, "trash"),
            (.markRead, "markRead"),
            (.markUnread, "markUnread"),
        ]

        for (action, expectedString) in cases {
            let (controller, getLastEvent) = makeTestSetup()
            let popoverView = controller.makePopoverView()

            popoverView.onThreadAction("acc_work", "thread_123", action)

            let event = try #require(getLastEvent())
            #expect(event.method == "tray.threadAction")
            let params = try #require(event.params?.dict)
            #expect(params["accountId"] as? String == "acc_work")
            #expect(params["threadId"] as? String == "thread_123")
            #expect(params["action"] as? String == expectedString)
        }
    }

    @Test func composeSendsAccountIdWhenProvided() throws {
        let (controller, getLastEvent) = makeTestSetup()
        let popoverView = controller.makePopoverView()

        popoverView.onCompose("acc_work")

        let event = try #require(getLastEvent())
        #expect(event.method == "tray.compose")
        let params = try #require(event.params?.dict)
        #expect(params["accountId"] as? String == "acc_work")
    }

    @Test func composeOmitsAccountIdWhenNil() throws {
        let (controller, getLastEvent) = makeTestSetup()
        let popoverView = controller.makePopoverView()

        popoverView.onCompose(nil)

        let event = try #require(getLastEvent())
        #expect(event.method == "tray.compose")
        let params = try #require(event.params?.dict)
        #expect(params["accountId"] == nil)
    }

    @Test func searchSendsQueryAndOptionalAccountId() throws {
        let (controller, getLastEvent) = makeTestSetup()
        let popoverView = controller.makePopoverView()

        popoverView.onSearch("is:unread", "acc_personal")

        let event = try #require(getLastEvent())
        #expect(event.method == "tray.search")
        let params = try #require(event.params?.dict)
        #expect(params["query"] as? String == "is:unread")
        #expect(params["accountId"] as? String == "acc_personal")

        popoverView.onSearch("from:boss", nil)
        let searchNilEvent = try #require(getLastEvent())
        #expect(searchNilEvent.method == "tray.search")
        let searchNilParams = try #require(searchNilEvent.params?.dict)
        #expect(searchNilParams["query"] as? String == "from:boss")
        #expect(searchNilParams["accountId"] == nil)
    }

    @Test func otherPopoverClosuresSendExpectedMethods() throws {
        let (controller, getLastEvent) = makeTestSetup()
        let popoverView = controller.makePopoverView()

        popoverView.onRefresh()
        #expect(getLastEvent()?.method == "tray.refresh")

        popoverView.onQuit()
        #expect(getLastEvent()?.method == "tray.quit")

        popoverView.onOpenApp()
        let openAppEvent = try #require(getLastEvent())
        #expect(openAppEvent.method == "tray.showAccount")
        #expect(openAppEvent.params?.dict?["accountId"] as? String == "")

        popoverView.onShowAccount("acc_work")
        let showAccountEvent = try #require(getLastEvent())
        #expect(showAccountEvent.method == "tray.showAccount")
        #expect(showAccountEvent.params?.dict?["accountId"] as? String == "acc_work")
    }

    @Test func popoverActionsMatchSharedActionFixtures() throws {
        let (controller, getLastEvent) = makeTestSetup()
        let popoverView = controller.makePopoverView()

        // Match tray-thread-action.json: account_work, thread_101, archive
        popoverView.onThreadAction("account_work", "thread_101", .archive)
        let threadActionEvent = try #require(getLastEvent())
        #expect(threadActionEvent.method == "tray.threadAction")
        let threadActionParams = try #require(threadActionEvent.params?.dict)
        #expect(threadActionParams["accountId"] as? String == "account_work")
        #expect(threadActionParams["threadId"] as? String == "thread_101")
        #expect(threadActionParams["action"] as? String == "archive")

        // Match tray-show-thread.json: account_work, thread_101
        popoverView.onShowThread("account_work", "thread_101")
        let showThreadEvent = try #require(getLastEvent())
        #expect(showThreadEvent.method == "tray.showThread")
        let showThreadParams = try #require(showThreadEvent.params?.dict)
        #expect(showThreadParams["accountId"] as? String == "account_work")
        #expect(showThreadParams["threadId"] as? String == "thread_101")
    }

    @Test func popoverCloseDelegateMethodsRecordTimestamp() {
        let (controller, _) = makeTestSetup()
        #expect(controller.popoverClosedTimestamp == 0)

        controller.popoverWillClose(Notification(name: NSPopover.willCloseNotification))
        #expect(controller.popoverClosedTimestamp > 0)

        let initialStamp = controller.popoverClosedTimestamp
        controller.popoverDidClose(Notification(name: NSPopover.didCloseNotification))
        #expect(controller.popoverClosedTimestamp >= initialStamp)
    }

    @Test func widthIgnoresUnreadCountsForEveryReading() {
        let quiet = accounts([0, 0])
        let busy = accounts([3, 12])
        for display in MenuBarUnreadDisplay.allCases {
            #expect(
                MenuBarTitle.width(display: display, accounts: quiet)
                    == MenuBarTitle.width(display: display, accounts: busy)
            )
        }

        let waiting = [account("Work", 3), account("Personal", 0)]
        #expect(
            MenuBarTitle.width(display: .dots, accounts: waiting)
                == MenuBarTitle.width(
                    display: .dots,
                    accounts: [account("Work", 0), account("Personal", 9)]
                )
        )
    }

    @Test func widthFollowsTheSettingAndAccountCount() {
        #expect(MenuBarTitle.width(display: .nothing, accounts: accounts([3, 4, 5])) == 0)
        #expect(
            MenuBarTitle.width(display: .dots, accounts: accounts([0, 0]))
                > MenuBarTitle.width(display: .dots, accounts: accounts([0]))
        )
        #expect(
            MenuBarTitle.width(display: .numbers, accounts: accounts([0, 0]))
                > MenuBarTitle.width(display: .numbers, accounts: accounts([0]))
        )
        #expect(
            MenuBarTitle.width(display: .numbers, accounts: accounts([0]))
                != MenuBarTitle.width(display: .dots, accounts: accounts([0]))
        )
    }

    @Test func numbersReserveTwoDigitsAndGrowOncePast99() {
        #expect(
            MenuBarTitle.width(display: .numbers, accounts: [account("Work", 9)])
                == MenuBarTitle.width(display: .numbers, accounts: [account("Work", 99)])
        )
        #expect(
            MenuBarTitle.width(display: .numbers, accounts: [account("Work", 100)])
                > MenuBarTitle.width(display: .numbers, accounts: [account("Work", 99)])
        )
    }

    @Test func dotCompositionCoversNoAccountsOneAndAuth() {
        #expect(dotAttachmentCount([]) == 0)
        #expect(dotAttachmentCount(accounts([0])) == 1)
        #expect(dotAttachmentCount(accounts([3])) == 1)
        #expect(dotAttachmentCount([account("Personal", 3, needsAuth: true)]) == 1)
    }

    @Test func accessibilityNamesWaitingAccountsAndSignIn() {
        let quiet = MenuBarTitle.accessibilityDescription(accounts: accounts([0, 0]))
        #expect(quiet.contains("no unread mail"))

        let waiting = MenuBarTitle.accessibilityDescription(
            accounts: [account("Work", 3), account("Personal", 0)]
        )
        #expect(waiting.contains("Work 3 unread"))
        #expect(!waiting.contains("Personal"))

        let auth = MenuBarTitle.accessibilityDescription(
            accounts: [account("Personal", 3, needsAuth: true)]
        )
        #expect(auth.contains("Personal needs sign-in"))
        #expect(!auth.contains("3 unread"))
    }
}
