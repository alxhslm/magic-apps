import Foundation
@testable import MagicalHelperLib
import Testing
import UserNotifications

@Suite("Magical NotificationController Tests")
@MainActor
struct NotificationControllerTests {
    @Test func notificationCategoriesCarryExpectedActions() {
        let categories = NotificationController.makeCategories()
        let byId = Dictionary(uniqueKeysWithValues: categories.map { ($0.identifier, $0) })

        // 1. Meeting with call carries Join Call and Snooze 5m
        let callCategory = byId[NotificationController.categoryWithCall]
        #expect(callCategory != nil)
        let callActions = callCategory?.actions ?? []
        #expect(callActions.count == 2)
        #expect(callActions.map(\.title) == ["Join Call", "Snooze 5m"])
        #expect(callActions.map(\.identifier) == [NotificationController.joinAction, NotificationController.snoozeAction])
        for action in callActions {
            #expect(action.options.isEmpty)
        }

        // 2. Invite carries Yes, Maybe, and No
        let inviteCategory = byId[NotificationController.categoryInvite]
        #expect(inviteCategory != nil)
        let inviteActions = inviteCategory?.actions ?? []
        #expect(inviteActions.count == 3)
        #expect(inviteActions.map(\.title) == ["Yes", "Maybe", "No"])
        #expect(inviteActions.map(\.identifier) == [
            NotificationController.rsvpYes,
            NotificationController.rsvpMaybe,
            NotificationController.rsvpNo,
        ])
        for action in inviteActions {
            #expect(action.options.isEmpty)
        }

        // 3. Plain meeting carries Snooze 5m
        let plainCategory = byId[NotificationController.categoryPlain]
        #expect(plainCategory != nil)
        let plainActions = plainCategory?.actions ?? []
        #expect(plainActions.count == 1)
        #expect(plainActions.first?.title == "Snooze 5m")
        #expect(plainActions.first?.identifier == NotificationController.snoozeAction)
        #expect(plainActions.first?.options.isEmpty == true)

        // 4. Notice carries no actions
        let noticeCategory = byId[NotificationController.categoryNotice]
        #expect(noticeCategory != nil)
        #expect(noticeCategory?.actions.isEmpty == true)
    }

    @Test func meetingWithCallMapsParamsOntoContentAndCategory() throws {
        let params: [String: Any] = [
            "key": "meeting_123",
            "title": "Design Review",
            "subtitle": "In 5 minutes",
            "body": "Room 4B",
            "conferenceUrl": "https://meet.google.com/abc-defg-hij",
            "accountId": "acc_work",
            "eventId": "evt_456",
            "deepLink": "magical://event/evt_456",
            "kind": "alert",
        ]

        let content = try #require(NotificationController.makeContent(params: params))
        #expect(content.title == "Design Review")
        #expect(content.subtitle == "In 5 minutes")
        #expect(content.body == "Room 4B")
        #expect(content.categoryIdentifier == NotificationController.categoryWithCall)
        #expect(content.threadIdentifier == "magical.account.acc_work")
        #expect(content.userInfo["key"] as? String == "meeting_123")
        #expect(content.userInfo["conferenceUrl"] as? String == "https://meet.google.com/abc-defg-hij")
    }

    @Test func meetingWithoutCallMapsToPlainCategory() throws {
        let params: [String: Any] = [
            "key": "meeting_plain",
            "title": "One on One",
            "kind": "alert",
        ]

        let content = try #require(NotificationController.makeContent(params: params))
        #expect(content.title == "One on One")
        #expect(content.subtitle.isEmpty)
        #expect(content.categoryIdentifier == NotificationController.categoryPlain)
    }

    @Test func inviteMapsToInviteCategory() throws {
        let params: [String: Any] = [
            "key": "invite_1",
            "title": "Taylor invited you",
            "body": "Sprint Planning",
            "kind": "invite",
        ]

        let content = try #require(NotificationController.makeContent(params: params))
        #expect(content.title == "Taylor invited you")
        #expect(content.body == "Sprint Planning")
        #expect(content.categoryIdentifier == NotificationController.categoryInvite)
    }

    @Test func noticeMapsToNoticeCategory() throws {
        let params: [String: Any] = [
            "key": "notice_1",
            "title": "Calendar Imported",
            "body": "Imported 124 events",
            "kind": "notice",
        ]

        let content = try #require(NotificationController.makeContent(params: params))
        #expect(content.title == "Calendar Imported")
        #expect(content.body == "Imported 124 events")
        #expect(content.categoryIdentifier == NotificationController.categoryNotice)
    }

    @Test func makeContentReturnsNilWhenTitleIsMissing() {
        let params: [String: Any] = [
            "key": "invalid_1",
            "body": "No title here",
        ]
        #expect(NotificationController.makeContent(params: params) == nil)
    }

    @Test func everyRegisteredActionHasAnEventMapping() {
        let registered = NotificationController.makeCategories()
            .flatMap(\.actions)
            .map(\.identifier)
        #expect(Set(registered) == Set([
            NotificationController.joinAction,
            NotificationController.snoozeAction,
            NotificationController.rsvpYes,
            NotificationController.rsvpMaybe,
            NotificationController.rsvpNo,
        ]))

        let userInfo: [String: Any] = [
            "key": "meeting_123",
            "accountId": "acc_work",
        ]
        for identifier in registered {
            #expect(
                NotificationController.makeActionPayload(
                    actionIdentifier: identifier,
                    userInfo: userInfo
                ) != nil
            )
        }
        #expect(
            NotificationController.makeActionPayload(
                actionIdentifier: UNNotificationDefaultActionIdentifier,
                userInfo: userInfo
            ) != nil
        )
    }

    @Test func makeActionPayloadMapsIdentifiersAndExtractsUserInfo() throws {
        let userInfo: [String: Any] = [
            "key": "meeting_123",
            "accountId": "acc_work",
            "eventId": "evt_456",
            "deepLink": "magical://event/evt_456",
            "conferenceUrl": "https://meet.google.com/abc",
        ]

        let cases: [(String, String)] = [
            (NotificationController.joinAction, "join"),
            (NotificationController.snoozeAction, "snooze"),
            (NotificationController.rsvpYes, "rsvp:yes"),
            (NotificationController.rsvpMaybe, "rsvp:maybe"),
            (NotificationController.rsvpNo, "rsvp:no"),
            (UNNotificationDefaultActionIdentifier, "open"),
        ]

        for (actionId, expectedAction) in cases {
            let payload = try #require(NotificationController.makeActionPayload(actionIdentifier: actionId, userInfo: userInfo))
            #expect(payload.action == expectedAction)
            #expect(payload.params["key"] as? String == "meeting_123")
            #expect(payload.params["accountId"] as? String == "acc_work")
            #expect(payload.params["eventId"] as? String == "evt_456")
            #expect(payload.params["deepLink"] as? String == "magical://event/evt_456")
            #expect(payload.params["conferenceUrl"] as? String == "https://meet.google.com/abc")
            #expect(payload.params["action"] as? String == expectedAction)
        }

        #expect(NotificationController.makeActionPayload(actionIdentifier: "unknown.action", userInfo: userInfo) == nil)
    }

    @Test func clearAllDropsCategoriesWithoutABundleIdentity() {
        // An `xctest` bundle carries no Info.plist, so `Bundle.main.bundleIdentifier` is
        // nil here — the same position the helper is in under `pnpm dev`. Reaching the
        // centre from there would abort the process rather than fail, so the clear has to
        // be a safe no-op that still empties the categories.
        let controller = NotificationController.shared
        controller.applyCategories(Set(NotificationController.makeCategories()))
        #expect(controller.registeredCategories.count == 4)

        controller.clearAll()
        #expect(controller.registeredCategories.isEmpty)
    }
}
