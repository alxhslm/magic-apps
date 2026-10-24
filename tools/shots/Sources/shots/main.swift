import AppKit
import MagicalHelperLib
import MagimailHelperLib
import SwiftUI

// Renders the website's native screenshots from the real views.
// See .agents/skills/rendering-website-shots/SKILL.md.
//
// Usage: swift run shots <output-directory>

let outputDirectory = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : FileManager.default.currentDirectoryPath

let now = Date()
let fixtures = Fixtures.day(now: now)

// MARK: - Writing

/// Renders through an `NSHostingView` in a real window rather than through
/// `ImageRenderer`.
///
/// `ImageRenderer` draws a yellow "unsupported" block for anything AppKit
/// backs, which in the popover is the search field, both menus and every
/// button, and it never realises a `LazyVStack`, so the agenda came out empty.
/// AppKit's own `cacheDisplay` draws what the app draws. The window is never
/// ordered front; it exists because a hosting view lays out against one.
@MainActor
func write(_ name: String, _ view: some View, size: CGSize) {
    let hosting = NSHostingView(rootView: view)
    hosting.frame = CGRect(origin: .zero, size: size)

    let window = NSWindow(
        contentRect: hosting.frame,
        styleMask: [.borderless],
        backing: .buffered,
        defer: false
    )
    window.contentView = hosting
    window.displayIfNeeded()

    // One turn of the run loop, so SwiftUI has laid out and the scroll views
    // have realised their content before the bitmap is taken.
    RunLoop.main.run(until: Date().addingTimeInterval(0.4))
    hosting.layoutSubtreeIfNeeded()

    guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
        print("failed: \(name)")
        exit(1)
    }
    hosting.cacheDisplay(in: hosting.bounds, to: rep)

    guard let png = rep.representation(using: .png, properties: [:]) else {
        print("failed: \(name)")
        exit(1)
    }
    let path = outputDirectory + "/" + name + ".png"
    do {
        try png.write(to: URL(fileURLWithPath: path))
        print("\(name).png  \(Int(size.width))x\(Int(size.height))pt  (\(rep.pixelsWide)x\(rep.pixelsHigh) px)")
    } catch {
        print("failed to write \(path): \(error)")
        exit(1)
    }
}

/// Writes `view` at `width`, with the height measured rather than declared.
///
/// The Focus pane is not a view the host gives a size to, and a height picked for
/// it clipped the last card. SwiftUI knows how tall it wants to be; ask it.
@MainActor
func writeFitted(_ name: String, _ view: some View, width: CGFloat) {
    let hosting = NSHostingView(rootView: view)
    hosting.frame = CGRect(x: 0, y: 0, width: width, height: 2000)
    hosting.layoutSubtreeIfNeeded()
    let fitted = hosting.fittingSize
    write(name, view, size: CGSize(width: width, height: fitted.height))
}

/// A widget as the host presents it: rounded, inset, on its own surface.
struct Tile<Content: View>: View {
    let size: CGSize
    let radius: CGFloat
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(16)
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: radius).fill(Color.white))
            .clipShape(RoundedRectangle(cornerRadius: radius))
            .shadow(color: .black.opacity(0.16), radius: 9, x: 0, y: 4)
    }
}

/// A macOS System Settings Focus Filter card.
struct FocusFilterCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color(white: 0.92), lineWidth: 1))
    }
}

struct ActiveSwitch: View {
    var isOn: Bool = true

    var body: some View {
        ZStack(alignment: isOn ? .trailing : .leading) {
            Capsule()
                .fill(isOn ? Color(red: 0.08, green: 0.48, blue: 0.98) : Color(white: 0.82))
                .frame(width: 38, height: 22)
            Circle()
                .fill(Color.white)
                .frame(width: 18, height: 18)
                .shadow(color: .black.opacity(0.18), radius: 2, x: 0, y: 1)
                .padding(2)
        }
    }
}

struct ActiveCheckbox: View {
    var isChecked: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 3.5, style: .continuous)
                .fill(isChecked ? Color(red: 0.08, green: 0.48, blue: 0.98) : Color.white)
                .overlay(RoundedRectangle(cornerRadius: 3.5, style: .continuous).stroke(isChecked ? Color.clear : Color(white: 0.78), lineWidth: 1))
                .frame(width: 14, height: 14)
            if isChecked {
                Image(systemName: "checkmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white)
            }
        }
    }
}

extension Color {
    /// A colour from the `#rrggbb` the account and calendar files carry.
    init(hex: String) {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let value = UInt32(digits, radix: 16) ?? 0x808080
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

struct FocusRow: Identifiable {
    let name: String
    let isOn: Bool
    /// The account's or calendar's own colour, drawn as a dot the way the
    /// picker draws it.
    var colorHex: String?
    /// The line under the name. The picker puts the account's address there.
    var subtitle: String?

    var id: String {
        name
    }
}

/// One parameter of the intent, drawn as the card System Settings gives it.
///
/// The picker draws one card per `@Parameter`, so an app asking about accounts
/// and then calendars gets two, each with the parameter's own description.
struct FocusSection: Identifiable {
    let title: String
    /// The parameter's description, which the picker shows under the title.
    var caption: String?
    let rows: [FocusRow]

    var id: String {
        title
    }
}

/// The macOS Focus Filter pane for one app, as System Settings draws it.
///
/// The real pane belongs to the system, so it cannot be rendered from the app's
/// own views the way the popover and the widgets are; this stands in for it, and
/// keeps a real account list out of the shot while it does. The two panes differ
/// in the app's name, its sentence and the parameters its intent asks about.
struct FocusFilterPane: View {
    let appName: String
    /// The app's icon, relative to the repository root. Taken from the committed
    /// artwork rather than from `/Applications`, so a render does not depend on
    /// which build happens to be installed.
    let iconPath: String
    let summary: String
    let sections: [FocusSection]

    var body: some View {
        VStack(spacing: 14) {
            FocusFilterCard {
                HStack(alignment: .top, spacing: 14) {
                    Image(nsImage: icon)
                        .resizable()
                        .frame(width: 44, height: 44)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(appName)
                            .font(.system(size: 15, weight: .semibold))
                        Text(summary)
                            .font(.system(size: 11.5))
                            .foregroundStyle(Color.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 12)
                    ActiveSwitch(isOn: true)
                }
            }

            ForEach(sections) { section in
                FocusFilterCard {
                    VStack(alignment: .leading, spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(section.title)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(.primary)
                            if let caption = section.caption {
                                Text(caption)
                                    .font(.system(size: 11))
                                    .foregroundStyle(Color.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }

                        Divider()
                            .overlay(Color(white: 0.92))

                        ForEach(section.rows) { row in
                            HStack(spacing: 9) {
                                ActiveCheckbox(isChecked: row.isOn)
                                if let hex = row.colorHex {
                                    Circle()
                                        .fill(Color(hex: hex))
                                        .frame(width: 9, height: 9)
                                }
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(row.name)
                                        .font(.system(size: 13))
                                    if let subtitle = row.subtitle {
                                        Text(subtitle)
                                            .font(.system(size: 10.5))
                                            .foregroundStyle(Color.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
            }

            FocusFilterCard {
                HStack {
                    Text("Prevent Access to Silenced Accounts")
                        .font(.system(size: 13))
                    Spacer()
                    ActiveSwitch(isOn: true)
                }
            }
        }
        .padding(16)
        .frame(width: 420)
        .background(Color(red: 0.98, green: 0.98, blue: 0.99))
        .environment(\.colorScheme, .light)
    }

    /// The app's own icon, which is what the real pane shows.
    private var icon: NSImage {
        let path = Self.repoRoot.appendingPathComponent(iconPath).path
        return NSImage(contentsOfFile: path) ?? NSWorkspace.shared.icon(forFile: path)
    }

    /// The repository root, from this file's path, so the icon paths above read
    /// the way they do in the tree.
    private static var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }
}

// MARK: - Magical Fixtures

let magicalWidgetCache = MagicalHelperLib.WidgetCache(
    updatedAt: now.timeIntervalSince1970 * 1000,
    events: fixtures.map { event in
        MagicalHelperLib.CachedEvent(
            id: event.id,
            accountId: "personal",
            calendarIds: [event.calendar],
            title: event.title,
            start: event.start.timeIntervalSince1970 * 1000,
            end: event.end.timeIntervalSince1970 * 1000,
            isAllDay: event.allDay,
            colorHex: event.colour,
            joinUrl: event.conference,
            conferenceService: event.conference == nil ? nil : "Google Meet",
            openUrl: "magical://open"
        )
    },
    densityDots: Fixtures.densityDots(now: now),
    calendars: [
        MagicalHelperLib.CachedCalendar(
            accountId: "personal",
            calendarId: "Personal",
            accountName: "you@example.com",
            name: "Personal",
            colorHex: Fixtures.calendarPersonal
        ),
        MagicalHelperLib.CachedCalendar(
            accountId: "personal",
            calendarId: "Work",
            accountName: "you@example.com",
            name: "Work",
            colorHex: Fixtures.calendarWork
        ),
    ],
    hiddenCalendars: [],
    activeAccountId: "personal"
)

let magicalTrayPayload: [String: Any] = [
    "accounts": [
        ["id": "personal", "name": "Personal", "color": Fixtures.calendarPersonal,
         "email": "you@example.com", "unreadCount": 0, "needsAuth": false],
    ],
    "calendars": [
        ["id": "personal", "accountId": "personal", "name": "Personal",
         "colorHex": Fixtures.calendarPersonal],
        ["id": "family", "accountId": "personal", "name": "Family",
         "colorHex": Fixtures.calendarFamily],
        ["id": "birthdays", "accountId": "personal", "name": "Birthdays",
         "colorHex": Fixtures.calendarTeam],
    ] as [[String: Any]],
    "events": fixtures.map { event -> [String: Any] in
        var raw: [String: Any] = [
            "id": event.id,
            "accountId": "personal",
            "calendarIds": [event.calendar],
            "calendarName": event.calendar,
            "summary": event.title,
            "startTime": event.start.timeIntervalSince1970 * 1000,
            "endTime": event.end.timeIntervalSince1970 * 1000,
            "isAllDay": event.allDay,
            "colorHex": event.colour,
            "myResponseStatus": 1,
        ]
        if let conference = event.conference {
            raw["conferenceUrl"] = conference
        }
        return raw
    },
    "activeAccountId": "personal",
    "isCalendarCollapsed": false,
    "isOffline": false,
    "menuBarDisplayMode": "nextEvent",
    "showMenuBarAccountColor": true,
    "hiddenCalendarIds": [] as [String],
]

/// Tasks as the agenda draws them: two open, one finished, dated today so the
/// group is the one the reader sees first.
let magicalTasksPayload: [String: Any] = [
    "accounts": [
        ["id": "personal", "name": "Personal", "color": Fixtures.calendarPersonal,
         "email": "you@example.com", "unreadCount": 0, "needsAuth": false],
    ],
    "calendars": [
        ["id": "tasks", "accountId": "personal", "name": "Tasks",
         "colorHex": Fixtures.calendarTeam],
        ["id": "personal", "accountId": "personal", "name": "Personal",
         "colorHex": Fixtures.calendarPersonal],
    ] as [[String: Any]],
    "events": [
        [
            "id": "t1", "accountId": "personal", "calendarIds": ["tasks"],
            "calendarName": "Tasks", "summary": "Review the Q4 deck",
            "startTime": Date().timeIntervalSince1970 * 1000,
            "endTime": Date().addingTimeInterval(1800).timeIntervalSince1970 * 1000,
            "isAllDay": true, "colorHex": Fixtures.calendarTeam,
            "myResponseStatus": 1, "eventType": 9, "isCompleted": false,
        ],
        [
            "id": "t2", "accountId": "personal", "calendarIds": ["tasks"],
            "calendarName": "Tasks", "summary": "Send the invoice to Priya",
            "startTime": Date().timeIntervalSince1970 * 1000,
            "endTime": Date().addingTimeInterval(1800).timeIntervalSince1970 * 1000,
            "isAllDay": true, "colorHex": Fixtures.calendarTeam,
            "myResponseStatus": 1, "eventType": 9, "isCompleted": false,
        ],
        [
            "id": "t3", "accountId": "personal", "calendarIds": ["tasks"],
            "calendarName": "Tasks", "summary": "Book the flights",
            "startTime": Date().timeIntervalSince1970 * 1000,
            "endTime": Date().addingTimeInterval(1800).timeIntervalSince1970 * 1000,
            "isAllDay": true, "colorHex": Fixtures.calendarTeam,
            "myResponseStatus": 1, "eventType": 9, "isCompleted": true,
        ],
        [
            "id": "t4", "accountId": "personal", "calendarIds": ["personal"],
            "calendarName": "Personal", "summary": "Design review",
            "startTime": Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000,
            "endTime": Date().addingTimeInterval(5400).timeIntervalSince1970 * 1000,
            "isAllDay": false, "colorHex": Fixtures.calendarPersonal,
            "myResponseStatus": 1,
        ],
    ],
    "activeAccountId": "personal",
    "isCalendarCollapsed": true,
    "isOffline": false,
    "menuBarDisplayMode": "nextEvent",
    "showMenuBarAccountColor": true,
    "hiddenCalendarIds": [] as [String],
    "showCompletedTasks": true,
]

let magicalInviteTrayPayload: [String: Any] = [
    "accounts": [
        ["id": "work", "name": "Work", "color": Fixtures.calendarWork,
         "email": "taylor@example.com", "unreadCount": 2, "needsAuth": false],
        ["id": "personal", "name": "Personal", "color": Fixtures.calendarPersonal,
         "email": "you@example.com", "unreadCount": 0, "needsAuth": false],
    ],
    "calendars": [
        ["id": "work", "accountId": "work", "name": "Work",
         "colorHex": Fixtures.calendarWork],
        ["id": "team", "accountId": "work", "name": "Team",
         "colorHex": Fixtures.calendarTeam],
        ["id": "personal", "accountId": "personal", "name": "Personal",
         "colorHex": Fixtures.calendarPersonal],
        ["id": "family", "accountId": "personal", "name": "Family",
         "colorHex": Fixtures.calendarFamily],
    ] as [[String: Any]],
    "events": fixtures.map { event -> [String: Any] in
        var raw: [String: Any] = [
            "id": event.id,
            "accountId": "work",
            "calendarIds": [event.calendar],
            "calendarName": event.calendar,
            "summary": event.title,
            "startTime": event.start.timeIntervalSince1970 * 1000,
            "endTime": event.end.timeIntervalSince1970 * 1000,
            "isAllDay": event.allDay,
            "colorHex": event.colour,
            "myResponseStatus": event.id == "e2" ? 0 : (event.id == "e3" ? 2 : 1),
        ]
        if let conference = event.conference {
            raw["conferenceUrl"] = conference
        }
        return raw
    },
    "activeAccountId": "work",
    "isCalendarCollapsed": false,
    "isOffline": false,
    "menuBarDisplayMode": "nextEvent",
    "showMenuBarAccountColor": true,
    "hiddenCalendarIds": [] as [String],
]

// MARK: - Magimail Fixtures

let magimailMessages = Fixtures.mailMessages()

let magimailWidgetCache = MagimailHelperLib.WidgetCache(
    updatedAt: now.timeIntervalSince1970 * 1000,
    totalUnread: 7,
    accounts: [
        MagimailHelperLib.CachedAccount(id: "personal", name: "Personal", color: Fixtures.mailPersonal, email: "you@example.com", unreadCount: 4),
        MagimailHelperLib.CachedAccount(id: "work", name: "Work", color: Fixtures.mailWork, email: "taylor@example.com", unreadCount: 3),
    ],
    messages: magimailMessages.map { msg in
        MagimailHelperLib.CachedMessage(
            id: msg.id,
            threadId: msg.threadId,
            accountId: msg.id.hasPrefix("m5") || msg.id.hasPrefix("m6") || msg.id.hasPrefix("m7") ? "work" : "personal",
            sender: msg.senderName,
            subject: msg.subject,
            snippet: msg.snippet,
            date: msg.sortKey,
            category: msg.category.rawValue
        )
    }
)

let magimailTrayParams: [String: Any] = [
    "accounts": [
        ["id": "personal", "name": "Personal", "color": Fixtures.mailPersonal, "unreadCount": 4, "email": "you@example.com", "needsAuth": false],
        ["id": "work", "name": "Work", "color": Fixtures.mailWork, "unreadCount": 3, "email": "taylor@example.com", "needsAuth": false],
    ],
    "totalUnread": 7,
    "showCount": true,
    "showDots": true,
    "isOffline": false,
]

// MARK: - App & Render

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

MainActor.assumeIsolated {
    // 1. Magical widgets
    write("shot-widgets-magical", VStack(spacing: 22) {
        HStack(alignment: .top, spacing: 22) {
            Tile(size: CGSize(width: 155, height: 155), radius: 22) {
                MagicalHelperLib.UpNextSmallView(cache: magicalWidgetCache, now: now)
            }
            Tile(size: CGSize(width: 324, height: 155), radius: 24) {
                MagicalHelperLib.AgendaMediumView(cache: magicalWidgetCache, now: now)
            }
        }
        Tile(size: CGSize(width: 324, height: 324), radius: 26) {
            MagicalHelperLib.MonthLargeView(cache: magicalWidgetCache, now: now)
        }
    }
    .padding(30)
    .background(Color(red: 0.937, green: 0.937, blue: 0.949))
    .environment(\.colorScheme, .light), size: CGSize(width: 561, height: 561))

    // 2. Magical popover
    let magicalModel = MagicalHelperLib.TrayModel.shared
    magicalModel.update(from: magicalTrayPayload)

    let magicalPopover = MagicalHelperLib.TrayPopoverView(
        onOpenApp: {}, onSearch: { _, _ in }, onQuickAdd: { _ in },
        onOpenSettings: {}, onQuit: {}, onJoinCall: { _ in },
        onSelectEvent: { _ in }, onRsvp: { _, _ in }, onShowAccount: { _ in },
        onRefresh: {}, onDeleteEvent: nil
    )
    .environmentObject(magicalModel)
    .frame(width: MagicalHelperLib.TrayPopoverMetrics.defaultWidth,
           height: MagicalHelperLib.TrayPopoverMetrics.expandedHeight)
    .background(Color(red: 0.98, green: 0.98, blue: 0.99))
    .clipShape(RoundedRectangle(cornerRadius: 12))
    .shadow(color: .black.opacity(0.18), radius: 12, x: 0, y: 6)
    .padding(26)
    .background(Color(red: 0.937, green: 0.937, blue: 0.949))
    .environment(\.colorScheme, .light)

    write("shot-popover-magical", magicalPopover,
          size: CGSize(width: MagicalHelperLib.TrayPopoverMetrics.defaultWidth + 52,
                       height: MagicalHelperLib.TrayPopoverMetrics.expandedHeight + 52))

    // 2b. Magical Invitation Popover with RSVP states & Reply Needed hero
    let magicalInviteModel = MagicalHelperLib.TrayModel()
    magicalInviteModel.update(from: magicalInviteTrayPayload)

    let magicalInvitePopover = MagicalHelperLib.TrayPopoverView(
        onOpenApp: {}, onSearch: { _, _ in }, onQuickAdd: { _ in },
        onOpenSettings: {}, onQuit: {}, onJoinCall: { _ in },
        onSelectEvent: { _ in }, onRsvp: { _, _ in }, onShowAccount: { _ in },
        onRefresh: {}, onDeleteEvent: nil
    )
    .environmentObject(magicalInviteModel)
    .frame(width: MagicalHelperLib.TrayPopoverMetrics.defaultWidth,
           height: MagicalHelperLib.TrayPopoverMetrics.expandedHeight)
    .background(Color(red: 0.98, green: 0.98, blue: 0.99))
    .clipShape(RoundedRectangle(cornerRadius: 12))
    .shadow(color: .black.opacity(0.18), radius: 12, x: 0, y: 6)
    .padding(26)
    .background(Color(red: 0.937, green: 0.937, blue: 0.949))
    .environment(\.colorScheme, .light)

    write("shot-invitations-magical", magicalInvitePopover,
          size: CGSize(width: MagicalHelperLib.TrayPopoverMetrics.defaultWidth + 52,
                       height: MagicalHelperLib.TrayPopoverMetrics.expandedHeight + 52))

    // 3. Magimail widgets
    //
    // All four, at true size: a shot that leaves one out cannot show that one
    // still draws, and Quick Actions is the widget whose two accounts take the
    // side-by-side tile layout rather than the chip grid.
    write("shot-widgets", HStack(alignment: .top, spacing: 22) {
        VStack(alignment: .leading, spacing: 22) {
            Tile(size: CGSize(width: 155, height: 155), radius: 22) {
                MagimailHelperLib.SmallWidgetView(cache: magimailWidgetCache)
            }
            Tile(size: CGSize(width: 324, height: 324), radius: 26) {
                MagimailHelperLib.DashboardWidgetView(cache: magimailWidgetCache)
            }
        }
        VStack(alignment: .leading, spacing: 22) {
            Tile(size: CGSize(width: 324, height: 155), radius: 24) {
                MagimailHelperLib.QuickActionsWidgetView(cache: magimailWidgetCache)
            }
            Tile(size: CGSize(width: 324, height: 155), radius: 24) {
                MagimailHelperLib.RecentsWidgetView(cache: magimailWidgetCache)
            }
        }
    }
    .padding(30)
    .background(Color(red: 0.937, green: 0.937, blue: 0.949))
    .environment(\.colorScheme, .light), size: CGSize(width: 730, height: 561))

    // 4. Magimail popover
    let magimailModel = MagimailHelperLib.TrayModel.shared
    magimailModel.update(from: magimailTrayParams)
    magimailModel.setMessages(
        accountId: "personal",
        incoming: magimailMessages.filter { !$0.id.hasPrefix("m5") && !$0.id.hasPrefix("m6") && !$0.id.hasPrefix("m7") }
    )
    magimailModel.setMessages(
        accountId: "work",
        incoming: magimailMessages.filter { $0.id.hasPrefix("m5") || $0.id.hasPrefix("m6") || $0.id.hasPrefix("m7") }
    )

    let magimailPopover = MagimailHelperLib.TrayPopoverView(
        onCompose: { _ in },
        onShowAccount: { _ in },
        onShowThread: { _, _ in },
        onThreadAction: { _, _, _ in },
        onOpenApp: {},
        onSearch: { _, _ in },
        onRefresh: {},
        onOpenSettings: {},
        onQuit: {},
        onUnreadOnlyChanged: { _ in }
    )
    .environmentObject(magimailModel)
    .frame(width: MagimailHelperLib.TrayPopoverMetrics.width, height: 420)
    .background(Color(red: 0.98, green: 0.98, blue: 0.99))
    .clipShape(RoundedRectangle(cornerRadius: 12))
    .shadow(color: .black.opacity(0.18), radius: 12, x: 0, y: 6)
    .padding(26)
    .background(Color(red: 0.937, green: 0.937, blue: 0.949))
    .environment(\.colorScheme, .light)

    write("shot-popover", magimailPopover,
          size: CGSize(width: MagimailHelperLib.TrayPopoverMetrics.width + 52,
                       height: 420 + 52))

    // 5. Focus Filter panes
    //
    // Both apps' panes, from the same view, so a change to the system's Focus
    // card shows up in one place rather than drifting between the two shots. The
    // copy is the app's own `SetFocusFilterIntent`, and the rows are the accounts
    // or calendars that intent offers.
    writeFitted("shot-focus", FocusFilterPane(
        appName: "Magimail",
        iconPath: "apps/magimail/build/icon.icns",
        summary: "Choose which accounts stay active during this Focus. The rest are silenced and left out of the menu bar, widgets and unread count.",
        sections: [
            // Magimail's account entity carries a name and a colour dot and no
            // subtitle, so this card has none: the pane draws what the intent offers.
            FocusSection(
                title: "Accounts",
                caption: "Turning an account off silences it.",
                rows: [
                    FocusRow(name: "Personal", isOn: true, colorHex: "#1a73e8"),
                    FocusRow(name: "Work", isOn: false, colorHex: "#0f9d58"),
                ]
            ),
        ]
    ), width: 420)

    // Magical asks two questions, so its pane carries two cards: the accounts
    // that stay on, and then which of their calendars matter. An account left
    // off silences every calendar it has.
    writeFitted("shot-focus-magical", FocusFilterPane(
        appName: "Magical",
        iconPath: "apps/magical/build/icon.icns",
        summary: "Choose which accounts and calendars stay active during this Focus. The rest are silenced and left out of the menu bar and the popover.",
        sections: [
            FocusSection(
                title: "Accounts",
                caption: "Turning an account off silences every calendar it has.",
                rows: [
                    FocusRow(
                        name: "Personal",
                        isOn: true,
                        colorHex: "#1a73e8",
                        subtitle: "taylor@example.com"
                    ),
                    FocusRow(
                        name: "Work",
                        isOn: false,
                        colorHex: "#0f9d58",
                        subtitle: "taylor@work.example.com"
                    ),
                ]
            ),
            FocusSection(
                title: "Calendars",
                caption: "Pick which individual calendars remain active for unsilenced accounts.",
                rows: [
                    FocusRow(
                        name: "Personal · Family",
                        isOn: true,
                        colorHex: "#7b1fa2",
                        subtitle: "taylor@example.com"
                    ),
                    FocusRow(
                        name: "Personal · Birthdays",
                        isOn: true,
                        colorHex: "#0b8043",
                        subtitle: "taylor@example.com"
                    ),
                    FocusRow(
                        name: "Work · Team",
                        isOn: false,
                        colorHex: "#f4511e",
                        subtitle: "taylor@work.example.com"
                    ),
                    FocusRow(
                        name: "Work · Holidays",
                        isOn: false,
                        colorHex: "#039be5",
                        subtitle: "taylor@work.example.com"
                    ),
                ]
            ),
        ]
    ), width: 420)

    // 6. Magical tasks, drawn by the agenda the popover uses
    let magicalTasksModel = MagicalHelperLib.TrayModel()
    magicalTasksModel.update(from: magicalTasksPayload)

    let magicalTasks = MagicalHelperLib.ScheduleAgendaView(
        feedItems: magicalTasksModel.scheduleFeedItems,
        selectedDate: Date(),
        onSelectEvent: { _ in }, onJoinCall: { _ in }, onRsvp: { _, _ in },
        onDeleteEvent: { _ in }, onCompleteTask: { _, _ in },
        isExplainedElsewhere: true
    )
    .frame(width: 340, height: 300)
    .background(Color(red: 0.98, green: 0.98, blue: 0.99))
    .clipShape(RoundedRectangle(cornerRadius: 12))
    .shadow(color: .black.opacity(0.18), radius: 12, x: 0, y: 6)
    .padding(26)
    .background(Color(red: 0.937, green: 0.937, blue: 0.949))
    .environment(\.colorScheme, .light)

    write("shot-tasks-magical", magicalTasks, size: CGSize(width: 340 + 52, height: 300 + 52))
}
