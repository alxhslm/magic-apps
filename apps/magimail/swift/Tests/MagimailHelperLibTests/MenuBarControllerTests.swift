import AppKit
import Foundation
import HelperRPC
@testable import MagimailHelperLib
import Testing

@Suite("Magimail MenuBarController Popover Request Tests")
@MainActor
struct MenuBarControllerTests {
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
}
