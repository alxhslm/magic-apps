import AppKit
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
    public let onJoinCall: ((String, String) -> Void)?
    public let onRsvp: ((TrayEvent, String) -> Void)?
    public let onDeleteEvent: ((TrayEvent) -> Void)?
    public let onCompleteTask: ((TrayEvent, Bool) -> Void)?

    @ObservedObject private var sidebarModel = SidebarModel.shared
    private var hourHeight: CGFloat {
        sidebarModel.gridHourHeight
    }

    private let gutterWidth: CGFloat = 36.0
    private let calendar: Calendar = .current

    public init(
        date: Date,
        events: [TrayEvent],
        onSelectEvent: @escaping (TrayEvent) -> Void,
        onJoinCall: ((String, String) -> Void)? = nil,
        onRsvp: ((TrayEvent, String) -> Void)? = nil,
        onDeleteEvent: ((TrayEvent) -> Void)? = nil,
        onCompleteTask: ((TrayEvent, Bool) -> Void)? = nil
    ) {
        self.date = date
        self.events = events
        self.onSelectEvent = onSelectEvent
        self.onJoinCall = onJoinCall
        self.onRsvp = onRsvp
        self.onDeleteEvent = onDeleteEvent
        self.onCompleteTask = onCompleteTask
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
                let rawStart = event.startTime.timeIntervalSince(dayStart)
                let rawEnd = event.endTime.timeIntervalSince(dayStart)
                let startSeconds = max(0, min(86400, rawStart))
                let endSeconds = max(startSeconds + 900, min(86400, rawEnd))
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

    private var effectiveScrollY: CGFloat {
        if sidebarModel.hasReceivedScroll {
            return sidebarModel.gridScrollY
        }
        return CGFloat(initialScrollHour) * hourHeight
    }

    public var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(spacing: 0) {
                ForEach(0 ..< 24, id: \.self) { hour in
                    hourRow(hour: hour)
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

                            EventCardView(
                                event: item.event,
                                onSelect: { onSelectEvent(item.event) },
                                onJoinCall: onJoinCall,
                                onRsvp: onRsvp != nil ? { onRsvp?(item.event, $0) } : nil,
                                onDelete: onDeleteEvent,
                                onComplete: onCompleteTask,
                                style: .grid,
                                date: date,
                                height: item.height
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
            .background(
                ScrollOffsetHook(
                    targetY: effectiveScrollY,
                    hourHeight: hourHeight,
                    onUserScroll: { hour, currentY in
                        sidebarModel.gridScrollY = currentY
                        sidebarModel.onAction?("sidebarScroll", String(format: "%.4f", hour))
                    }
                )
            )
        }
    }

    // MARK: - Hour Row

    private func hourRow(hour: Int) -> some View {
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(Color.primary.opacity(0.08))
                .frame(height: 0.75)
                .padding(.leading, gutterWidth)

            HStack(spacing: 0) {
                Text(formattedHour(hour))
                    .font(.system(size: 9.5, weight: .medium, design: .rounded).monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .frame(width: gutterWidth - 6, alignment: .trailing)
                    .padding(.trailing, 6)
                    .offset(y: -6)

                Spacer()
            }
        }
        .frame(height: hourHeight, alignment: .top)
    }

    private func formattedHour(_ hour: Int) -> String {
        var comp = DateComponents()
        comp.hour = hour
        let d = calendar.date(from: comp) ?? Date()
        return TimeDisplay.hour.string(from: d)
    }

    // MARK: - Now Indicator

    private static let nowFormatter = TimeDisplay.time

    private func nowIndicator(width: CGFloat) -> some View {
        let now = Date()
        let minutes = calendar.component(.hour, from: now) * 60 + calendar.component(.minute, from: now)
        let nowY = CGFloat(minutes) / 60.0 * hourHeight

        return HStack(spacing: 6) {
            Circle()
                .fill(Color.red)
                .frame(width: 6, height: 6)

            Rectangle()
                .fill(Color.red)
                .frame(height: 1)

            Text(Self.nowFormatter.string(from: now))
                .font(.system(size: 9.5, weight: .semibold, design: .rounded).monospacedDigit())
                .foregroundStyle(Color.red)
        }
        .frame(width: max(0, width - gutterWidth + 3))
        .offset(x: gutterWidth - 3, y: nowY - 3)
    }
}

// MARK: - Sub-pixel AppKit Scroll Offset Hook

final class ScrollHookNSView: NSView {
    var targetY: CGFloat = 0 {
        didSet {
            attemptScroll()
        }
    }

    var hourHeight: CGFloat = 48.0
    var onUserScroll: ((_ hour: CGFloat, _ currentY: CGFloat) -> Void)?

    private var retryCount = 0
    private var isProgrammatic = false
    private var lastUserScrollTime: TimeInterval = 0
    private var pendingScrollWorkItem: DispatchWorkItem?

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        setupNotificationObserver()
        attemptScroll()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        setupNotificationObserver()
        attemptScroll()
    }

    private func setupNotificationObserver() {
        NotificationCenter.default.removeObserver(self, name: NSView.boundsDidChangeNotification, object: nil)
        guard let clipView = enclosingScrollView?.contentView else { return }
        clipView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleClipViewBoundsDidChange(_:)),
            name: NSView.boundsDidChangeNotification,
            object: clipView
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        pendingScrollWorkItem?.cancel()
    }

    @objc private func handleClipViewBoundsDidChange(_ notification: Notification) {
        guard !isProgrammatic, let clipView = notification.object as? NSClipView, hourHeight > 10 else { return }

        let currentY = clipView.bounds.origin.y
        let hour = max(0.0, min(24.0, currentY / hourHeight))

        let now = ProcessInfo.processInfo.systemUptime
        if now - lastUserScrollTime >= 0.016 {
            lastUserScrollTime = now
            pendingScrollWorkItem?.cancel()
            pendingScrollWorkItem = nil
            onUserScroll?(hour, currentY)
        } else {
            pendingScrollWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                guard let self, !self.isProgrammatic else { return }
                lastUserScrollTime = ProcessInfo.processInfo.systemUptime
                onUserScroll?(hour, currentY)
            }
            pendingScrollWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.016, execute: workItem)
        }
    }

    func attemptScroll() {
        guard let scrollView = enclosingScrollView else { return }
        let clipView = scrollView.contentView
        let docHeight = scrollView.documentView?.frame.height ?? 0

        guard docHeight >= 500 else {
            if retryCount < 25 {
                retryCount += 1
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.04) { [weak self] in
                    self?.attemptScroll()
                }
            }
            return
        }

        retryCount = 0
        let maxY = max(0, docHeight - clipView.bounds.height)
        let clampedY = max(0, min(targetY, maxY))
        if abs(clipView.bounds.origin.y - clampedY) > 0.5 {
            isProgrammatic = true
            clipView.scroll(to: NSPoint(x: 0, y: clampedY))
            scrollView.reflectScrolledClipView(clipView)
            DispatchQueue.main.async { [weak self] in
                self?.isProgrammatic = false
            }
        }
    }
}

struct ScrollOffsetHook: NSViewRepresentable {
    let targetY: CGFloat
    let hourHeight: CGFloat
    let onUserScroll: ((_ hour: CGFloat, _ currentY: CGFloat) -> Void)?

    func makeNSView(context _: Context) -> ScrollHookNSView {
        let view = ScrollHookNSView()
        view.translatesAutoresizingMaskIntoConstraints = false
        view.targetY = targetY
        view.hourHeight = hourHeight
        view.onUserScroll = onUserScroll
        return view
    }

    func updateNSView(_ nsView: ScrollHookNSView, context _: Context) {
        nsView.hourHeight = hourHeight
        nsView.onUserScroll = onUserScroll
        nsView.targetY = targetY
    }
}
