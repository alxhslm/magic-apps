import SwiftUI

public struct ScheduleAgendaView: View {
    public let feedItems: [TrayModel.ScheduleFeedItem]
    public let selectedDate: Date
    public let requestedScrollDate: Date?
    public let onSelectEvent: (TrayEvent) -> Void
    public let onJoinCall: (String) -> Void
    public let onRsvp: (TrayEvent, String) -> Void
    public let onDeleteEvent: ((TrayEvent) -> Void)?
    public let onCompleteTask: ((TrayEvent, Bool) -> Void)?
    public let onDayScrolledIntoView: ((Date) -> Void)?
    public let onScrolledNearEnd: ((Date) -> Void)?

    /// Whether a banner above is already explaining why the agenda is empty.
    ///
    /// "No events scheduled" is a claim about the calendar, and it must not be made when
    /// the calendar cannot be read: offline with nothing cached, a clear day and a dead
    /// network look identical from here, and only one of them means the user is free.
    /// Magimail withholds "All caught up" on the same condition, and for the same reason.
    public let isExplainedElsewhere: Bool

    /// Tracks which item is topmost in the scroll view, driving the
    /// mini-calendar selection and month advancement as the user scrolls.
    @State private var topmostItemKey: String = ""
    @State private var hasInitialScrolled: Bool = false
    @State private var isSuppressingScrollTracking: Bool = false

    private static let keyFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = .current
        return df
    }()

    /// Named coordinate space for scroll-position measurement.
    private let scrollSpace = "scheduleScroll"

    /// Scroll target for the red rule marking where the day has got to. Only one is ever on
    /// screen: the rule renders either between two of today's events or after the last of them,
    /// and those two cases are mutually exclusive.
    private static let nowAnchorId = "nowRule"

    /// Duration of the programmatic scroll animation.
    private static let scrollAnimationDuration: TimeInterval = 0.25

    /// How long to suppress scroll-tracking after a programmatic jump or feed item update,
    /// covering the animation and the layout pass that follows it.
    private static let scrollSuppressionDelay: TimeInterval = 0.3

    public init(
        feedItems: [TrayModel.ScheduleFeedItem],
        selectedDate: Date,
        requestedScrollDate: Date? = nil,
        onSelectEvent: @escaping (TrayEvent) -> Void,
        onJoinCall: @escaping (String) -> Void,
        onRsvp: @escaping (TrayEvent, String) -> Void,
        onDeleteEvent: ((TrayEvent) -> Void)? = nil,
        onCompleteTask: ((TrayEvent, Bool) -> Void)? = nil,
        onDayScrolledIntoView: ((Date) -> Void)? = nil,
        onScrolledNearEnd: ((Date) -> Void)? = nil,
        isExplainedElsewhere: Bool = false
    ) {
        self.feedItems = feedItems
        self.selectedDate = selectedDate
        self.requestedScrollDate = requestedScrollDate
        self.onSelectEvent = onSelectEvent
        self.onJoinCall = onJoinCall
        self.onRsvp = onRsvp
        self.onDeleteEvent = onDeleteEvent
        self.onCompleteTask = onCompleteTask
        self.onDayScrolledIntoView = onDayScrolledIntoView
        self.onScrolledNearEnd = onScrolledNearEnd
        self.isExplainedElsewhere = isExplainedElsewhere
    }

    public var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: true) {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if feedItems.isEmpty {
                        if !isExplainedElsewhere {
                            VStack(spacing: 6) {
                                Image(systemName: "calendar")
                                    .font(.system(size: 24))
                                    .foregroundStyle(.tertiary)
                                Text("No events scheduled")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.tertiary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 32)
                        }
                    } else {
                        ForEach(feedItems) { item in
                            feedItemRow(item)
                                .id(item.id)
                                .onAppear {
                                    if hasInitialScrolled, item.id == feedItems.last?.id {
                                        onScrolledNearEnd?(item.date)
                                    }
                                }
                        }
                    }
                }
                .padding(.vertical, 8)
                .padding(.leading, 2)
                // Room for the overlay scroller, which AppKit draws on top of the scroll view's
                // trailing edge rather than beside it. Without the gutter it sits over the right
                // edge of every card.
                .padding(.trailing, 12)
            }
            .coordinateSpace(name: scrollSpace)
            .onPreferenceChange(TopmostItemPreferenceKey.self) { candidate in
                if !candidate.isEmpty, candidate != topmostItemKey {
                    topmostItemKey = candidate
                }
            }
            // Programmatic scrolling requested by user (e.g. clicking a date or the month title)
            .onChange(of: requestedScrollDate) { _, newDate in
                guard let newDate else { return }
                isSuppressingScrollTracking = true
                scroll(to: newDate, proxy: proxy, animated: true)
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.scrollSuppressionDelay) {
                    isSuppressingScrollTracking = false
                }
            }
            // Initial scroll to Today on appear
            .onAppear {
                performInitialScroll(proxy: proxy)
            }
            .onChange(of: feedItems) { _, _ in
                isSuppressingScrollTracking = true
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.scrollSuppressionDelay) {
                    isSuppressingScrollTracking = false
                }
            }
            .onChange(of: feedItems.count) { _, count in
                if !hasInitialScrolled, count > 0 {
                    performInitialScroll(proxy: proxy)
                }
            }
        }
        // When the topmost visible item changes as the user scrolls, update parent
        .onChange(of: topmostItemKey) { _, key in
            guard hasInitialScrolled, !isSuppressingScrollTracking else { return }
            if let item = feedItems.first(where: { $0.id == key }) {
                onDayScrolledIntoView?(item.date)
            }
        }
    }

    private func performInitialScroll(proxy: ScrollViewProxy) {
        guard !hasInitialScrolled, !feedItems.isEmpty else { return }
        isSuppressingScrollTracking = true
        // Unanimated: the popover is arriving, and a list that scrolls itself as it appears
        // reads as the view still settling rather than as a deliberate move.
        scroll(to: Date(), proxy: proxy, animated: false)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.scrollSuppressionDelay) {
            hasInitialScrolled = true
            isSuppressingScrollTracking = false
        }
    }

    /// Scrolls the agenda to a date, and on today to the moment rather than to the date.
    ///
    /// The top of a day is wherever that day began, so at four in the afternoon it is eight
    /// hours of finished meetings; "today" is not what anyone means by it. Landing on the now
    /// rule puts what has just finished above and what is next below.
    ///
    /// Two passes rather than one. `ScrollViewProxy` can only reach a view the `LazyVStack` has
    /// realised, and today's block may not be until the first pass has put it on screen; the
    /// second runs on the next turn of the run loop, by which time it is there.
    ///
    /// Neither pass animates. Two animated moves read as the agenda scrolling to the top of the
    /// day and then correcting itself downwards, which is what it is doing and precisely what
    /// the user should not have to watch. Unanimated, SwiftUI draws the run loop turn once, so
    /// the intermediate position is never on screen. A jump to any other date is one pass and
    /// keeps its animation.
    private func scroll(to date: Date, proxy: ScrollViewProxy, animated: Bool) {
        guard let targetId = targetItemId(for: date) else { return }
        let isToday = Calendar.current.isDateInToday(date)

        move(animated: animated && !isToday) { proxy.scrollTo(targetId, anchor: .top) }

        guard isToday else { return }
        DispatchQueue.main.async {
            proxy.scrollTo(Self.nowAnchorId, anchor: .center)
        }
    }

    private func move(animated: Bool, _ body: () -> Void) {
        if animated {
            withAnimation(.easeInOut(duration: Self.scrollAnimationDuration), body)
        } else {
            body()
        }
    }

    /// Finds the best feed item ID to scroll to for a given date.
    /// Handles exact day match, empty period gap, or nearest upcoming day.
    private func targetItemId(for targetDate: Date) -> String? {
        let calendar = Calendar.current
        let targetStart = calendar.startOfDay(for: targetDate)
        let targetKey = Self.keyFormatter.string(from: targetDate)

        // 1. Exact day match
        if feedItems.contains(where: { $0.id == targetKey }) {
            return targetKey
        }

        // 2. Empty period gap containing targetDate
        for item in feedItems {
            if case let .emptyPeriod(id, _, gapStart) = item {
                let parts = id.components(separatedBy: "_")
                if parts.count == 3, let end = Self.keyFormatter.date(from: parts[2]) {
                    let gapEndStart = calendar.startOfDay(for: end)
                    let gapStartOfDay = calendar.startOfDay(for: gapStart)
                    if targetStart >= gapStartOfDay, targetStart <= gapEndStart {
                        return id
                    }
                }
            }
        }

        // 3. Nearest item on or after targetDate
        if let upcoming = feedItems.first(where: { calendar.startOfDay(for: $0.date) >= targetStart }) {
            return upcoming.id
        }

        // 4. Fallback to nearest item before targetDate (or last item)
        return feedItems.last?.id
    }

    @ViewBuilder
    private func feedItemRow(_ item: TrayModel.ScheduleFeedItem) -> some View {
        switch item {
        case let .day(group):
            daySection(group)
                .background(anchorDetector(for: group.id))
        case let .emptyPeriod(_, text, _):
            emptyPeriodSection(text: text)
        case let .monthHeader(_, title, _):
            monthHeaderSection(title: title)
        }
    }

    // MARK: - Scroll-position anchor detector

    private func anchorDetector(for itemId: String) -> some View {
        GeometryReader { geo in
            let frame = geo.frame(in: .named(scrollSpace))
            let isTopmost = frame.minY >= -20 && frame.minY < 80
            Color.clear
                .preference(
                    key: TopmostItemPreferenceKey.self,
                    value: isTopmost ? itemId : ""
                )
        }
        .frame(height: 0)
    }

    // MARK: - Day section

    private func daySection(_ group: TrayModel.DayScheduleGroup) -> some View {
        HStack(alignment: .top, spacing: 10) {
            // Left column: day abbreviation (WED) over the date number (9), pinned while the
            // day's cards scroll past it.
            Color.clear
                .frame(width: Self.gutterWidth)
                .overlay(alignment: .top) {
                    GeometryReader { geo in
                        let block = geo.frame(in: .named(scrollSpace))
                        dayGutter(group)
                            .offset(y: stickyOffset(blockMinY: block.minY, blockHeight: block.height))
                    }
                }

            // Right column: Stack of Apple HIG Event Cards
            VStack(spacing: 6) {
                let now = Date()
                let isToday = Calendar.current.isDateInToday(group.date)
                // Before the first thing that has not started. A meeting under way began
                // before now, so it belongs above the rule; an all-day entry starts at
                // midnight and stays at the top where it is read.
                let nowIndex = group.events.firstIndex { $0.startTime > now } ?? group.events.count

                ForEach(Array(group.events.enumerated()), id: \.element.identity) { index, event in
                    if isToday, index == nowIndex {
                        nowRule(now)
                    }
                    EventCardView(
                        event: event,
                        onSelect: { onSelectEvent(event) },
                        onJoinCall: onJoinCall,
                        onRsvp: { status in onRsvp(event, status) },
                        onDelete: onDeleteEvent,
                        onComplete: onCompleteTask
                    )
                }

                // The day is done; the rule sits under the last of it.
                if isToday, nowIndex == group.events.count {
                    nowRule(now)
                }
            }
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: - Day gutter

    private static let gutterWidth: CGFloat = 32
    private static let gutterHeight: CGFloat = 38
    /// How far below the top of the scroll view the pinned gutter sits.
    private static let stickyInset: CGFloat = 2

    private func dayGutter(_ group: TrayModel.DayScheduleGroup) -> some View {
        VStack(alignment: .center, spacing: 1) {
            Text(group.dayLabel)
                .font(.system(size: 9.5, weight: .bold))
                .foregroundStyle(.secondary)
                .tracking(0.3)

            Text(group.dateNumber)
                .font(.system(size: 18, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(.primary)
        }
        .frame(width: Self.gutterWidth, height: Self.gutterHeight, alignment: .top)
        .padding(.top, 4)
    }

    /// Holds the date against the top of the scroll view while any of that day's cards are still
    /// on screen, then lets it leave with the last of them.
    ///
    /// A day with eight meetings is taller than the popover, so a gutter fixed to the top of its
    /// block scrolls away and leaves the reader looking at cards belonging to a date they can no
    /// longer see.
    private func stickyOffset(blockMinY: CGFloat, blockHeight: CGFloat) -> CGFloat {
        let pinned = max(0, -blockMinY + Self.stickyInset)
        return min(pinned, max(0, blockHeight - Self.gutterHeight))
    }

    // MARK: - Now rule

    private static let nowFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "HH:mm"
        df.timeZone = .current
        return df
    }()

    /// Where the day has got to, drawn between what has finished and what has not started.
    ///
    /// Computed as the view renders rather than on a timer. The popover is `.transient`,
    /// so it is on screen for seconds at a time; a minute timer would redraw the whole
    /// agenda to move a line nobody is still looking at.
    private func nowRule(_ now: Date) -> some View {
        HStack(spacing: 6) {
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
        .padding(.vertical, 1)
        .id(Self.nowAnchorId)
        .accessibilityLabel("Now, \(Self.nowFormatter.string(from: now))")
    }

    // MARK: - Empty period divider ("September 28 – October 4")

    private func emptyPeriodSection(text: String) -> some View {
        HStack(spacing: 8) {
            Rectangle()
                .fill(Color.primary.opacity(0.08))
                .frame(height: 1)
            Text(text)
                .font(.system(size: 10, weight: .medium, design: .rounded))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
            Rectangle()
                .fill(Color.primary.opacity(0.08))
                .frame(height: 1)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 4)
    }

    // MARK: - Month boundary header ("October 2026")

    private func monthHeaderSection(title: String) -> some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.system(size: 11.5, weight: .bold))
                .foregroundStyle(.secondary)
            Rectangle()
                .fill(Color.primary.opacity(0.12))
                .frame(height: 1)
        }
        .padding(.top, 8)
        .padding(.bottom, 2)
        .padding(.horizontal, 4)
    }
}

// MARK: - Preference key for topmost-item coordination

private struct TopmostItemPreferenceKey: PreferenceKey {
    static var defaultValue: String = ""
    static func reduce(value: inout String, nextValue: () -> String) {
        let next = nextValue()
        if value.isEmpty, !next.isEmpty {
            value = next
        }
    }
}
