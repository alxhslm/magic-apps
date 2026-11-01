import Foundation
@testable import MagicalHelperLib
import Testing

@Suite("TimedEventCluster Tests")
struct TimedEventClusterTests {
    private func makeEvent(
        id: String,
        calendarId: String,
        startTime: Date,
        durationMinutes: Int
    ) -> TrayEvent {
        let endTime = startTime.addingTimeInterval(TimeInterval(durationMinutes * 60))
        return TrayEvent(from: [
            "id": id,
            "accountId": "acc_1",
            "calendarIds": [calendarId],
            "calendarName": "Calendar",
            "summary": "Meeting \(id)",
            "startTime": startTime.timeIntervalSince1970 * 1000,
            "endTime": endTime.timeIntervalSince1970 * 1000,
            "isAllDay": false,
            "colorHex": "#039BE5",
        ])
    }

    @Test("Sequential events form separate single-event clusters")
    func sequentialEventsDoNotCluster() {
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        let e1 = makeEvent(id: "e1", calendarId: "cal_1", startTime: base, durationMinutes: 60)
        let e2 = makeEvent(id: "e2", calendarId: "cal_1", startTime: base.addingTimeInterval(3600), durationMinutes: 60)

        let clusters = TimedEventCluster.cluster(timedEvents: [e1, e2])
        #expect(clusters.count == 2)
        #expect(!clusters[0].isConcurrent)
        #expect(!clusters[1].isConcurrent)
        #expect(clusters[0].events.count == 1)
        #expect(clusters[1].events.count == 1)
    }

    @Test("Overlapping events from different calendars form concurrent cluster")
    func overlappingEventsDifferentCalendars() {
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        let e1 = makeEvent(id: "e1", calendarId: "cal_work", startTime: base, durationMinutes: 60)
        let e2 = makeEvent(id: "e2", calendarId: "cal_personal", startTime: base.addingTimeInterval(1800), durationMinutes: 60)

        let clusters = TimedEventCluster.cluster(timedEvents: [e1, e2])
        #expect(clusters.count == 1)
        #expect(clusters[0].isConcurrent)
        #expect(clusters[0].events.count == 2)
    }

    @Test("Overlapping events from the same calendar form concurrent cluster")
    func overlappingEventsSameCalendar() {
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        let e1 = makeEvent(id: "e1", calendarId: "cal_primary", startTime: base, durationMinutes: 60)
        let e2 = makeEvent(id: "e2", calendarId: "cal_primary", startTime: base.addingTimeInterval(1800), durationMinutes: 60)

        let clusters = TimedEventCluster.cluster(timedEvents: [e1, e2])
        #expect(clusters.count == 1)
        #expect(clusters[0].isConcurrent)
        #expect(clusters[0].events.count == 2)
    }

    @Test("Top offset is zero for identical start times")
    func topOffsetIdenticalStartTimes() {
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        let e1 = makeEvent(id: "e1", calendarId: "cal_1", startTime: base, durationMinutes: 60)
        let e2 = makeEvent(id: "e2", calendarId: "cal_2", startTime: base, durationMinutes: 60)

        let cluster = TimedEventCluster(id: "c1", events: [e1, e2])
        #expect(cluster.topOffset(for: 0) == 0)
        #expect(cluster.topOffset(for: 1) == 0)
    }

    @Test("Top offset is proportional to start-time difference")
    func topOffsetProportionalToStartTimeDelta() {
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        let e1 = makeEvent(id: "e1", calendarId: "cal_1", startTime: base, durationMinutes: 60)
        // 30 minutes later: 30 * 0.75 = 22.5pt
        let e2 = makeEvent(id: "e2", calendarId: "cal_1", startTime: base.addingTimeInterval(1800), durationMinutes: 60)

        let cluster = TimedEventCluster(id: "c1", events: [e1, e2])
        #expect(cluster.topOffset(for: 0) == 0)
        #expect(cluster.topOffset(for: 1) == 22.5)

        // 60 minutes later: 60 * 0.75 = 45 -> clamped to 36pt
        let e3 = makeEvent(id: "e3", calendarId: "cal_1", startTime: base.addingTimeInterval(3600), durationMinutes: 60)
        let clusterClamped = TimedEventCluster(id: "c2", events: [e1, e3])
        #expect(clusterClamped.topOffset(for: 1) == 36.0)
    }
}
