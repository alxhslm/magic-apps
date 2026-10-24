import Foundation
@testable import MagimailHelperLib
import Testing

@Suite("Magimail TrayModel Tests")
@MainActor
struct TrayModelTests {
    private func fixtureURL(named filename: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // Tests/MagimailHelperLibTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // swift
            .deletingLastPathComponent() // apps/magimail
            .appendingPathComponent("tests/fixtures")
            .appendingPathComponent(filename)
    }

    @Test func updatesFromRealTrayUpdateFixture() throws {
        let url = fixtureURL(named: "tray-update.json")
        let data = try Data(contentsOf: url)
        guard var json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            Issue.record("Failed to parse tray-update.json fixture as JSON object")
            return
        }

        let model = TrayModel()
        model.update(from: json)

        #expect(model.accounts.count == 2)
        #expect(model.accounts[0].id == "account_work")
        #expect(model.accounts[0].name == "Work")
        #expect(model.accounts[0].color == "#0096ff")
        #expect(model.accounts[0].unreadCount == 3)
        #expect(model.accounts[0].email == "taylor@example.com")
        #expect(model.accounts[0].needsAuth == false)

        #expect(model.accounts[1].id == "account_personal")
        #expect(model.accounts[1].name == "Personal")
        #expect(model.accounts[1].color == "#73fa79")
        #expect(model.accounts[1].unreadCount == 0)
        #expect(model.accounts[1].email == "taylor.personal@example.com")
        #expect(model.accounts[1].needsAuth == false)

        #expect(model.totalUnread == 3)
        #expect(model.showCount == true)
        #expect(model.showDots == true)
        #expect(model.isOffline == false)
        #expect(model.isRestricted == false)

        // A tenant policy block is its own state, not the offline or sign-in one.
        json["isRestricted"] = true
        model.update(from: json)
        #expect(model.isRestricted == true)
        #expect(model.isOffline == false)
    }

    @Test func setsMessagesFromRealTrayMessagesFixture() throws {
        let url = fixtureURL(named: "tray-messages.json")
        let data = try Data(contentsOf: url)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let accountId = json["accountId"] as? String,
              let rawMessages = json["messages"] as? [[String: Any]]
        else {
            Issue.record("Failed to parse tray-messages.json fixture")
            return
        }

        let messages = rawMessages.map { TrayMessage(from: $0) }
        let model = TrayModel()
        model.setMessages(accountId: accountId, incoming: messages)

        let cached = try #require(model.messagesByAccount[accountId])
        #expect(cached.count == rawMessages.count)

        let msg1 = try #require(cached.first { $0.id == "msg_001" })
        #expect(msg1.threadId == "thread_101")
        #expect(msg1.senderName == "Taylor Smith")
        #expect(msg1.subject == "Q3 Performance Review")
        #expect(msg1.category == .primary)
        #expect(msg1.isUnread == true)

        let msg2 = try #require(cached.first { $0.id == "msg_002" })
        #expect(msg2.threadId == "thread_102")
        #expect(msg2.senderName == "GitHub")
        #expect(msg2.category == .updates)
        #expect(msg2.isUnread == true)

        let msg3 = try #require(cached.first { $0.id == "msg_003" })
        #expect(msg3.threadId == "thread_103")
        #expect(msg3.senderName == "Figma")
        #expect(msg3.category == .promotions)
        #expect(msg3.isUnread == true)

        // A read thread comes back from the cache without `UNREAD`, so it
        // renders as read rather than as a phantom unread.
        let msg4 = try #require(cached.first { $0.id == "msg_004" })
        #expect(msg4.category == .primary)
        #expect(msg4.isUnread == false)

        // Applying archive pulls the row immediately; the cache may still list it.
        model.apply(.archive, accountId: accountId, messageId: "msg_001")
        #expect(model.messagesByAccount[accountId]?.contains { $0.id == "msg_001" } == false)
    }

    @Test func dropsAThreadMissingFromTheNextPayload() {
        let model = TrayModel()
        let accountId = "account_work"
        model.setMessages(accountId: accountId, incoming: [
            trayMessage(id: "msg_001", date: "2000"),
            trayMessage(id: "msg_002", date: "1000"),
        ])
        #expect(model.messagesByAccount[accountId]?.count == 2)

        // msg_001 is deleted or archived in Gmail, so the next cache read is
        // missing it. It must not come back as a muted read row.
        model.setMessages(accountId: accountId, incoming: [trayMessage(id: "msg_002", date: "1000")])

        #expect(model.messagesByAccount[accountId]?.map(\.id) == ["msg_002"])
    }

    @Test func aMarkUnreadSurvivesAStalePayload() {
        let model = TrayModel()
        let accountId = "account_work"
        model.setMessages(accountId: accountId, incoming: [trayMessage(id: "msg_001", unread: false)])

        model.apply(.markUnread, accountId: accountId, messageId: "msg_001")
        #expect(model.messagesByAccount[accountId]?.first?.isUnread == true)

        // Gmail has not written the change yet, so the cache still says read.
        // Presence is not agreement: the row must stay unread, not grey back out.
        model.setMessages(accountId: accountId, incoming: [trayMessage(id: "msg_001", unread: false)])
        #expect(model.messagesByAccount[accountId]?.first?.isUnread == true)

        // The cache catches up, and the local state settles.
        model.setMessages(accountId: accountId, incoming: [trayMessage(id: "msg_001", unread: true)])
        #expect(model.messagesByAccount[accountId]?.first?.isUnread == true)
    }

    @Test func aMarkReadSurvivesAStalePayload() {
        let model = TrayModel()
        let accountId = "account_work"
        model.setMessages(accountId: accountId, incoming: [trayMessage(id: "msg_001", unread: true)])

        model.apply(.markRead, accountId: accountId, messageId: "msg_001")
        #expect(model.messagesByAccount[accountId]?.first?.isUnread == false)

        // The cache still says unread, so the local read state must hold.
        model.setMessages(accountId: accountId, incoming: [trayMessage(id: "msg_001", unread: true)])
        #expect(model.messagesByAccount[accountId]?.first?.isUnread == false)

        model.setMessages(accountId: accountId, incoming: [trayMessage(id: "msg_001", unread: false)])
        #expect(model.messagesByAccount[accountId]?.first?.isUnread == false)
    }

    @Test func anArchivedRowIsDroppedAndSuppressedAgainstAStaleCopy() {
        let model = TrayModel()
        let accountId = "account_work"
        model.setMessages(accountId: accountId, incoming: [
            trayMessage(id: "msg_001", date: "2000"),
            trayMessage(id: "msg_002", date: "1000"),
        ])

        // Archive pulls the row at once, rather than leaving it muted until the
        // cache drops it.
        model.apply(.archive, accountId: accountId, messageId: "msg_001")
        #expect(model.messagesByAccount[accountId]?.map(\.id) == ["msg_002"])

        // The cache has not dropped it yet, so a stale payload still lists it.
        model.setMessages(accountId: accountId, incoming: [
            trayMessage(id: "msg_001", date: "2000"),
            trayMessage(id: "msg_002", date: "1000"),
        ])
        #expect(model.messagesByAccount[accountId]?.map(\.id) == ["msg_002"])

        // The cache catches up.
        model.setMessages(accountId: accountId, incoming: [trayMessage(id: "msg_002", date: "1000")])
        #expect(model.messagesByAccount[accountId]?.map(\.id) == ["msg_002"])
    }

    @Test func aTrashedRowIsDroppedAndSuppressedAgainstAStaleCopy() {
        let model = TrayModel()
        let accountId = "account_work"
        model.setMessages(accountId: accountId, incoming: [trayMessage(id: "msg_001")])

        model.apply(.trash, accountId: accountId, messageId: "msg_001")
        #expect(model.messagesByAccount[accountId]?.isEmpty == true)

        model.setMessages(accountId: accountId, incoming: [trayMessage(id: "msg_001")])
        #expect(model.messagesByAccount[accountId]?.isEmpty == true)
    }

    @Test func showUnreadOnlyHidesReadThreads() {
        let model = TrayModel()
        let accountId = "account_work"
        model.update(from: [
            "accounts": [
                ["id": accountId, "name": "Work", "color": "#0096ff", "unreadCount": 1],
            ],
        ])
        model.setMessages(accountId: accountId, incoming: [
            trayMessage(id: "unread", date: "2000", unread: true),
            trayMessage(id: "read", date: "1000", unread: false),
        ])

        #expect(model.visibleMessages.map(\.message.id) == ["unread", "read"])

        model.showUnreadOnly = true
        #expect(model.visibleMessages.map(\.message.id) == ["unread"])

        model.showUnreadOnly = false
        #expect(model.visibleMessages.map(\.message.id) == ["unread", "read"])
    }

    private func trayMessage(id: String, date: String = "1000", unread: Bool = true) -> TrayMessage {
        TrayMessage(from: [
            "id": id,
            "threadId": id,
            "from": "Sender <sender@example.com>",
            "subject": "A subject",
            "snippet": "A snippet",
            "internalDate": date,
            "category": "primary",
            "labelIds": unread ? ["UNREAD"] : [],
        ])
    }

    @Test func dropsCachedThreadsForAnAccountThatHasGone() {
        let model = TrayModel()
        model.setMessages(accountId: "account_work", incoming: [])
        model.setMessages(accountId: "account_personal", incoming: [])
        model.selectedAccountId = "account_work"

        // An account list without the work account, as a removal sends.
        model.update(from: [
            "accounts": [
                ["id": "account_personal", "name": "Personal", "color": "#73fa79"],
            ],
        ])

        #expect(model.messagesByAccount["account_work"] == nil)
        #expect(model.messagesByAccount["account_personal"] != nil)
        // Nothing may stay filtered to an account that is no longer offered.
        #expect(model.selectedAccountId == nil)
    }
}
