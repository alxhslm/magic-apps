import Foundation
@testable import MagimailHelperLib
import Testing
import UserNotifications

@Suite("Magimail NotificationController Tests")
@MainActor
struct NotificationControllerTests {
    @Test func notificationCategoriesCarryExpectedActions() {
        let categories = NotificationController.makeCategories()
        #expect(categories.count == 1)
        let byId = Dictionary(uniqueKeysWithValues: categories.map { ($0.identifier, $0) })

        let msgCategory = byId[NotificationController.categoryId]
        #expect(msgCategory != nil)

        let actions = msgCategory?.actions ?? []
        #expect(actions.count == 3)

        let archive = actions.first(where: { $0.identifier == NotificationController.archiveAction })
        #expect(archive?.title == "Archive")
        #expect(archive?.options.isEmpty == true)

        let markRead = actions.first(where: { $0.identifier == NotificationController.markReadAction })
        #expect(markRead?.title == "Mark Read")
        #expect(markRead?.options.isEmpty == true)

        let trash = actions.first(where: { $0.identifier == NotificationController.trashAction })
        #expect(trash?.title == "Delete")
        #expect(trash?.options.contains(.destructive) == true)
    }

    @Test func parseSenderNameHandlesVariousFormats() {
        #expect(NotificationController.parseSenderName("") == "Unknown")
        #expect(NotificationController.parseSenderName("Taylor Smith <taylor@example.com>") == "Taylor Smith")
        #expect(NotificationController.parseSenderName("\"Alice Smith\" <alice@example.com>") == "Alice Smith")
        #expect(NotificationController.parseSenderName("bob@example.com") == "bob@example.com")
        #expect(NotificationController.parseSenderName("   Team Magimail   ") == "Team Magimail")
    }

    @Test func messageWithSnippetMapsSubjectToSubtitleAndSnippetToBody() {
        let msg: [String: Any] = [
            "id": "msg_123",
            "threadId": "thread_abc",
            "from": "GitHub <notifications@github.com>",
            "subject": "Review requested",
            "snippet": "Taylor Smith requested your review.",
            "category": "updates",
        ]

        let content = NotificationController.makeContent(from: msg, accountId: "acc_1", level: "loud")
        #expect(content.title == "GitHub")
        #expect(content.subtitle == "Review requested")
        #expect(content.body == "Taylor Smith requested your review.")
        #expect(content.categoryIdentifier == NotificationController.categoryId)
        #expect(content.threadIdentifier == "magimail.category.updates")
        #expect(content.sound == .default)
        #expect(content.userInfo["accountId"] as? String == "acc_1")
        #expect(content.userInfo["messageId"] as? String == "thread_abc")
        #expect(content.userInfo["level"] as? String == "loud")
    }

    @Test func messageWithoutSnippetMapsSubjectToBody() {
        let msg: [String: Any] = [
            "id": "msg_456",
            "from": "Ops Team",
            "subject": "System maintenance alert",
            "snippet": "",
            "category": "primary",
        ]

        let content = NotificationController.makeContent(from: msg, accountId: "acc_2", level: "silent")
        #expect(content.title == "Ops Team")
        #expect(content.subtitle.isEmpty)
        #expect(content.body == "System maintenance alert")
        #expect(content.categoryIdentifier == NotificationController.categoryId)
        #expect(content.threadIdentifier == "magimail.category.primary")
        #expect(content.sound == nil)
    }

    @Test func messageFallsBackToIdAndNoSubjectWhenOmitted() {
        let msg: [String: Any] = [
            "id": "standalone_999",
            "from": "alice@example.com",
        ]

        let content = NotificationController.makeContent(from: msg, accountId: "acc_1", level: "loud")
        #expect(content.userInfo["messageId"] as? String == "standalone_999")
        #expect(content.body == "(no subject)")
    }

    @Test func everyRegisteredActionHasAnEventMapping() {
        let registered = NotificationController.makeCategories()
            .flatMap(\.actions)
            .map(\.identifier)
        #expect(Set(registered) == Set([
            NotificationController.archiveAction,
            NotificationController.markReadAction,
            NotificationController.trashAction,
        ]))

        let userInfo: [String: Any] = [
            "accountId": "acc_1",
            "messageId": "msg_123",
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
            "accountId": "acc_1",
            "messageId": "msg_123",
        ]

        let actionCases: [(String, String)] = [
            (NotificationController.archiveAction, "archive"),
            (NotificationController.markReadAction, "markRead"),
            (NotificationController.trashAction, "trash"),
        ]

        for (actionId, expectedAction) in actionCases {
            let payload = try #require(NotificationController.makeActionPayload(actionIdentifier: actionId, userInfo: userInfo))
            #expect(payload.method == "notify.action")
            #expect(payload.params["accountId"] as? String == "acc_1")
            #expect(payload.params["messageId"] as? String == "msg_123")
            #expect(payload.params["action"] as? String == expectedAction)
        }

        let clickPayload = try #require(NotificationController.makeActionPayload(actionIdentifier: UNNotificationDefaultActionIdentifier, userInfo: userInfo))
        #expect(clickPayload.method == "notify.click")
        #expect(clickPayload.params["accountId"] as? String == "acc_1")
        #expect(clickPayload.params["messageId"] as? String == "msg_123")
        #expect(clickPayload.params["action"] == nil)

        #expect(NotificationController.makeActionPayload(actionIdentifier: "unknown.action", userInfo: userInfo) == nil)
    }

    @Test func clearAllDropsCategoriesWithoutABundleIdentity() {
        // An `xctest` bundle carries no Info.plist, so `Bundle.main.bundleIdentifier` is
        // nil here — the same position the helper is in under `pnpm dev`. Reaching the
        // centre from there would abort the process rather than fail, so the clear has to
        // be a safe no-op that still empties the categories.
        let controller = NotificationController.shared
        controller.applyCategories(Set(NotificationController.makeCategories()))
        #expect(controller.registeredCategories.count == 1)

        controller.clearAll()
        #expect(controller.registeredCategories.isEmpty)
    }
}
