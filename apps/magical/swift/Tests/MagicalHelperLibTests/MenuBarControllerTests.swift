import Foundation
import HelperRPC
@testable import MagicalHelperLib
import SwiftUI
import Testing

@Suite("MenuBarController Popover Request Tests")
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

    private func makeSampleEvent(id: String = "evt_1", accountId: String = "acc_1") -> TrayEvent {
        TrayEvent(from: [
            "id": id,
            "accountId": accountId,
            "summary": "Meeting",
            "startTime": 1_789_027_200_000.0,
            "endTime": 1_789_030_800_000.0,
            "calendarIds": ["user@example.com"],
        ])
    }

    @Test func completeTaskSendsSetTaskCompletedWithExpectedParams() throws {
        let (controller, getLastEvent) = makeTestSetup()
        let popoverView = controller.makePopoverView()
        let event = makeSampleEvent(id: "task_42", accountId: "acc_work")

        popoverView.onCompleteTask?(event, true)

        let eventSent = try #require(getLastEvent())
        #expect(eventSent.method == "tray.setTaskCompleted")
        let params = try #require(eventSent.params?.dict)
        #expect(params["accountId"] as? String == "acc_work")
        #expect(params["eventId"] as? String == "task_42")
        #expect(params["completed"] as? Bool == true)

        popoverView.onCompleteTask?(event, false)
        let uncompleteEvent = try #require(getLastEvent())
        #expect(uncompleteEvent.method == "tray.setTaskCompleted")
        #expect(uncompleteEvent.params?.dict?["completed"] as? Bool == false)
    }

    @Test func deleteEventSendsDeleteEventWithExpectedParams() throws {
        let (controller, getLastEvent) = makeTestSetup()
        let popoverView = controller.makePopoverView()
        let event = makeSampleEvent(id: "evt_99", accountId: "acc_personal")

        popoverView.onDeleteEvent?(event)

        let eventSent = try #require(getLastEvent())
        #expect(eventSent.method == "tray.deleteEvent")
        let params = try #require(eventSent.params?.dict)
        #expect(params["accountId"] as? String == "acc_personal")
        #expect(params["eventId"] as? String == "evt_99")
    }

    @Test func rsvpSendsRsvpWithResponseAndEventDetails() throws {
        let (controller, getLastEvent) = makeTestSetup()
        let popoverView = controller.makePopoverView()
        let event = makeSampleEvent(id: "evt_meet", accountId: "acc_1")

        popoverView.onRsvp(event, "accepted")

        let eventSent = try #require(getLastEvent())
        #expect(eventSent.method == "tray.rsvp")
        let params = try #require(eventSent.params?.dict)
        #expect(params["accountId"] as? String == "acc_1")
        #expect(params["eventId"] as? String == "evt_meet")
        #expect(params["response"] as? String == "accepted")
    }

    @Test func selectEventSendsFocusEvent() throws {
        let (controller, getLastEvent) = makeTestSetup()
        let popoverView = controller.makePopoverView()
        let event = makeSampleEvent(id: "evt_focus", accountId: "acc_1")

        popoverView.onSelectEvent(event)

        let eventSent = try #require(getLastEvent())
        #expect(eventSent.method == "tray.focusEvent")
        let params = try #require(eventSent.params?.dict)
        #expect(params["accountId"] as? String == "acc_1")
        #expect(params["eventId"] as? String == "evt_focus")
    }

    @Test func joinCallSendsJoinCallWithUrl() throws {
        let (controller, getLastEvent) = makeTestSetup()
        let popoverView = controller.makePopoverView()

        popoverView.onJoinCall("https://meet.google.com/abc-defg-hij")

        let eventSent = try #require(getLastEvent())
        #expect(eventSent.method == "tray.joinCall")
        let params = try #require(eventSent.params?.dict)
        #expect(params["url"] as? String == "https://meet.google.com/abc-defg-hij")
    }

    @Test func otherPopoverClosuresSendExpectedMethods() throws {
        let (controller, getLastEvent) = makeTestSetup()
        let popoverView = controller.makePopoverView()

        popoverView.onRefresh()
        #expect(getLastEvent()?.method == "tray.refresh")

        popoverView.onQuit()
        #expect(getLastEvent()?.method == "tray.quit")

        popoverView.onOpenApp()
        #expect(getLastEvent()?.method == "tray.openApp")

        popoverView.onQuickAdd("acc_work")
        let quickAddEvent = try #require(getLastEvent())
        #expect(quickAddEvent.method == "tray.openQuickAdd")
        #expect(quickAddEvent.params?.dict?["accountId"] as? String == "acc_work")

        popoverView.onSearch("standup", "acc_work")
        let searchEvent = try #require(getLastEvent())
        #expect(searchEvent.method == "tray.search")
        #expect(searchEvent.params?.dict?["query"] as? String == "standup")
        #expect(searchEvent.params?.dict?["accountId"] as? String == "acc_work")

        popoverView.onShowAccount("acc_test")
        let showEvent = try #require(getLastEvent())
        #expect(showEvent.method == "tray.showAccount")
        #expect(showEvent.params?.dict?["accountId"] as? String == "acc_test")

        popoverView.onQuickAdd(nil)
        let quickAddNilEvent = try #require(getLastEvent())
        #expect(quickAddNilEvent.method == "tray.openQuickAdd")
        #expect(quickAddNilEvent.params?.dict?["accountId"] == nil)

        popoverView.onOpenSettings()
        #expect(getLastEvent()?.method == "tray.openSettings")
    }

    @Test func popoverEventsMatchSharedActionFixtures() throws {
        let (controller, getLastEvent) = makeTestSetup()
        let popoverView = controller.makePopoverView()

        let rsvpEvent = makeSampleEvent(id: "evt_invite_needs_rsvp_003", accountId: "account_work")
        popoverView.onRsvp(rsvpEvent, "yes")
        let rsvpSent = try #require(getLastEvent())
        #expect(rsvpSent.method == "tray.rsvp")
        let rsvpParams = try #require(rsvpSent.params?.dict)
        #expect(rsvpParams["accountId"] as? String == "account_work")
        #expect(rsvpParams["eventId"] as? String == "evt_invite_needs_rsvp_003")
        #expect(rsvpParams["response"] as? String == "yes")

        let taskEvent = makeSampleEvent(id: "task_review_pr_004", accountId: "account_work")
        popoverView.onCompleteTask?(taskEvent, true)
        let taskSent = try #require(getLastEvent())
        #expect(taskSent.method == "tray.setTaskCompleted")
        let taskParams = try #require(taskSent.params?.dict)
        #expect(taskParams["accountId"] as? String == "account_work")
        #expect(taskParams["eventId"] as? String == "task_review_pr_004")
        #expect(taskParams["completed"] as? Bool == true)

        let deleteEvent = makeSampleEvent(id: "evt_standup_001", accountId: "account_work")
        popoverView.onDeleteEvent?(deleteEvent)
        let deleteSent = try #require(getLastEvent())
        #expect(deleteSent.method == "tray.deleteEvent")
        let deleteParams = try #require(deleteSent.params?.dict)
        #expect(deleteParams["accountId"] as? String == "account_work")
        #expect(deleteParams["eventId"] as? String == "evt_standup_001")

        popoverView.onSelectEvent(deleteEvent)
        let focusSent = try #require(getLastEvent())
        #expect(focusSent.method == "tray.focusEvent")
        let focusParams = try #require(focusSent.params?.dict)
        #expect(focusParams["accountId"] as? String == "account_work")
        #expect(focusParams["eventId"] as? String == "evt_standup_001")

        popoverView.onShowAccount("account_work")
        let showSent = try #require(getLastEvent())
        #expect(showSent.method == "tray.showAccount")
        let showParams = try #require(showSent.params?.dict)
        #expect(showParams["accountId"] as? String == "account_work")
    }

    @Test func popoverIsReusedAcrossCallsAndClearedOnDestroy() {
        let (controller, _) = makeTestSetup()
        let popover1 = controller.getOrCreatePopover()
        let popover2 = controller.getOrCreatePopover()
        #expect(popover1 === popover2)
        #expect(popover1.animates == true)

        controller.destroy()
        let popover3 = controller.getOrCreatePopover()
        #expect(popover1 !== popover3)
        #expect(popover3.animates == true)
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

    @Test func redactUrlStripsIdentifyingParametersAndRedactsMailto() {
        #expect(MenuBarController.redactUrl(nil) == "none")
        #expect(MenuBarController.redactUrl("") == "none")
        #expect(MenuBarController.redactUrl("mailto:colleague@example.com") == "mailto:<redacted>")
        #expect(MenuBarController.redactUrl("mailto:user@example.com?subject=Hello") == "mailto:<redacted>")
        #expect(MenuBarController.redactUrl("https://meet.google.com/abc-defg-hij") == "https://meet.google.com/abc-defg-hij")
        #expect(MenuBarController.redactUrl("https://meet.google.com/abc-defg-hij?authuser=1") == "https://meet.google.com/abc-defg-hij?<redacted>")
        #expect(MenuBarController.redactUrl("https://teams.microsoft.com/l/meetup-join/19%3ameeting#fragment") == "https://teams.microsoft.com/l/meetup-join/19%3ameeting?<redacted>")
    }

    @Test func checkMeetingTransitionsTracksActiveAndUpcomingTransitions() {
        let (controller, _) = makeTestSetup()
        let now = Date(timeIntervalSince1970: 1_790_244_000) // 10:00:00 UTC

        let model = TrayModel.shared
        let eventA = TrayEvent(from: [
            "id": "meeting_a",
            "accountId": "acc_1",
            "summary": "Meeting A",
            "startTime": now.timeIntervalSince1970 * 1000,
            "endTime": now.addingTimeInterval(30 * 60).timeIntervalSince1970 * 1000,
            "conferenceUrl": "https://meet.google.com/abc-defg-hij",
        ])
        let eventB = TrayEvent(from: [
            "id": "meeting_b",
            "accountId": "acc_1",
            "summary": "Meeting B",
            "startTime": now.addingTimeInterval(30 * 60).timeIntervalSince1970 * 1000,
            "endTime": now.addingTimeInterval(60 * 60).timeIntervalSince1970 * 1000,
            "conferenceUrl": "https://meet.google.com/klm-nopq-rst",
        ])
        model.events = [eventA, eventB]

        // At 10:15 (during Meeting A)
        controller.checkMeetingTransitions(now: now.addingTimeInterval(15 * 60))
        #expect(model.activeEvent(now: now.addingTimeInterval(15 * 60))?.id == "meeting_a")
        #expect(model.upcomingEvent(within: nil, now: now.addingTimeInterval(15 * 60))?.event.id == "meeting_b")

        // At 10:30 (transition boundary)
        controller.checkMeetingTransitions(now: now.addingTimeInterval(30 * 60))
        #expect(model.activeEvent(now: now.addingTimeInterval(30 * 60))?.id == "meeting_b")
        #expect(model.upcomingEvent(within: nil, now: now.addingTimeInterval(30 * 60)) == nil)
    }
}
