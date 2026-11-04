import AppKit
import Foundation
import HelperUI
import SwiftUI

// MARK: - View Mode

public enum SidebarViewMode: String, Sendable {
    case fantastical // Month, Schedule, Year
    case week // 7-Day Week
    case fourDay // 4-Day View
    case day // Day
}

// MARK: - Week Day Item

public struct WeekDayItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let date: Date
    public let dayLetter: String
    public let dayNumber: String
    public let isToday: Bool
    public let isSelected: Bool
    public let dots: [Color]

    public init(
        id: String,
        date: Date,
        dayLetter: String,
        dayNumber: String,
        isToday: Bool,
        isSelected: Bool,
        dots: [Color]
    ) {
        self.id = id
        self.date = date
        self.dayLetter = dayLetter
        self.dayNumber = dayNumber
        self.isToday = isToday
        self.isSelected = isSelected
        self.dots = dots
    }
}

// MARK: - Sidebar Model

@MainActor
public final class SidebarModel: ObservableObject {
    public static let shared = SidebarModel()

    @Published public var transparentBackground: Bool = true
    @Published public var isDarkMode: Bool = true
    @Published public var viewMode: SidebarViewMode = .day
    /// Google Calendar's own timeframe name, which distinguishes the two views that share
    /// `.fantastical`: Month owns a fixed range, Schedule has an open agenda.
    @Published public var gcalTimeframe: String = "day"
    @Published public var selectedDate: Date = .init()
    @Published public var displayedMonthDate: Date = .init()
    /// The date Google Calendar is showing. It is the only source of the sidebar's range:
    /// local selection never moves it, so the two panes cannot disagree about the month.
    @Published public var anchorDate: Date = .init()
    @Published public var isCalendarCollapsed: Bool = false
    @Published public var isVisible: Bool = true
    @Published public var currentWeekDays: [WeekDayItem] = []
    @Published public var gridHourHeight: CGFloat = 48.0
    @Published public var gridScrollY: CGFloat = 0.0
    @Published public var gcalGridTop: CGFloat = 148.0
    @Published public var gcalGridHeight: CGFloat = 600.0
    @Published public var gcalCardTop: CGFloat = 64.0
    @Published public var hasReceivedScroll: Bool = false
    public let topMargin: CGFloat = 8.0

    public let trayModel: TrayModel

    public var onAction: ((_ action: String, _ value: String) -> Void)?

    private let calendar: Calendar = {
        var cal = Calendar.current
        cal.firstWeekday = 2 // Monday start
        return cal
    }()

    @MainActor
    public convenience init() {
        self.init(trayModel: .shared)
    }

    @MainActor
    public init(trayModel: TrayModel) {
        self.trayModel = trayModel
        recomputeWeekDays()
        trayModel.onCalendarFilterChanged = { [weak self] hidden in
            if let data = try? JSONSerialization.data(withJSONObject: hidden),
               let str = String(data: data, encoding: .utf8)
            {
                self?.onAction?("sidebarFilterChanged", str)
            }
        }
        // The completed-task toggle sits in the same filter menu as the calendar ticks.
        // Without this the sidebar changed only its own copy and the menu bar never heard
        // about it; the sidebar payload also carries the setting back the other way.
        trayModel.onShowCompletedTasksChanged = { [weak self] show in
            self?.onAction?("sidebarSetShowCompletedTasks", show ? "true" : "false")
        }
    }

    public func selectDate(_ date: Date) {
        selectedDate = date
        // Selecting a day from the leading or trailing week of the month grid shows that
        // day in the agenda, but must not move the grid: Google Calendar still shows the
        // month it was on, and the sidebar follows Google Calendar.
        recomputeWeekDays()
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        onAction?("sidebarSelectDate", formatter.string(from: date))
    }

    public func selectNextDay() {
        guard let next = calendar.date(byAdding: .day, value: 1, to: selectedDate) else { return }
        if viewMode == .week || viewMode == .fourDay, let lastDay = currentWeekDays.last?.date {
            let nextStart = calendar.startOfDay(for: next)
            let lastStart = calendar.startOfDay(for: lastDay)
            guard nextStart <= lastStart else { return }
        }
        selectDate(next)
    }

    public func selectPreviousDay() {
        guard let prev = calendar.date(byAdding: .day, value: -1, to: selectedDate) else { return }
        if viewMode == .week || viewMode == .fourDay, let firstDay = currentWeekDays.first?.date {
            let prevStart = calendar.startOfDay(for: prev)
            let firstStart = calendar.startOfDay(for: firstDay)
            guard prevStart >= firstStart else { return }
        }
        selectDate(prev)
    }

    /// Puts the sidebar back on the range Google Calendar is showing. Headers call this
    /// instead of jumping to today, because a header names the range it sits above.
    public func syncToGCalRange() {
        selectedDate = anchorDate
        displayedMonthDate = anchorDate
        recomputeWeekDays()
    }

    /// Schedule is the one timeframe with no bounded range of its own, so its month
    /// selector may step. Month and Year own the range Google Calendar is showing; their
    /// selector must not travel away from it.
    public var isScheduleTimeframe: Bool {
        gcalTimeframe == "schedule" || gcalTimeframe == "agenda"
    }

    public var isMonthTimeframe: Bool {
        gcalTimeframe == "month"
    }

    /// The days the mini month draws, including the leading and trailing days that fill
    /// its first and last weeks.
    ///
    /// Month view is bounded by Google Calendar, so the agenda below the grid shows only
    /// these days. The trailing week can reach into the next month, which is why clicking
    /// 1 December in a November grid still shows that day's events.
    public var displayedMonthGridRange: ClosedRange<Date>? {
        guard let month = calendar.dateInterval(of: .month, for: displayedMonthDate) else {
            return nil
        }
        let first = calendar.startOfDay(for: month.start)
        let dayCount = calendar.range(of: .day, in: .month, for: displayedMonthDate)?.count ?? 30
        let weekday = calendar.component(.weekday, from: first)
        let lead = (weekday + 5) % 7 // Monday = 0, Sunday = 6
        let cells = lead + dayCount
        let trailing = (7 - (cells % 7)) % 7

        let start = calendar.date(byAdding: .day, value: -lead, to: first) ?? first
        let lastMonthDay = calendar.date(byAdding: .day, value: dayCount - 1, to: first) ?? first
        let end = calendar.date(byAdding: .day, value: trailing, to: lastMonthDay) ?? lastMonthDay
        return calendar.startOfDay(for: start) ... calendar.startOfDay(for: end)
    }

    /// The agenda Month view shows: the days drawn in the grid, not the whole feed.
    /// Schedule keeps the continuous feed, because its agenda is the range.
    public var visibleScheduleFeedItems: [TrayModel.ScheduleFeedItem] {
        let items = trayModel.scheduleFeedItems
        guard isMonthTimeframe, let range = displayedMonthGridRange else { return items }
        return items.filter { range.contains(calendar.startOfDay(for: $0.date)) }
    }

    private func startOfMonth(_ date: Date) -> Date {
        calendar.dateInterval(of: .month, for: date)?.start ?? calendar.startOfDay(for: date)
    }

    /// The months the agenda actually covers, so stepping stops where Google Calendar's
    /// schedule stops showing days. The anchor and selection are included so the selector
    /// can always return to the range on screen.
    private var scheduleMonthBounds: (first: Date, last: Date)? {
        guard isScheduleTimeframe else { return nil }
        let dates = trayModel.scheduleFeedItems.map(\.date) + [anchorDate, selectedDate]
        guard let first = dates.min(), let last = dates.max() else { return nil }
        return (startOfMonth(first), startOfMonth(last))
    }

    public var canStepToPreviousMonth: Bool {
        guard let bounds = scheduleMonthBounds else { return false }
        return startOfMonth(displayedMonthDate) > bounds.first
    }

    public var canStepToNextMonth: Bool {
        guard let bounds = scheduleMonthBounds else { return false }
        return startOfMonth(displayedMonthDate) < bounds.last
    }

    public func previousMonth() {
        if isScheduleTimeframe, !canStepToPreviousMonth {
            return
        }
        if let prev = calendar.date(byAdding: .month, value: -1, to: displayedMonthDate) {
            displayedMonthDate = prev
        }
    }

    public func nextMonth() {
        if isScheduleTimeframe, !canStepToNextMonth {
            return
        }
        if let next = calendar.date(byAdding: .month, value: 1, to: displayedMonthDate) {
            displayedMonthDate = next
        }
    }

    public func toggleCalendarCollapse() {
        isCalendarCollapsed.toggle()
    }

    public func setViewMode(
        _ mode: SidebarViewMode,
        anchor: Date? = nil,
        timeframe: String? = nil
    ) {
        viewMode = mode
        gcalTimeframe = (timeframe ?? mode.rawValue).lowercased()
        // A report with no anchor keeps the last one. Calendar sometimes changes view
        // without changing date, and resetting to today there would break the match.
        if let anchor {
            anchorDate = anchor
        }
        selectedDate = anchorDate
        displayedMonthDate = anchorDate
        recomputeWeekDays()
    }

    public func recomputeWeekDays() {
        var items: [WeekDayItem] = []

        let dotsMap = trayModel.densityDotsByDay
        let keyFormatter = DateFormatter()
        keyFormatter.dateFormat = "yyyy-MM-dd"
        keyFormatter.timeZone = .current

        let letterFormatter = DateFormatter()
        letterFormatter.dateFormat = "EEEEE"
        letterFormatter.timeZone = .current

        let numberFormatter = DateFormatter()
        numberFormatter.dateFormat = "d"
        numberFormatter.timeZone = .current

        if viewMode == .fourDay {
            let start = calendar.startOfDay(for: anchorDate)
            for dayOffset in 0 ..< 4 {
                guard let dayDate = calendar.date(byAdding: .day, value: dayOffset, to: start) else { continue }
                let key = keyFormatter.string(from: dayDate)
                let isToday = calendar.isDateInToday(dayDate)
                let isSelected = calendar.isDate(dayDate, inSameDayAs: selectedDate)
                let dots = dotsMap[key] ?? []

                items.append(WeekDayItem(
                    id: key,
                    date: dayDate,
                    dayLetter: letterFormatter.string(from: dayDate),
                    dayNumber: numberFormatter.string(from: dayDate),
                    isToday: isToday,
                    isSelected: isSelected,
                    dots: dots
                ))
            }
        } else {
            let reference = selectedDate
            guard let weekInterval = calendar.dateInterval(of: .weekOfYear, for: reference) else { return }
            let startOfWeek = weekInterval.start

            for dayOffset in 0 ..< 7 {
                guard let dayDate = calendar.date(byAdding: .day, value: dayOffset, to: startOfWeek) else { continue }
                let key = keyFormatter.string(from: dayDate)
                let isToday = calendar.isDateInToday(dayDate)
                let isSelected = calendar.isDate(dayDate, inSameDayAs: selectedDate)
                let dots = dotsMap[key] ?? []

                items.append(WeekDayItem(
                    id: key,
                    date: dayDate,
                    dayLetter: letterFormatter.string(from: dayDate),
                    dayNumber: numberFormatter.string(from: dayDate),
                    isToday: isToday,
                    isSelected: isSelected,
                    dots: dots
                ))
            }
        }

        currentWeekDays = items
    }

    /// Events belonging specifically to `selectedDate` for Day & Week companion views.
    public var selectedDayEvents: [TrayEvent] {
        let calendar = Calendar.current
        return trayModel.filteredEvents.filter { $0.occurs(on: selectedDate, calendar: calendar) }
    }

    public func setScrollPosition(
        hour: CGFloat,
        hourHeight: CGFloat,
        gridTop: CGFloat = 148.0,
        gridHeight: CGFloat = 600.0,
        cardTop: CGFloat = 64.0
    ) {
        hasReceivedScroll = true
        if abs(gridHourHeight - hourHeight) > 0.5, hourHeight > 20.0 {
            gridHourHeight = hourHeight
        }
        if abs(gcalGridTop - gridTop) > 0.5, gridTop > 50.0 {
            gcalGridTop = gridTop
        }
        if abs(gcalGridHeight - gridHeight) > 0.5, gridHeight > 100.0 {
            gcalGridHeight = gridHeight
        }
        if abs(gcalCardTop - cardTop) > 0.5, cardTop >= 30.0 {
            gcalCardTop = cardTop
        }
        let targetY = hour * gridHourHeight
        if abs(gridScrollY - targetY) > 0.5 {
            gridScrollY = targetY
        }
    }
}

// MARK: - Sidebar Day Pill View

public struct SidebarDayPillView: View {
    @ObservedObject var model: SidebarModel
    let item: WeekDayItem

    public init(model: SidebarModel, item: WeekDayItem) {
        self.model = model
        self.item = item
    }

    public var body: some View {
        Button(action: { model.selectDate(item.date) }) {
            VStack(spacing: 2) {
                Text(item.dayLetter)
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(item.isSelected ? .primary : .tertiary)

                ZStack {
                    if item.isToday {
                        Circle()
                            .fill(Color.blue)
                            .frame(width: 19, height: 19)
                    } else if item.isSelected {
                        Circle()
                            .fill(Color.blue.opacity(0.15))
                            .frame(width: 19, height: 19)
                    }

                    if item.isSelected {
                        Circle()
                            .strokeBorder(Color.blue, lineWidth: 1.2)
                            .frame(width: 21, height: 21)
                    }

                    Text(item.dayNumber)
                        .font(.system(size: 10.5, weight: item.isToday || item.isSelected ? .bold : .regular))
                        .foregroundStyle(item.isToday ? .white : (item.isSelected ? Color.blue : .primary))
                }
                .frame(width: 21, height: 21)

                // Density dots: crisp 3.5pt diameter dots with 2.5pt spacing
                HStack(spacing: 2.5) {
                    if item.dots.isEmpty {
                        Circle()
                            .fill(Color.clear)
                            .frame(width: 3.5, height: 3.5)
                    } else {
                        ForEach(0 ..< min(4, item.dots.count), id: \.self) { idx in
                            Circle()
                                .fill(item.dots[idx])
                                .frame(width: 3.5, height: 3.5)
                        }
                    }
                }
                .frame(height: 4.5)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Week Scrubber View

public struct WeekScrubberView: View {
    @ObservedObject var model: SidebarModel

    public init(model: SidebarModel) {
        self.model = model
    }

    private var bannerRowHeight: CGFloat {
        max(36.0, model.gcalCardTop - model.topMargin)
    }

    private let dayScrubberHeight: CGFloat = 56.0

    private var weekRangeText: String {
        guard let first = model.currentWeekDays.first?.date,
              let last = model.currentWeekDays.last?.date else { return "" }
        let cal = Calendar.current
        let startYear = cal.component(.year, from: first)
        let endYear = cal.component(.year, from: last)
        let startMonth = cal.component(.month, from: first)
        let endMonth = cal.component(.month, from: last)

        let monthFormatter = DateFormatter()
        monthFormatter.dateFormat = "MMM"

        let dayFormatter = DateFormatter()
        dayFormatter.dateFormat = "d"

        if startYear == endYear, startMonth == endMonth {
            return "\(monthFormatter.string(from: first)) \(dayFormatter.string(from: first)) – \(dayFormatter.string(from: last)), \(startYear)"
        } else if startYear == endYear {
            return "\(monthFormatter.string(from: first)) \(dayFormatter.string(from: first)) – \(monthFormatter.string(from: last)) \(dayFormatter.string(from: last)), \(startYear)"
        } else {
            return "\(monthFormatter.string(from: first)) \(dayFormatter.string(from: first)), \(startYear) – \(monthFormatter.string(from: last)) \(dayFormatter.string(from: last)), \(endYear)"
        }
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Header with week label and calendar filter/settings aligning with Google Calendar banner
            HStack(alignment: .center) {
                // Week is bounded by Google Calendar, so this is a label, not a control:
                // there is no range for a click to move the sidebar to.
                Text(weekRangeText)
                    .font(.system(size: 12.5, weight: .bold))
                    .foregroundStyle(.primary)

                Spacer()

                HStack(spacing: 4) {
                    CalendarFilterMenuView(model: model.trayModel)
                    SidebarSettingsMenuView(model: model.trayModel, onRefresh: { model.onAction?("sidebarRefresh", "") })
                }
            }
            .padding(.horizontal, 12)
            .frame(height: bannerRowHeight)

            // Day scrubber pills row aligning with Google Calendar day column headers
            HStack(spacing: 2) {
                ForEach(model.currentWeekDays) { item in
                    SidebarDayPillView(model: model, item: item)
                }
            }
            .padding(.horizontal, 6)
            .frame(height: dayScrubberHeight)
        }
        .frame(height: bannerRowHeight + dayScrubberHeight)
        .background(
            GeometryReader { geo in
                Color.clear.preference(key: HeaderHeightPreferenceKey.self, value: geo.size.height + 1.0)
            }
        )
    }
}

// MARK: - Day Companion Header View

public struct DayCompanionHeaderView: View {
    @ObservedObject var model: SidebarModel

    public init(model: SidebarModel) {
        self.model = model
    }

    private var bannerRowHeight: CGFloat {
        max(36.0, model.gcalCardTop - model.topMargin)
    }

    private let dayScrubberHeight: CGFloat = 56.0

    private var monthYearTitle: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM yyyy"
        formatter.timeZone = .current
        return formatter.string(from: model.selectedDate)
    }

    private var isToday: Bool {
        Calendar.current.isDateInToday(model.selectedDate)
    }

    private var dayNumber: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "d"
        formatter.timeZone = .current
        return formatter.string(from: model.selectedDate)
    }

    private var weekdayName: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEEE"
        formatter.timeZone = .current
        return formatter.string(from: model.selectedDate).uppercased()
    }

    private var fullDateText: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "d MMMM yyyy"
        formatter.timeZone = .current
        return formatter.string(from: model.selectedDate)
    }

    private var selectedDayDots: [Color] {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        let key = formatter.string(from: model.selectedDate)
        return model.trayModel.densityDotsByDay[key] ?? []
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Header with month/year title and calendar filter/settings aligning with Google Calendar banner
            HStack(alignment: .center) {
                // Day view is bounded by Google Calendar; the title names the day rather
                // than offering a jump that could only be a no-op.
                Text(monthYearTitle)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.primary)

                Spacer()

                HStack(spacing: 4) {
                    CalendarFilterMenuView(model: model.trayModel)
                    SidebarSettingsMenuView(model: model.trayModel, onRefresh: { model.onAction?("sidebarRefresh", "") })
                }
            }
            .padding(.horizontal, 12)
            .frame(height: bannerRowHeight)

            // Focused single day header aligning with Google Calendar day column header
            HStack(alignment: .center, spacing: 10) {
                HStack(spacing: 10) {
                    ZStack {
                        if isToday {
                            Circle()
                                .fill(Color.blue)
                                .frame(width: 32, height: 32)
                            Text(dayNumber)
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(.white)
                        } else {
                            Circle()
                                .fill(Color.blue.opacity(0.15))
                                .frame(width: 32, height: 32)
                            Circle()
                                .strokeBorder(Color.blue.opacity(0.6), lineWidth: 1.2)
                                .frame(width: 32, height: 32)
                            Text(dayNumber)
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(Color.blue)
                        }
                    }
                    .frame(width: 32, height: 32)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(weekdayName)
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(isToday ? Color.blue : .secondary)
                        Text(fullDateText)
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(.tertiary)
                    }
                }

                Spacer()

                if !selectedDayDots.isEmpty {
                    HStack(spacing: 4.5) {
                        ForEach(0 ..< min(4, selectedDayDots.count), id: \.self) { idx in
                            Circle()
                                .fill(selectedDayDots[idx])
                                .frame(width: 6.5, height: 6.5)
                        }
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(
                        Capsule()
                            .fill(Color.primary.opacity(0.08))
                    )
                }
            }
            .padding(.horizontal, 12)
            .frame(height: dayScrubberHeight)
        }
        .frame(height: bannerRowHeight + dayScrubberHeight)
        .background(
            GeometryReader { geo in
                Color.clear.preference(key: HeaderHeightPreferenceKey.self, value: geo.size.height + 1.0)
            }
        )
    }
}

// MARK: - Day Focused Events List

private struct HeaderHeightPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

public struct DayFocusedEventsList: View {
    @ObservedObject var sidebarModel: SidebarModel
    let events: [TrayEvent]
    let date: Date
    let headerHeight: CGFloat
    var onAction: ((_ action: String, _ value: String) -> Void)?

    @MainActor
    public init(
        model: SidebarModel? = nil,
        events: [TrayEvent],
        date: Date,
        headerHeight: CGFloat = 113.0,
        onAction: ((_ action: String, _ value: String) -> Void)? = nil
    ) {
        sidebarModel = model ?? .shared
        self.events = events
        self.date = date
        self.headerHeight = headerHeight
        self.onAction = onAction
    }

    private var allDayEvents: [TrayEvent] {
        events.filter(\.isAllDay)
    }

    private var timedEvents: [TrayEvent] {
        events.filter { !$0.isAllDay }.sorted(by: { $0.startTime < $1.startTime })
    }

    private var intrinsicAllDayHeight: CGFloat {
        guard !allDayEvents.isEmpty else { return 0 }
        let n = CGFloat(allDayEvents.count)
        let contentH = 4.0 + (n * 20.0) + CGFloat(max(0, allDayEvents.count - 1)) * 3.0
        return contentH + 1.0 // +1 for the divider below
    }

    private var allDayListContent: some View {
        VStack(spacing: 3) {
            ForEach(allDayEvents, id: \.identity) { event in
                AllDayBannerView(
                    event: event,
                    onSelect: { onAction?("sidebarOpenEvent", event.id) },
                    onDelete: { onAction?("sidebarDeleteEvent", "\($0.accountId):\($0.id)") },
                    onComplete: { onAction?("sidebarCompleteTask", "\($0.accountId):\($0.id):\($1)") }
                )
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Precise geometric alignment: headerHeight + allDay + spacer == targetGridTopInCard
            let targetGridTopInCard = max(0, sidebarModel.gcalGridTop - sidebarModel.topMargin)
            let totalAvailableSpace = max(0, targetGridTopInCard - headerHeight)

            if !allDayEvents.isEmpty {
                let actualAllDayH = min(intrinsicAllDayHeight, totalAvailableSpace)
                let bannerAreaH = max(0, actualAllDayH - 1.0)
                let alignmentSpacer = max(0, totalAvailableSpace - actualAllDayH)

                if intrinsicAllDayHeight > totalAvailableSpace {
                    ScrollView(.vertical, showsIndicators: true) {
                        allDayListContent
                    }
                    .frame(height: bannerAreaH)
                } else {
                    allDayListContent
                        .frame(height: bannerAreaH)
                }

                if alignmentSpacer > 0 {
                    Spacer()
                        .frame(height: alignmentSpacer)
                }

                Divider()
            } else {
                if totalAvailableSpace > 0 {
                    Spacer()
                        .frame(height: totalAvailableSpace)
                }
            }

            // 2. Day Time Grid matching Google Calendar's viewport height exactly
            DayTimeGridView(
                date: date,
                events: timedEvents,
                onSelectEvent: { onAction?("sidebarOpenEvent", $0.id) },
                onJoinCall: { onAction?("sidebarJoinCall", $0) },
                onRsvp: { onAction?("sidebarRsvp", "\($0.accountId):\($0.id):\($1)") },
                onDeleteEvent: { onAction?("sidebarDeleteEvent", "\($0.accountId):\($0.id)") },
                onCompleteTask: { onAction?("sidebarCompleteTask", "\($0.accountId):\($0.id):\($1)") }
            )
            .frame(height: sidebarModel.gcalGridHeight > 100 ? sidebarModel.gcalGridHeight : nil)
            .frame(maxWidth: .infinity)
        }
    }
}

// MARK: - Week Companion Container View

private struct WeekCompanionContainerView: View {
    @ObservedObject var model: SidebarModel
    @State private var headerHeight: CGFloat = 113.0

    var body: some View {
        VStack(spacing: 0) {
            WeekScrubberView(model: model)
            Divider()
            DayFocusedEventsList(
                model: model,
                events: model.selectedDayEvents,
                date: model.selectedDate,
                headerHeight: headerHeight,
                onAction: model.onAction
            )
            Spacer(minLength: 0)
        }
        .onPreferenceChange(HeaderHeightPreferenceKey.self) { val in
            if val > 0, abs(headerHeight - val) > 0.5 {
                headerHeight = val
            }
        }
    }
}

// MARK: - Day Companion Container View

private struct DayCompanionContainerView: View {
    @ObservedObject var model: SidebarModel
    @State private var headerHeight: CGFloat = 113.0

    var body: some View {
        VStack(spacing: 0) {
            DayCompanionHeaderView(model: model)
            Divider()
            DayFocusedEventsList(
                model: model,
                events: model.selectedDayEvents,
                date: model.selectedDate,
                headerHeight: headerHeight,
                onAction: model.onAction
            )
            Spacer(minLength: 0)
        }
        .onPreferenceChange(HeaderHeightPreferenceKey.self) { val in
            if val > 0, abs(headerHeight - val) > 0.5 {
                headerHeight = val
            }
        }
    }
}

// MARK: - Sidebar Root View

public struct SidebarRootView: View {
    @ObservedObject public var model: SidebarModel

    @MainActor
    public init() {
        self.init(model: .shared)
    }

    public init(model: SidebarModel) {
        self.model = model
    }

    public var body: some View {
        VStack(spacing: 0) {
            switch model.viewMode {
            case .fantastical:
                fantasticalModeView
            case .week, .fourDay:
                weekModeView
            case .day:
                dayModeView
            }
        }
        .coordinateSpace(name: "SidebarCardContainer")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(groupingBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color(nsColor: .separatorColor).opacity(model.transparentBackground ? 0.35 : 0.2), lineWidth: 1)
        )
    }

    @ViewBuilder
    private var groupingBackground: some View {
        if model.transparentBackground {
            // Frosted wash: slightly more opaque than the rest of the window,
            // matching the Magimail menu bar list styling.
            Color.primary.opacity(model.isDarkMode ? 0.08 : 0.05)
        } else {
            // Opaque Google surface color matching the rest of the app when transparentBackground is false
            Color(hexString: model.isDarkMode ? "#202124" : "#f1f3f4")
        }
    }

    /// Fantastical Style: Month grid + continuous Schedule feed
    private var fantasticalModeView: some View {
        VStack(spacing: 0) {
            // Month header & collapse toggle matching Menu Bar Tray
            HStack(alignment: .center) {
                // Month Title (Click returns to Google Calendar's range) + collapse chevron
                HStack(spacing: 5) {
                    // Month and year own a fixed range too, so their title is a label. Only
                    // Schedule has an agenda the selector can step away from, so only there
                    // does the title offer a way back to Google Calendar's date.
                    if model.isScheduleTimeframe {
                        Button(action: {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                model.syncToGCalRange()
                            }
                        }) {
                            monthTitleLabel
                        }
                        .buttonStyle(.plain)
                        .help("Match Google Calendar")
                    } else {
                        monthTitleLabel
                    }

                    Button(action: {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
                            model.toggleCalendarCollapse()
                        }
                    }) {
                        Image(systemName: model.isCalendarCollapsed ? "chevron.right" : "chevron.down")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help(model.isCalendarCollapsed ? "Expand Calendar" : "Collapse Calendar")
                }

                Spacer()

                HStack(spacing: 4) {
                    // Schedule has no bounded range in Google Calendar, so its selector may
                    // step through the months the agenda covers. Month view owns a fixed
                    // range and gets no arrows: Google Calendar is the only thing that
                    // changes which month is on screen.
                    if model.isScheduleTimeframe {
                        Button(action: {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                model.previousMonth()
                            }
                        }) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(model.canStepToPreviousMonth ? .secondary : .tertiary)
                                .frame(width: 20, height: 20)
                        }
                        .buttonStyle(.plain)
                        .disabled(!model.canStepToPreviousMonth)
                        .help("Previous Month")

                        Button(action: {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                model.nextMonth()
                            }
                        }) {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(model.canStepToNextMonth ? .secondary : .tertiary)
                                .frame(width: 20, height: 20)
                        }
                        .buttonStyle(.plain)
                        .disabled(!model.canStepToNextMonth)
                        .help("Next Month")
                    }

                    CalendarFilterMenuView(model: model.trayModel)
                    SidebarSettingsMenuView(model: model.trayModel, onRefresh: { model.onAction?("sidebarRefresh", "") })
                }
            }
            .padding(.horizontal, 12)
            .frame(height: max(36.0, model.gcalCardTop - model.topMargin))

            // Mini month grid
            if !model.isCalendarCollapsed {
                MiniMonthGridView(
                    displayedMonth: model.displayedMonthDate,
                    selectedDate: model.selectedDate,
                    densityDots: model.trayModel.densityDotsByDay,
                    onSelectDate: { date in
                        model.selectDate(date)
                    }
                )
                .padding(.horizontal, 6)
                .padding(.bottom, 6)
                .transition(.opacity.combined(with: .move(edge: .top)))

                Divider()
            }

            // Continuous schedule agenda
            ScheduleAgendaView(
                feedItems: model.visibleScheduleFeedItems,
                selectedDate: model.selectedDate,
                requestedScrollDate: model.selectedDate,
                onSelectEvent: { event in model.onAction?("sidebarOpenEvent", event.id) },
                onJoinCall: { model.onAction?("sidebarJoinCall", $0) },
                onRsvp: { event, reply in model.onAction?("sidebarRsvp", "\(event.accountId):\(event.id):\(reply)") },
                onDeleteEvent: { event in model.onAction?("sidebarDeleteEvent", "\(event.accountId):\(event.id)") },
                onCompleteTask: { event, completed in model.onAction?("sidebarCompleteTask", "\(event.accountId):\(event.id):\(completed)") },
                onDayScrolledIntoView: { date in
                    model.selectedDate = date
                    // Scrolling the agenda is Google Calendar showing another month, so
                    // the selector follows there. In Month view the grid stays put; only
                    // the agenda moves.
                    if model.isScheduleTimeframe {
                        model.displayedMonthDate = date
                    }
                },
                onScrolledNearEnd: nil,
                isExplainedElsewhere: false
            )
        }
    }

    /// Week mode: Day scrubber + Focused day agenda
    private var weekModeView: some View {
        WeekCompanionContainerView(model: model)
    }

    /// Day mode: Day title header + Focused day agenda
    private var dayModeView: some View {
        DayCompanionContainerView(model: model)
    }

    private var monthTitleLabel: some View {
        Text(monthTitle(model.displayedMonthDate))
            .font(.system(size: 13.5, weight: .bold))
            .foregroundStyle(.primary)
    }

    private func monthTitle(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM yyyy"
        return formatter.string(from: date)
    }
}
