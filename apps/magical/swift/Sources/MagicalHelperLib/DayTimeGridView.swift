import Foundation
import HelperUI
import SwiftUI

/// Day time grid for Day and Week companion views.
///
/// Lays out timed events on a vertical 24-hour time grid where Y position corresponds to
/// start time, height corresponds to duration, and concurrent overlapping events split
/// width side by side while maintaining their proportional top and bottom offsets.
public struct DayTimeGridView: View {
    public let date: Date
    public let events: [TrayEvent]
    public let onSelectEvent: (TrayEvent) -> Void
    public let onJoinCall: ((String) -> Void)?

    private let hourHeight: CGFloat = 54.0
    private let gutterWidth: CGFloat = 36.0
    private let calendar: Calendar = .current

    public init(
        date: Date,
        events: [TrayEvent],
        onSelectEvent: @escaping (TrayEvent) -> Void,
        onJoinCall: ((String) -> Void)? = nil
    ) {
        self.date = date
        self.events = events
        self.onSelectEvent = onSelectEvent
        self.onJoinCall = onJoinCall
    }

    private var dayStart: Date {
        calendar.startOfDay(for: date)
    }

    private var isToday: Bool {
        calendar.isDateInToday(date)
    }

    public struct GridEventLayout: Identifiable {
        public let id: String
        public let event: TrayEvent
        public let top: CGFloat
        public let height: CGFloat
        public let columnIndex: Int
        public let totalColumns: Int
    }

    private var gridEvents: [GridEventLayout] {
        let timed = events.filter { !$0.isAllDay }.sorted {
            if $0.startTime == $1.startTime {
                return $0.endTime > $1.endTime
            }
            return $0.startTime < $1.startTime
        }
        guard !timed.isEmpty else { return [] }

        let clusters = TimedEventCluster.cluster(timedEvents: timed)
        var layouts: [GridEventLayout] = []

        for cluster in clusters {
            let colCount = min(2, cluster.events.count)
            for (idx, event) in cluster.events.enumerated() {
                let startSeconds = max(0, event.startTime.timeIntervalSince(dayStart))
                let endSeconds = max(startSeconds + 900, event.endTime.timeIntervalSince(dayStart))
                let top = CGFloat(startSeconds / 3600.0) * hourHeight
                let rawHeight = CGFloat((endSeconds - startSeconds) / 3600.0) * hourHeight
                let height = max(26.0, rawHeight)

                let colIndex = colCount == 1 ? 0 : (idx % 2)
                layouts.append(GridEventLayout(
                    id: event.id,
                    event: event,
                    top: top,
                    height: height,
                    columnIndex: colIndex,
                    totalColumns: colCount
                ))
            }
        }
        return layouts
    }

    private var initialScrollHour: Int {
        if isToday {
            let currentHour = calendar.component(.hour, from: Date())
            let firstEventHour = events.first.map { calendar.component(.hour, from: $0.startTime) } ?? currentHour
            return max(0, min(currentHour, firstEventHour) - 1)
        } else if let first = events.first {
            let firstHour = calendar.component(.hour, from: first.startTime)
            return max(0, firstHour - 1)
        } else {
            return 8
        }
    }

    public var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: true) {
                VStack(spacing: 0) {
                    ForEach(0 ..< 24, id: \.self) { hour in
                        hourRow(hour: hour)
                            .id(hour)
                    }
                }
                .overlay(alignment: .topLeading) {
                    GeometryReader { geo in
                        let availableWidth = max(100.0, geo.size.width - gutterWidth - 8)
                        ZStack(alignment: .topLeading) {
                            // Events positioned on the time grid
                            ForEach(gridEvents) { item in
                                let colWidth = item.totalColumns == 1 ? availableWidth : (availableWidth - 4) / 2
                                let xOffset = gutterWidth + (item.columnIndex == 0 ? 0 : (colWidth + 4))

                                TimeGridEventTile(
                                    event: item.event,
                                    height: item.height,
                                    isCompact: item.totalColumns > 1,
                                    onSelect: { onSelectEvent(item.event) },
                                    onJoinCall: onJoinCall
                                )
                                .frame(width: colWidth, height: item.height)
                                .offset(x: xOffset, y: item.top)
                            }

                            // Live Now line
                            if isToday {
                                nowIndicator(width: geo.size.width)
                            }
                        }
                    }
                }
                .padding(.vertical, 6)
            }
            .onAppear {
                DispatchQueue.main.async {
                    proxy.scrollTo(initialScrollHour, anchor: .top)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    proxy.scrollTo(initialScrollHour, anchor: .top)
                }
            }
        }
    }

    // MARK: - Hour Row

    private func hourRow(hour: Int) -> some View {
        HStack(spacing: 0) {
            Text(formattedHour(hour))
                .font(.system(size: 9.5, weight: .medium, design: .rounded).monospacedDigit())
                .foregroundStyle(.tertiary)
                .frame(width: gutterWidth - 6, alignment: .trailing)
                .padding(.trailing, 6)

            Rectangle()
                .fill(Color.primary.opacity(0.08))
                .frame(height: 0.75)
        }
        .frame(height: hourHeight, alignment: .top)
    }

    private func formattedHour(_ hour: Int) -> String {
        var comp = DateComponents()
        comp.hour = hour
        let d = calendar.date(from: comp) ?? Date()
        let df = DateFormatter()
        df.dateFormat = "ha"
        return df.string(from: d)
    }

    // MARK: - Now Indicator

    private func nowIndicator(width: CGFloat) -> some View {
        let now = Date()
        let minutes = calendar.component(.hour, from: now) * 60 + calendar.component(.minute, from: now)
        let nowY = CGFloat(minutes) / 60.0 * hourHeight

        return HStack(spacing: 0) {
            Circle()
                .fill(Color.red)
                .frame(width: 6, height: 6)

            Rectangle()
                .fill(Color.red)
                .frame(height: 1.5)
        }
        .frame(width: max(0, width - gutterWidth + 3))
        .offset(x: gutterWidth - 3, y: nowY - 3)
    }
}

// MARK: - Time Grid Event Tile

private struct TimeGridEventTile: View {
    let event: TrayEvent
    let height: CGFloat
    let isCompact: Bool
    let onSelect: () -> Void
    let onJoinCall: ((String) -> Void)?

    @State private var isHovering = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 4) {
                Capsule()
                    .fill(Color(hex: event.colorHex))
                    .frame(width: 3)
                    .padding(.vertical, 3)

                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 3) {
                        Text(event.formattedTime)
                            .font(.system(size: 8.5, design: .rounded).monospacedDigit())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)

                        Spacer(minLength: 1)

                        if event.conferenceUrl != nil {
                            Image(systemName: "video.fill")
                                .font(.system(size: 8))
                                .foregroundStyle(.secondary)
                        }
                    }

                    Text(event.summary)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(event.isCompleted ? .secondary : .primary)
                        .lineLimit(height > 40 ? 2 : 1)
                        .fixedSize(horizontal: false, vertical: true)

                    if height >= 46, let calName = event.calendarName, !calName.isEmpty {
                        Text(calName)
                            .font(.system(size: 8.5))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                .padding(.trailing, 3)
            }
            .padding(.leading, 4)
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(
                ZStack {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color(nsColor: .controlBackgroundColor).opacity(0.88))
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color.primary.opacity(isHovering ? 0.08 : 0.04))
                }
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(Color.primary.opacity(isHovering ? 0.2 : 0.1), lineWidth: 0.75)
            )
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
    }
}
