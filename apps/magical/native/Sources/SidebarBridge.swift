import AppKit
import MagicalHelperLib
import SuiteNative
import SwiftUI

// MARK: - View Mode

public enum SidebarViewMode: String {
    case fantastical // Month, Schedule, Year
    case week // 7-Day Week
    case fourDay // 4-Day View
    case day // Day
}

// MARK: - Week Day Item

public struct WeekDayItem: Identifiable, Equatable {
    public let id: String
    public let date: Date
    public let dayLetter: String
    public let dayNumber: String
    public let isToday: Bool
    public let isSelected: Bool
    public let dots: [Color]
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

    public let trayModel = TrayModel.shared

    private let calendar: Calendar = {
        var cal = Calendar.current
        cal.firstWeekday = 2 // Monday start
        return cal
    }()

    public init() {
        recomputeWeekDays()
    }

    public func selectDate(_ date: Date) {
        selectedDate = date
        displayedMonthDate = date
        recomputeWeekDays()
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        ActionBridge.emit("sidebarSelectDate", formatter.string(from: date))
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
        ActionBridge.emit("sidebarSelectDate", formatter.string(from: today))
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
                    SidebarSettingsMenuView(model: model.trayModel, onRefresh: { ActionBridge.emit("sidebarRefresh", "") })
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
                SidebarSettingsMenuView(model: model.trayModel, onRefresh: { ActionBridge.emit("sidebarRefresh", "") })
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
                            onSelect: { ActionBridge.emit("sidebarOpenEvent", event.id) },
                            onDelete: { ActionBridge.emit("sidebarDeleteEvent", "\($0.accountId):\($0.id)") },
                            onComplete: { ActionBridge.emit("sidebarCompleteTask", "\($0.accountId):\($0.id):\($1)") }
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
                onSelectEvent: { ActionBridge.emit("sidebarOpenEvent", $0.id) },
                onJoinCall: { ActionBridge.emit("sidebarJoinCall", $0) },
                onRsvp: { ActionBridge.emit("sidebarRsvp", "\($0.accountId):\($0.id):\($1)") },
                onDeleteEvent: { ActionBridge.emit("sidebarDeleteEvent", "\($0.accountId):\($0.id)") },
                onCompleteTask: { ActionBridge.emit("sidebarCompleteTask", "\($0.accountId):\($0.id):\($1)") }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Sidebar Root View

public struct SidebarRootView: View {
    @ObservedObject var model: SidebarModel = .shared

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
            // Translucent wash: keeps the same vibrancy as the rest of the window,
            // with a gentle tint that visually groups the sidebar panel.
            Color.primary.opacity(model.isDarkMode ? 0.04 : 0.02)
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
                    SidebarSettingsMenuView(model: model.trayModel, onRefresh: { ActionBridge.emit("sidebarRefresh", "") })
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
                onSelectEvent: { event in ActionBridge.emit("sidebarOpenEvent", event.id) },
                onJoinCall: { ActionBridge.emit("sidebarJoinCall", $0) },
                onRsvp: { event, reply in ActionBridge.emit("sidebarRsvp", "\(event.accountId):\(event.id):\(reply)") },
                onDeleteEvent: { event in ActionBridge.emit("sidebarDeleteEvent", "\(event.accountId):\(event.id)") },
                onCompleteTask: { event, completed in ActionBridge.emit("sidebarCompleteTask", "\(event.accountId):\(event.id):\(completed)") },
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
            DayFocusedEventsList(events: model.selectedDayEvents, date: model.selectedDate)
        }
    }

    /// Day mode: Day title header + Focused day agenda
    private var dayModeView: some View {
        VStack(spacing: 0) {
            DayCompanionHeaderView(model: model)
            Divider()
            DayFocusedEventsList(events: model.selectedDayEvents, date: model.selectedDate)
        }
    }

    private func monthTitle(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM yyyy"
        return formatter.string(from: date)
    }
}

// MARK: - Sidebar Manager (AppKit Host)

@MainActor
public final class SidebarManager {
    public static let shared = SidebarManager()

    public private(set) weak var window: NSWindow?
    private var visualEffectView: NSVisualEffectView?
    private var hostingView: NSHostingView<SidebarRootView>?
    private var widthConstraint: NSLayoutConstraint?

    public var isVisible: Bool = true
    public var position: String = "right"
    public let cardWidth: CGFloat = 254
    public let margin: CGFloat = 8
    public let topMargin: CGFloat = 6
    public let cornerRadius: CGFloat = 10
    public let calendarMinWidth: CGFloat = 1200
    public var minRequiredWidth: CGFloat {
        calendarMinWidth + cardWidth + margin * 2
    } // 1470
    public var width: CGFloat {
        cardWidth + margin * 2
    } // 270

    public init() {}

    public func attach(to window: NSWindow) {
        self.window = window
        guard let contentView = window.contentView else { return }

        if visualEffectView == nil {
            let effect = NSVisualEffectView(frame: .zero)
            effect.material = .sidebar
            effect.blendingMode = .behindWindow
            effect.state = .followsWindowActiveState
            effect.translatesAutoresizingMaskIntoConstraints = false
            effect.wantsLayer = true
            effect.layer?.cornerRadius = cornerRadius
            effect.layer?.cornerCurve = .continuous
            effect.layer?.masksToBounds = true
            effect.layer?.borderWidth = 1.0
            effect.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.35).cgColor

            let host = NSHostingView(rootView: SidebarRootView())
            host.translatesAutoresizingMaskIntoConstraints = false
            effect.addSubview(host)

            NSLayoutConstraint.activate([
                host.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
                host.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
                host.topAnchor.constraint(equalTo: effect.topAnchor),
                host.bottomAnchor.constraint(equalTo: effect.bottomAnchor),
            ])

            contentView.addSubview(effect)

            let widthC = effect.widthAnchor.constraint(equalToConstant: isVisible ? cardWidth : 0)
            widthConstraint = widthC

            let toolbarHeight: CGFloat = 52

            NSLayoutConstraint.activate([
                widthC,
                effect.topAnchor.constraint(equalTo: contentView.topAnchor, constant: toolbarHeight + topMargin),
                effect.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -margin),
                effect.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -margin),
            ])

            visualEffectView = effect
            hostingView = host
            effect.isHidden = !isVisible

            applyTransparency()
        }

        window.minSize = NSSize(width: isVisible ? minRequiredWidth : calendarMinWidth, height: 600)
        if isVisible, window.frame.size.width < minRequiredWidth {
            var frame = window.frame
            frame.size.width = minRequiredWidth
            window.setFrame(frame, display: true, animate: false)
        }
    }

    public func setTransparency(_ transparent: Bool, isDark: Bool) {
        SidebarModel.shared.transparentBackground = transparent
        SidebarModel.shared.isDarkMode = isDark
        applyTransparency()
    }

    private func applyTransparency() {
        guard let effect = visualEffectView else { return }
        if SidebarModel.shared.transparentBackground {
            effect.material = .sidebar
            effect.blendingMode = .behindWindow
            effect.state = .followsWindowActiveState
        } else {
            effect.material = .underWindowBackground
            effect.state = .inactive
        }
    }

    private var lastExpandedDelta: CGFloat = 0

    public func setVisible(_ visible: Bool, animated: Bool) {
        guard isVisible != visible else { return }
        isVisible = visible
        SidebarModel.shared.isVisible = visible

        guard let effect = visualEffectView, let widthC = widthConstraint else { return }

        if visible {
            effect.isHidden = false
        }

        let targetWidth: CGFloat = visible ? cardWidth : 0

        var targetFrame: NSRect? = nil
        if visible, let window {
            let currentWidth = window.frame.size.width
            if currentWidth < minRequiredWidth {
                let delta = minRequiredWidth - currentWidth
                lastExpandedDelta = delta
                var frame = window.frame
                let targetWindowWidth = minRequiredWidth
                if let screen = window.screen ?? NSScreen.main {
                    let maxRight = screen.visibleFrame.maxX
                    if frame.origin.x + targetWindowWidth > maxRight {
                        frame.origin.x = max(screen.visibleFrame.minX, maxRight - targetWindowWidth)
                    }
                }
                frame.size.width = targetWindowWidth
                targetFrame = frame
            } else {
                lastExpandedDelta = 0
            }
        } else if !visible, let window {
            // Lower minSize first so AppKit permits shrinking the window
            window.minSize = NSSize(width: calendarMinWidth, height: 600)
            if lastExpandedDelta > 0 {
                var frame = window.frame
                if frame.size.width <= minRequiredWidth + 2 {
                    let targetWindowWidth = max(calendarMinWidth, frame.size.width - lastExpandedDelta)
                    frame.size.width = targetWindowWidth
                    targetFrame = frame
                }
                lastExpandedDelta = 0
            }
        }

        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.25
                context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                context.allowsImplicitAnimation = true
                widthC.animator().constant = targetWidth
                effect.animator().alphaValue = visible ? 1.0 : 0.0
                if let targetFrame, let window {
                    window.animator().setFrame(targetFrame, display: true)
                }
            } completionHandler: { [weak self] in
                guard let self else { return }
                if let window {
                    window.minSize = NSSize(width: visible ? minRequiredWidth : calendarMinWidth, height: 600)
                }
                if !visible {
                    effect.isHidden = true
                }
            }
        } else {
            widthC.constant = targetWidth
            effect.alphaValue = visible ? 1.0 : 0.0
            effect.isHidden = !visible
            if let targetFrame, let window {
                window.setFrame(targetFrame, display: true, animate: false)
            }
            if let window {
                window.minSize = NSSize(width: visible ? minRequiredWidth : calendarMinWidth, height: 600)
            }
        }
    }

    public func updateData(json: String) {
        guard let data = json.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }

        SidebarModel.shared.trayModel.update(from: dict)
        SidebarModel.shared.recomputeWeekDays()
    }

    public func setViewMode(mode: String, anchorDateStr: String?) {
        let viewMode: SidebarViewMode = switch mode.lowercased() {
        case "customday", "custom_days", "fourday", "four_day", "4day", "4_day":
            .fourDay
        case "week", "customweek", "custom_weeks":
            .week
        case "day":
            .day
        case "month", "year", "agenda", "schedule", "fantastical":
            .fantastical
        default:
            .day
        }

        var anchor: Date? = Date()
        if let str = anchorDateStr, !str.isEmpty {
            let df = DateFormatter()
            df.dateFormat = "yyyy-MM-dd"
            df.timeZone = .current
            if let parsed = df.date(from: str) {
                anchor = parsed
            }
        }

        SidebarModel.shared.setViewMode(viewMode, anchor: anchor)
    }
}

// MARK: - C Cdecl Exports for Node Addon

@_cdecl("sidebar_attach")
public func sidebarAttach(_ nsViewPtr: UnsafeMutableRawPointer) {
    let contentView = Unmanaged<NSView>.fromOpaque(nsViewPtr).takeUnretainedValue()
    guard let window = contentView.window else { return }

    DispatchQueue.main.async {
        SidebarManager.shared.attach(to: window)
    }
}

@_cdecl("sidebar_set_visible")
public func sidebarSetVisible(_ visible: Bool, _ animated: Bool) {
    DispatchQueue.main.async {
        SidebarManager.shared.setVisible(visible, animated: animated)
    }
}

@_cdecl("sidebar_update_data")
public func sidebarUpdateData(_ json: UnsafePointer<CChar>) {
    let str = String(cString: json)
    DispatchQueue.main.async {
        SidebarManager.shared.updateData(json: str)
    }
}

@_cdecl("sidebar_set_view_mode")
public func sidebarSetViewMode(_ modePtr: UnsafePointer<CChar>, _ anchorPtr: UnsafePointer<CChar>?) {
    let mode = String(cString: modePtr)
    let anchor: String? = anchorPtr != nil ? String(cString: anchorPtr!) : nil
    DispatchQueue.main.async {
        SidebarManager.shared.setViewMode(mode: mode, anchorDateStr: anchor)
    }
}

@_cdecl("sidebar_set_transparency")
public func sidebarSetTransparency(_ transparent: Bool, _ isDark: Bool) {
    DispatchQueue.main.async {
        SidebarManager.shared.setTransparency(transparent, isDark: isDark)
    }
}

// MARK: - Color Hex Helper

private extension Color {
    init(hexString: String) {
        let cleaned = hexString.hasPrefix("#") ? String(hexString.dropFirst()) : hexString
        guard cleaned.count == 6, let value = UInt32(cleaned, radix: 16) else {
            self.init(white: 0.5)
            return
        }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255.0,
            green: Double((value >> 8) & 0xFF) / 255.0,
            blue: Double(value & 0xFF) / 255.0
        )
    }
}
