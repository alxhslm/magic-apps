import Foundation
@testable import MagimailHelperLib
import Testing

/// The widget cache is a file written by another process in another language,
/// so these cover the decoding contract rather than the layout: what the
/// Electron side writes has to survive the trip, and a snapshot from before a
/// field existed has to load rather than blank every widget.
@Suite("Widget Cache Tests")
struct WidgetCacheTests {
    /// The snapshot as `buildWidgetCache` writes it, with the fields these
    /// tests do not care about kept minimal but present.
    private func snapshotJSON(unread: String?) -> Data {
        let unreadField = unread.map { #","unread":\#($0)"# } ?? ""
        let json = """
        {
          "updatedAt": 1700000000000,
          "totalUnread": 1,
          "accounts": [
            {"id": "a1", "name": "Work", "color": "#039be5", "email": "me@work.com", "unreadCount": 1}
          ],
          "messages": [
            {
              "id": "m1",
              "threadId": "t1",
              "accountId": "a1",
              "sender": "Ada",
              "subject": "Standup notes",
              "snippet": "Here are the notes",
              "date": 1700000000000,
              "category": "primary"\(unreadField)
            }
          ]
        }
        """
        return Data(json.utf8)
    }

    private func decode(_ data: Data) throws -> WidgetCache {
        try JSONDecoder().decode(WidgetCache.self, from: data)
    }

    @Test func readsTheUnreadFlagFromTheSnapshot() throws {
        let unread = try decode(snapshotJSON(unread: "true"))
        #expect(unread.messages.first?.isUnread == true)

        let read = try decode(snapshotJSON(unread: "false"))
        #expect(read.messages.first?.isUnread == false)
    }

    @Test func treatsAnAbsentUnreadFlagAsUnread() throws {
        // A snapshot written before the field existed must still decode. It is
        // drawn as unread: that is how the widget drew every row before, and
        // how the popover reads an omitted flag.
        let older = try decode(snapshotJSON(unread: nil))
        #expect(older.messages.first?.unread == nil)
        #expect(older.messages.first?.isUnread == true)
    }

    @Test func carriesUnreadThroughTheInit() {
        let message = CachedMessage(
            id: "m1",
            threadId: "t1",
            accountId: "a1",
            sender: "Ada",
            subject: "Standup notes",
            snippet: "Here are the notes",
            date: 1_700_000_000_000,
            unread: false
        )
        #expect(message.isUnread == false)
    }

    @Test func onlyUnreadTakesReadThreadsOut() {
        let snapshot = WidgetCache(
            updatedAt: 0,
            totalUnread: 1,
            accounts: [],
            messages: [
                CachedMessage(
                    id: "m1",
                    threadId: "t1",
                    accountId: "a1",
                    sender: "Ada",
                    subject: "Unread",
                    snippet: "",
                    date: 2,
                    unread: true
                ),
                CachedMessage(
                    id: "m2",
                    threadId: "t2",
                    accountId: "a1",
                    sender: "Ada",
                    subject: "Read",
                    snippet: "",
                    date: 1,
                    unread: false
                ),
            ]
        )

        let filtered = snapshot.onlyUnread()

        #expect(filtered.messages.map(\.id) == ["m1"])
        // The header and the account chips draw the totals, which mean the same thing
        // either way, so only the list is filtered.
        #expect(filtered.totalUnread == 1)
    }

    @Test func onlyUnreadLeavesNothingWhenEveryThreadIsRead() {
        let snapshot = WidgetCache(
            updatedAt: 0,
            totalUnread: 0,
            accounts: [],
            messages: [
                CachedMessage(
                    id: "m1",
                    threadId: "t1",
                    accountId: "a1",
                    sender: "Ada",
                    subject: "Read",
                    snippet: "",
                    date: 1,
                    unread: false
                ),
            ]
        )

        // An empty list is what draws "all caught up".
        #expect(snapshot.onlyUnread().messages.isEmpty)
    }
}
