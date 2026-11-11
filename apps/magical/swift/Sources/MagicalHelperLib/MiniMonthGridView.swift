import SwiftUI

/// What the mini month derives from the week's first day.
///
/// Both answers are the whole reason this is not arithmetic inside the view: the sidebar
/// begins on the day Google Calendar begins its weeks, the popover on the Mac's, and a test has
/// to be able to ask each one the same question.
public enum MiniMonthLayout {
    /// The locale's own short weekday letters, rotated so the week's first day leads.
    ///
    /// The letters are not ours to spell out: a locale that starts its week on Sunday, or
    /// does not use Latin letters, would be shown the wrong seven either way.
    public static func weekdaySymbols(firstWeekday: Int, locale: Locale = .current) -> [String] {
        let symbols = calendar(firstWeekday: firstWeekday, locale: locale).veryShortWeekdaySymbols
        let offset = (firstWeekday - 1) % symbols.count
        return Array(symbols[offset...] + symbols[..<offset])
    }

    /// How many days of the previous month fill the first row before the 1st.
    public static func leadDays(of date: Date, firstWeekday: Int, locale: Locale = .current) -> Int {
        let calendar = calendar(firstWeekday: firstWeekday, locale: locale)
        let weekday = calendar.component(.weekday, from: date)
        return (weekday - firstWeekday + 7) % 7
    }

    static func calendar(firstWeekday: Int, locale: Locale) -> Calendar {
        var calendar = Calendar.current
        calendar.firstWeekday = (1 ... 7).contains(firstWeekday)
            ? firstWeekday
            : Calendar.current.firstWeekday
        calendar.locale = locale
        return calendar
    }
}

public struct MiniMonthGridView: View {
    public let displayedMonth: Date
    public let selectedDate: Date
    public let densityDots: [String: [Color]]
    /// The day this grid's weeks start on: Google Calendar's for the sidebar, the Mac's
    /// region for the popover.
    public let firstWeekday: Int
    public let onSelectDate: (Date) -> Void

    private var calendar: Calendar {
        MiniMonthLayout.calendar(firstWeekday: firstWeekday, locale: .current)
    }

    private var weekdaySymbols: [String] {
        MiniMonthLayout.weekdaySymbols(firstWeekday: firstWeekday)
    }

    public init(
        displayedMonth: Date,
        selectedDate: Date,
        densityDots: [String: [Color]],
        firstWeekday: Int,
        onSelectDate: @escaping (Date) -> Void
    ) {
        self.displayedMonth = displayedMonth
        self.selectedDate = selectedDate
        self.densityDots = densityDots
        self.firstWeekday = firstWeekday
        self.onSelectDate = onSelectDate
    }

    public var body: some View {
        VStack(spacing: 6) {
            // Weekday symbols header row
            HStack(spacing: 0) {
                ForEach(0 ..< 7, id: \.self) { index in
                    Text(weekdaySymbols[index])
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity)
                }
            }

            // Month days grid
            let days = daysInMonthGrid()
            let rows = days.chunked(into: 7)

            VStack(spacing: 4) {
                ForEach(0 ..< rows.count, id: \.self) { rowIndex in
                    HStack(spacing: 0) {
                        ForEach(rows[rowIndex], id: \.date) { item in
                            dayCell(item)
                                .frame(maxWidth: .infinity)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 4)
    }

    private struct DayGridItem {
        let date: Date
        let isCurrentMonth: Bool
        let isToday: Bool
        let isSelected: Bool
        let dateKey: String
        let dayNumber: String
    }

    private func dayCell(_ item: DayGridItem) -> some View {
        Button(action: { onSelectDate(item.date) }) {
            VStack(spacing: 2) {
                ZStack {
                    // Today is always the solid disc; the ring only ever marks the selection.
                    // The two compose, so the day that is both wears the disc inside the ring
                    // rather than losing one state to the other. Both diameters are fixed, so
                    // neither state changes the height of a grid row.
                    if item.isToday {
                        Circle()
                            .fill(Color.blue)
                            .frame(width: 20, height: 20)
                    } else if item.isSelected {
                        Circle()
                            .fill(Color.blue.opacity(0.15))
                            .frame(width: 20, height: 20)
                    }

                    if item.isSelected {
                        Circle()
                            .strokeBorder(Color.blue, lineWidth: 1.2)
                            .frame(width: 24, height: 24)
                    }

                    Text(item.dayNumber)
                        .font(.system(size: 11.5, weight: item.isToday || item.isSelected ? .bold : .medium, design: .rounded).monospacedDigit())
                        .foregroundStyle(
                            item.isToday
                                ? Color.white
                                : (item.isSelected
                                    ? Color.blue
                                    : (item.isCurrentMonth ? Color.primary : Color.secondary.opacity(0.4)))
                        )
                }
                .frame(width: 26, height: 24)

                // Density dots underneath
                // A day with nothing on it still reserves the row, so a week of quiet days
                // does not sit at a different height from a week of busy ones.
                let dots = densityDots[item.dateKey] ?? []
                HStack(spacing: 2) {
                    if dots.isEmpty {
                        Circle()
                            .fill(Color.clear)
                            .frame(width: 3.5, height: 3.5)
                    } else {
                        ForEach(0 ..< min(dots.count, 4), id: \.self) { i in
                            Circle()
                                .fill(dots[i])
                                .frame(width: 3.5, height: 3.5)
                        }
                    }
                }
                .frame(height: 4)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func daysInMonthGrid() -> [DayGridItem] {
        guard let monthInterval = calendar.dateInterval(of: .month, for: displayedMonth) else {
            return []
        }

        let firstDayOfMonth = monthInterval.start
        let leadDays = MiniMonthLayout.leadDays(of: firstDayOfMonth, firstWeekday: firstWeekday)

        var items: [DayGridItem] = []
        let today = calendar.startOfDay(for: Date())
        let selected = calendar.startOfDay(for: selectedDate)

        let df = TrayFormatters.dateFormatter

        // Lead days from previous month
        if leadDays > 0 {
            for offset in (1 ... leadDays).reversed() {
                if let prevDate = calendar.date(byAdding: .day, value: -offset, to: firstDayOfMonth) {
                    let dateKey = df.string(from: prevDate)
                    let dayNum = "\(calendar.component(.day, from: prevDate))"
                    items.append(DayGridItem(
                        date: prevDate,
                        isCurrentMonth: false,
                        isToday: calendar.isDate(prevDate, inSameDayAs: today),
                        isSelected: calendar.isDate(prevDate, inSameDayAs: selected),
                        dateKey: dateKey,
                        dayNumber: dayNum
                    ))
                }
            }
        }

        // Days of current month
        let dayCount = calendar.range(of: .day, in: .month, for: displayedMonth)?.count ?? 30
        for day in 0 ..< dayCount {
            if let date = calendar.date(byAdding: .day, value: day, to: firstDayOfMonth) {
                let dateKey = df.string(from: date)
                let dayNum = "\(calendar.component(.day, from: date))"
                items.append(DayGridItem(
                    date: date,
                    isCurrentMonth: true,
                    isToday: calendar.isDate(date, inSameDayAs: today),
                    isSelected: calendar.isDate(date, inSameDayAs: selected),
                    dateKey: dateKey,
                    dayNumber: dayNum
                ))
            }
        }

        // Trailing days to fill the final week
        let remaining = (7 - (items.count % 7)) % 7
        if remaining > 0, let lastDate = items.last?.date {
            for offset in 1 ... remaining {
                if let nextDate = calendar.date(byAdding: .day, value: offset, to: lastDate) {
                    let dateKey = df.string(from: nextDate)
                    let dayNum = "\(calendar.component(.day, from: nextDate))"
                    items.append(DayGridItem(
                        date: nextDate,
                        isCurrentMonth: false,
                        isToday: calendar.isDate(nextDate, inSameDayAs: today),
                        isSelected: calendar.isDate(nextDate, inSameDayAs: selected),
                        dateKey: dateKey,
                        dayNumber: dayNum
                    ))
                }
            }
        }

        return items
    }
}

private extension Array {
    func chunked(into size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map {
            Array(self[$0 ..< Swift.min($0 + size, count)])
        }
    }
}
