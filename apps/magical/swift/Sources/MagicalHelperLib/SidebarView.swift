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
    @Published public var selectedDate: Date = .init()
    @Published public var displayedMonthDate: Date = .init()
    @Published public var anchorDate: Date = .init()
    @Published public var isCalendarCollapsed: Bool = false
    @Published public var isVisible: Bool = true
    @Published public var currentWeekDays: [WeekDayItem] = []

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
    }

    public func selectDate(_ date: Date) {
        selectedDate = date
        displayedMonthDate = date
        recomputeWeekDays()
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        onAction?("sidebarSelectDate", formatter.string(from: date))
    }

    public func jumpToToday() {
        let today = Date()
        anchorDate = today
        selectedDate = today
        displayedMonthDate = today
        recomputeWeekDays()
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        onAction?("sidebarSelectDate", formatter.string(from: today))
    }

    public func previousMonth() {
        if let prev = calendar.date(byAdding: .month, value: -1, to: displayedMonthDate) {
            displayedMonthDate = prev
        }
    }

    public func nextMonth() {
        if let next = calendar.date(byAdding: .month, value: 1, to: displayedMonthDate) {
            displayedMonthDate = next
        }
    }

    public func toggleCalendarCollapse() {
        isCalendarCollapsed.toggle()
    }

    public func setViewMode(_ mode: SidebarViewMode, anchor: Date? = nil) {
        viewMode = mode
        let target = anchor ?? Date()
        anchorDate = target
        selectedDate = target
        displayedMonthDate = target
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
        let keyFormatter = DateFormatter()
        keyFormatter.dateFormat = "yyyy-MM-dd"
        keyFormatter.timeZone = .current
        let key = keyFormatter.string(from: selectedDate)

        return trayModel.filteredEvents.filter { $0.dateKey == key }
    }
}

// MARK: - Week Scrubber View

public struct WeekScrubberView: View {
    @ObservedObject var model: SidebarModel

    public init(model: SidebarModel) {
        self.model = model
    }

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
        VStack(spacing: 8) {
            // Header with week label and calendar filter/settings
            HStack(alignment: .center) {
                Button(action: {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        model.jumpToToday()
                    }
                }) {
                    Text(weekRangeText)
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
                .help("Jump to Now")

                Spacer()

                HStack(spacing: 4) {
                    CalendarFilterMenuView(model: model.trayModel)
                    SidebarSettingsMenuView(model: model.trayModel, onRefresh: { model.onAction?("sidebarRefresh", "") })
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)

            // Day pills row
            HStack(spacing: 4) {
                ForEach(model.currentWeekDays) { item in
                    dayPill(item)
                }
            }
            .padding(.horizontal, 8)
        }
        .padding(.bottom, 8)
    }

    private func dayPill(_ item: WeekDayItem) -> some View {
        Button(action: { model.selectDate(item.date) }) {
            VStack(spacing: 2) {
                Text(item.dayLetter)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(item.isSelected ? .primary : .tertiary)

                ZStack {
                    if item.isToday {
                        Circle()
                            .fill(Color.blue)
                            .frame(width: 22, height: 22)
                    } else if item.isSelected {
                        Circle()
                            .fill(Color.blue.opacity(0.15))
                            .frame(width: 22, height: 22)
                    }

                    if item.isSelected {
                        Circle()
                            .strokeBorder(Color.blue, lineWidth: 1.2)
                            .frame(width: 24, height: 24)
                    }

                    Text(item.dayNumber)
                        .font(.system(size: 11, weight: item.isToday || item.isSelected ? .bold : .regular))
                        .foregroundStyle(item.isToday ? .white : (item.isSelected ? Color.blue : .primary))
                }
                .frame(width: 26, height: 26)

                // Density dots
                HStack(spacing: 2) {
                    if item.dots.isEmpty {
                        Circle()
                            .fill(Color.clear)
                            .frame(width: 3.5, height: 3.5)
                    } else {
                        ForEach(0 ..< min(3, item.dots.count), id: \.self) { idx in
                            Circle()
                                .fill(item.dots[idx])
                                .frame(width: 3.5, height: 3.5)
                        }
                    }
                }
                .frame(height: 5)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Day Companion Header View

public struct DayCompanionHeaderView: View {
    @ObservedObject var model: SidebarModel

    public init(model: SidebarModel) {
        self.model = model
    }

    private var dayTitle: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEEE, MMMM d"
        return formatter.string(from: model.selectedDate)
    }

    public var body: some View {
        HStack(alignment: .center) {
            Button(action: {
                withAnimation(.easeInOut(duration: 0.2)) {
                    model.jumpToToday()
                }
            }) {
                Text(dayTitle)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.primary)
            }
            .buttonStyle(.plain)
            .help("Jump to Now")

            Spacer()

            HStack(spacing: 4) {
                CalendarFilterMenuView(model: model.trayModel)
                SidebarSettingsMenuView(model: model.trayModel, onRefresh: { model.onAction?("sidebarRefresh", "") })
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

// MARK: - Day Focused Events List

public struct DayFocusedEventsList: View {
    let events: [TrayEvent]
    let date: Date
    var onAction: ((_ action: String, _ value: String) -> Void)?

    public init(
        events: [TrayEvent],
        date: Date,
        onAction: ((_ action: String, _ value: String) -> Void)? = nil
    ) {
        self.events = events
        self.date = date
        self.onAction = onAction
    }

    private var allDayEvents: [TrayEvent] {
        events.filter(\.isAllDay)
    }

    private var timedEvents: [TrayEvent] {
        events.filter { !$0.isAllDay }.sorted(by: { $0.startTime < $1.startTime })
    }

    public var body: some View {
        VStack(spacing: 0) {
            // 1. Pinned All-Day Banners at the top
            if !allDayEvents.isEmpty {
                VStack(spacing: 4) {
                    ForEach(allDayEvents, id: \.identity) { event in
                        AllDayBannerView(
                            event: event,
                            onSelect: { onAction?("sidebarOpenEvent", event.id) },
                            onDelete: { onAction?("sidebarDeleteEvent", "\($0.accountId):\($0.id)") },
                            onComplete: { onAction?("sidebarCompleteTask", "\($0.accountId):\($0.id):\($1)") }
                        )
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)

                Divider()
            }

            // 2. Day Time Grid
            DayTimeGridView(
                date: date,
                events: timedEvents,
                onSelectEvent: { onAction?("sidebarOpenEvent", $0.id) },
                onJoinCall: { onAction?("sidebarJoinCall", $0) },
                onRsvp: { onAction?("sidebarRsvp", "\($0.accountId):\($0.id):\($1)") },
                onDeleteEvent: { onAction?("sidebarDeleteEvent", "\($0.accountId):\($0.id)") },
                onCompleteTask: { onAction?("sidebarCompleteTask", "\($0.accountId):\($0.id):\($1)") }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                // Month Title (Click jumps to today) + In-Place Toggle Chevron
                HStack(spacing: 5) {
                    Button(action: {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            model.jumpToToday()
                        }
                    }) {
                        Text(monthTitle(model.displayedMonthDate))
                            .font(.system(size: 13.5, weight: .bold))
                            .foregroundStyle(.primary)
                    }
                    .buttonStyle(.plain)
                    .help("Jump to Now")

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

                // Filter & Settings
                HStack(spacing: 4) {
                    CalendarFilterMenuView(model: model.trayModel)
                    SidebarSettingsMenuView(model: model.trayModel, onRefresh: { model.onAction?("sidebarRefresh", "") })
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

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
                feedItems: model.trayModel.scheduleFeedItems,
                selectedDate: model.selectedDate,
                requestedScrollDate: model.selectedDate,
                onSelectEvent: { event in model.onAction?("sidebarOpenEvent", event.id) },
                onJoinCall: { model.onAction?("sidebarJoinCall", $0) },
                onRsvp: { event, reply in model.onAction?("sidebarRsvp", "\(event.accountId):\(event.id):\(reply)") },
                onDeleteEvent: { event in model.onAction?("sidebarDeleteEvent", "\(event.accountId):\(event.id)") },
                onCompleteTask: { event, completed in model.onAction?("sidebarCompleteTask", "\(event.accountId):\(event.id):\(completed)") },
                onDayScrolledIntoView: { date in
                    model.selectedDate = date
                },
                onScrolledNearEnd: nil,
                isExplainedElsewhere: false
            )
        }
    }

    /// Week mode: Day scrubber + Focused day agenda
    private var weekModeView: some View {
        VStack(spacing: 0) {
            WeekScrubberView(model: model)
            Divider()
            DayFocusedEventsList(
                events: model.selectedDayEvents,
                date: model.selectedDate,
                onAction: model.onAction
            )
        }
    }

    /// Day mode: Day title header + Focused day agenda
    private var dayModeView: some View {
        VStack(spacing: 0) {
            DayCompanionHeaderView(model: model)
            Divider()
            DayFocusedEventsList(
                events: model.selectedDayEvents,
                date: model.selectedDate,
                onAction: model.onAction
            )
        }
    }

    private func monthTitle(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM yyyy"
        return formatter.string(from: date)
    }
}
