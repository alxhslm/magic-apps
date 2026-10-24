import SwiftUI

public struct MiniMonthGridView: View {
    public let displayedMonth: Date
    public let selectedDate: Date
    public let densityDots: [String: [Color]]
    public let onSelectDate: (Date) -> Void

    private var calendar: Calendar {
        var calendar = Calendar.current
        calendar.firstWeekday = 2
        calendar.locale = .current
        return calendar
    }

    /// `M T W T F S S`, from the user's locale and rotated to Monday, the day the
    /// grid starts on. The letters are not ours to spell out: a locale that starts
    /// its week on Sunday, or does not use Latin letters, would be shown the wrong
    /// seven either way.
    private var weekdaySymbols: [String] {
        let symbols = calendar.veryShortWeekdaySymbols
        let offset = calendar.firstWeekday - 1
        return Array(symbols[offset...] + symbols[..<offset])
    }

    public init(
        displayedMonth: Date,
        selectedDate: Date,
        densityDots: [String: [Color]],
        onSelectDate: @escaping (Date) -> Void
    ) {
        self.displayedMonth = displayedMonth
        self.selectedDate = selectedDate
        self.densityDots = densityDots
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
        // Align to Monday start (1=Sunday, 2=Monday, ..., 7=Saturday in Apple Calendar)
        let weekday = calendar.component(.weekday, from: firstDayOfMonth)
        // Monday=0, Tuesday=1, ..., Sunday=6
        let leadDays = (weekday + 5) % 7

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
