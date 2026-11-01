import Foundation
import SwiftUI

/// Groups concurrent and sequential timed calendar events.
///
/// An event that overlaps with another during the day forms a cluster. When two events
/// overlap, they are displayed side by side using compact tiles; when starting at different
/// times, the later event is vertically offset downwards proportional to its start time difference.
public struct TimedEventCluster: Identifiable, Equatable {
    public let id: String
    public let events: [TrayEvent]

    public init(id: String, events: [TrayEvent]) {
        self.id = id
        self.events = events
    }

    public var isConcurrent: Bool {
        events.count > 1
    }

    public var startTime: Date {
        events.first?.startTime ?? Date()
    }

    public var endTime: Date {
        events.map(\.endTime).max() ?? (events.first?.endTime ?? Date())
    }

    /// Vertical top offset in points for the event at the given index within the cluster.
    ///
    /// The offset is proportional to the start-time difference relative to the cluster's
    /// first event (0.75pt per minute difference), capped at 36pt so the tile remains
    /// comfortably within the cluster's visual group.
    public func topOffset(for index: Int) -> CGFloat {
        guard index > 0, index < events.count else { return 0 }
        let t0 = events[0].startTime
        let ti = events[index].startTime
        let deltaMinutes = max(0, ti.timeIntervalSince(t0) / 60.0)
        return min(36.0, max(0.0, CGFloat(deltaMinutes) * 0.75))
    }

    /// Groups timed events into clusters of overlapping meetings.
    ///
    /// Works across different accounts and within the same calendar alike. Any timed event
    /// starting before the running cluster's maximum end time joins the cluster.
    public static func cluster(timedEvents: [TrayEvent]) -> [TimedEventCluster] {
        guard !timedEvents.isEmpty else { return [] }
        let sorted = timedEvents.sorted {
            if $0.startTime == $1.startTime {
                return $0.endTime > $1.endTime
            }
            return $0.startTime < $1.startTime
        }

        var result: [TimedEventCluster] = []
        var i = 0
        while i < sorted.count {
            var current = [sorted[i]]
            var j = i + 1
            var maxEnd = sorted[i].endTime
            while j < sorted.count, sorted[j].startTime < maxEnd {
                current.append(sorted[j])
                maxEnd = max(maxEnd, sorted[j].endTime)
                j += 1
            }
            result.append(TimedEventCluster(id: current[0].id, events: current))
            i = j
        }
        return result
    }
}

/// Renders a cluster of timed events: side by side with start-time offset for concurrent pairs,
/// or standard full-width event cards otherwise.
public struct ClusterEventRowView: View {
    public let cluster: TimedEventCluster
    public let onSelectEvent: (TrayEvent) -> Void
    public let onJoinCall: ((String) -> Void)?
    public let onRsvp: ((TrayEvent, String) -> Void)?
    public let onDeleteEvent: ((TrayEvent) -> Void)?
    public let onCompleteTask: ((TrayEvent, Bool) -> Void)?

    public init(
        cluster: TimedEventCluster,
        onSelectEvent: @escaping (TrayEvent) -> Void,
        onJoinCall: ((String) -> Void)? = nil,
        onRsvp: ((TrayEvent, String) -> Void)? = nil,
        onDeleteEvent: ((TrayEvent) -> Void)? = nil,
        onCompleteTask: ((TrayEvent, Bool) -> Void)? = nil
    ) {
        self.cluster = cluster
        self.onSelectEvent = onSelectEvent
        self.onJoinCall = onJoinCall
        self.onRsvp = onRsvp
        self.onDeleteEvent = onDeleteEvent
        self.onCompleteTask = onCompleteTask
    }

    public var body: some View {
        if cluster.events.count == 2 {
            HStack(alignment: .top, spacing: 6) {
                CompactEventTileView(
                    event: cluster.events[0],
                    onSelect: { onSelectEvent(cluster.events[0]) },
                    onJoinCall: onJoinCall,
                    onRsvp: { status in onRsvp?(cluster.events[0], status) },
                    onDelete: onDeleteEvent,
                    onComplete: onCompleteTask
                )
                .padding(.top, cluster.topOffset(for: 0))

                CompactEventTileView(
                    event: cluster.events[1],
                    onSelect: { onSelectEvent(cluster.events[1]) },
                    onJoinCall: onJoinCall,
                    onRsvp: { status in onRsvp?(cluster.events[1], status) },
                    onDelete: onDeleteEvent,
                    onComplete: onCompleteTask
                )
                .padding(.top, cluster.topOffset(for: 1))
            }
        } else {
            VStack(spacing: 6) {
                ForEach(cluster.events, id: \.identity) { event in
                    EventCardView(
                        event: event,
                        onSelect: { onSelectEvent(event) },
                        onJoinCall: onJoinCall,
                        onRsvp: { status in onRsvp?(event, status) },
                        onDelete: onDeleteEvent,
                        onComplete: onCompleteTask
                    )
                }
            }
        }
    }
}
