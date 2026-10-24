import Foundation
import MagicalHelperLib
import MagimailHelperLib

// MARK: - The diary every shot shows

/// Invented fixtures, shared by widgets and popovers so the website shows
/// consistent mock data rather than unrelated accounts.
///
/// Times are relative to the run, so a shot never dates itself: regenerate it
/// next month and the meetings are still this afternoon.
enum Fixtures {
    static let calendarPersonal = "#9E69AF"
    static let calendarWork = "#039BE5"
    static let calendarFamily = "#C19A00"
    static let calendarTeam = "#0B8043"

    static let mailPersonal = "#34A853"
    static let mailWork = "#4285F4"

    struct Event {
        let id: String
        let title: String
        let start: Date
        let end: Date
        let allDay: Bool
        let colour: String
        let calendar: String
        let conference: String?
    }

    static func day(now: Date) -> [Event] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: now)
        func at(_ hour: Int, _ minute: Int = 0, plusDays days: Int = 0) -> Date {
            calendar.date(byAdding: .minute, value: hour * 60 + minute,
                          to: calendar.date(byAdding: .day, value: days, to: today) ?? today) ?? today
        }

        // A month either side of today, so the popover's grid — which counts
        // its own dots from these events rather than from `densityDots` — reads
        // as a diary rather than as one busy day in an empty month.
        var events: [Event] = (-21 ... 21).flatMap { offset -> [Event] in
            guard offset != 0 else { return [] }
            let weekday = calendar.component(.weekday, from: at(0, 0, plusDays: offset))
            guard weekday != 1, weekday != 7 else { return [] }
            var filler = [
                Event(id: "f\(offset)a", title: "Stand-up",
                      start: at(9, 30, plusDays: offset), end: at(9, 45, plusDays: offset),
                      allDay: false, colour: calendarTeam, calendar: "Team", conference: nil),
            ]
            if abs(offset) % 3 == 0 {
                filler.append(Event(id: "f\(offset)b", title: "Catch-up",
                                    start: at(14, 0, plusDays: offset), end: at(14, 30, plusDays: offset),
                                    allDay: false, colour: calendarWork, calendar: "Work", conference: nil))
            }
            return filler
        }

        events += [
            Event(id: "e1", title: "Sprint planning",
                  start: at(9, 30), end: at(10, 30), allDay: false,
                  colour: calendarTeam, calendar: "Team",
                  conference: "https://meet.google.com/abc-defg-hij"),
            Event(id: "e2", title: "Design review",
                  start: now.addingTimeInterval(14 * 60), end: now.addingTimeInterval(74 * 60),
                  allDay: false, colour: calendarWork, calendar: "Work",
                  conference: "https://meet.google.com/xyz-abcd-efg"),
            Event(id: "e3", title: "Pick up the car",
                  start: at(17), end: at(17, 30), allDay: false,
                  colour: calendarPersonal, calendar: "Personal", conference: nil),
            Event(id: "e4", title: "Family dinner",
                  start: at(19), end: at(21), allDay: false,
                  colour: calendarFamily, calendar: "Family", conference: nil),
            Event(id: "e5", title: "Olivia's birthday",
                  start: at(0, 0, plusDays: 2), end: at(0, 0, plusDays: 3), allDay: true,
                  colour: calendarFamily, calendar: "Family", conference: nil),
            Event(id: "e6", title: "Quarterly planning",
                  start: at(11, 0, plusDays: 2), end: at(12, 30, plusDays: 2), allDay: false,
                  colour: calendarWork, calendar: "Work", conference: nil),
        ]

        return events
    }

    /// Dots across the month, so the grid reads as a diary rather than as a
    /// blank calendar with one busy day.
    static func densityDots(now: Date) -> [String: [CachedDot]] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: now)
        var dots: [String: [CachedDot]] = [:]

        for offset in -21 ... 21 {
            guard let date = calendar.date(byAdding: .day, value: offset, to: today) else { continue }
            let weekday = calendar.component(.weekday, from: date)
            if weekday == 1 || weekday == 7 {
                if offset % 4 == 0 {
                    dots[key(date)] = [
                        CachedDot(accountId: "personal", calendarId: "Family", colorHex: calendarFamily),
                    ]
                }
                continue
            }
            switch abs(offset) % 3 {
            case 0:
                dots[key(date)] = [
                    CachedDot(accountId: "personal", calendarId: "Work", colorHex: calendarWork),
                    CachedDot(accountId: "personal", calendarId: "Team", colorHex: calendarTeam),
                ]
            case 1:
                dots[key(date)] = [
                    CachedDot(accountId: "personal", calendarId: "Work", colorHex: calendarWork),
                ]
            default:
                dots[key(date)] = [
                    CachedDot(accountId: "personal", calendarId: "Team", colorHex: calendarTeam),
                    CachedDot(accountId: "personal", calendarId: "Personal", colorHex: calendarPersonal),
                    CachedDot(accountId: "personal", calendarId: "Work", colorHex: calendarWork),
                ]
            }
        }

        return dots
    }

    static func mailMessages() -> [TrayMessage] {
        let nowMs = Date().timeIntervalSince1970 * 1000
        return [
            TrayMessage(from: [
                "id": "m1", "threadId": "t1", "from": "Nadia Hussain <nadia@example.com>",
                "subject": "Photos from the weekend", "snippet": "Here are the photos from Saturday's hike...",
                "internalDate": "\(Int(nowMs - 22 * 60 * 1000))", "labelIds": ["UNREAD"], "category": "primary",
            ]),
            TrayMessage(from: [
                "id": "m2", "threadId": "t2", "from": "Tom Brennan <tom@example.com>",
                "subject": "Lunch Thursday?", "snippet": "Are you free around 12:30 for sushi?",
                "internalDate": "\(Int(nowMs - 48 * 60 * 1000))", "labelIds": ["UNREAD"], "category": "primary",
            ]),
            TrayMessage(from: [
                "id": "m3", "threadId": "t3", "from": "Holloway Cycles <service@example.com>",
                "subject": "Your service is booked", "snippet": "Confirmed for Saturday at 9am. Please bring...",
                "internalDate": "\(Int(nowMs - 66 * 60 * 1000))", "labelIds": ["UNREAD"], "category": "primary",
            ]),
            TrayMessage(from: [
                "id": "m4", "threadId": "t4", "from": "Priya Raman <priya@example.com>",
                "subject": "Are you around on the 20th?", "snippet": "Let me know if you can make the team dinner",
                "internalDate": "\(Int(nowMs - 99 * 60 * 1000))", "labelIds": ["UNREAD"], "category": "primary",
            ]),
            TrayMessage(from: [
                "id": "m5", "threadId": "t5", "from": "Studio Ops <ops@example.com>",
                "subject": "Parking for Thursday", "snippet": "Your visitor bay has been reserved on Level 2",
                "internalDate": "\(Int(nowMs - 120 * 60 * 1000))", "labelIds": ["UNREAD"], "category": "updates",
            ]),
            TrayMessage(from: [
                "id": "m6", "threadId": "t6", "from": "Hannah Reid <hannah@example.com>",
                "subject": "Budget sign-off", "snippet": "Attached is the Q4 projection for approval",
                "internalDate": "\(Int(nowMs - 140 * 60 * 1000))", "labelIds": ["UNREAD"], "category": "updates",
            ]),
            TrayMessage(from: [
                "id": "m7", "threadId": "t7", "from": "Daniel Okonkwo <daniel@example.com>",
                "subject": "Re: Tuesday's site visit", "snippet": "The contractor agreed to meet at 10am on site",
                "internalDate": "\(Int(nowMs - 180 * 60 * 1000))", "labelIds": ["UNREAD"], "category": "primary",
            ]),
        ]
    }

    private static let dayKeyFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    private static func key(_ date: Date) -> String {
        dayKeyFormatter.string(from: date)
    }
}
