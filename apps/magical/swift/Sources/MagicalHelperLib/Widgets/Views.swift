import SwiftUI
import WidgetKit

// MARK: - Shared pieces

//
// Layout follows docs/magical/widgets.md. An event is a discrete card,
// never a row in a divided list: Magimail draws a thread list as one inset
// group because an inbox is a feed, and draws an account as its own tile
// because an account is a discrete thing. A day is blocks with gaps between
// them, so events take the tile treatment. The values below are Magimail's, so
// the two apps' widgets can sit side by side in Notification Center.

/// The two links a widget produces that name no event. `main.ts` answers both.
enum WidgetLink {
    // Force-unwrapped deliberately: these are literals, and a nil here would be
    // a typo rather than a condition to handle at runtime.
    static let openApp = URL(string: "magical://open")!
    static let quickAdd = URL(string: "magical://quick-add")!
}

/// The popover's brand mark, drawn from the same file.
///
/// The artwork is `HelperBrand`'s, which the widget links as a local package
/// while `BrandArtwork` is compiled in by reference, so the widget and the
/// popover header cannot drift apart. An SF Symbol pairing was tried first and
/// is a different mark: the real one is a line-drawn calendar with two sparkles
/// of two golds radiating off its top-left, which no two symbols compose into.
struct BrandMarkView: View {
    var width: CGFloat = 18

    var body: some View {
        if let image = BrandArtwork.mark.image(width: width) {
            Image(nsImage: image)
                .resizable()
                .frame(width: width, height: width / BrandArtwork.mark.aspectRatio)
        }
    }
}

/// The header every widget opens with, laid out as Magimail's is: the mark and
/// the app's name together on the leading edge, what the widget is looking at on
/// the trailing edge, then the one action.
///
/// The mark never sits directly beside the date or the month. Next to content it
/// reads as an icon for that content rather than as the app it belongs to.
struct WidgetHeader: View {
    var status: String?

    /// `September 2026`, the status every family but the small one carries.
    static func month(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM yyyy"
        return formatter.string(from: date)
    }

    var body: some View {
        HStack(spacing: 7) {
            BrandMarkView()
            Text("Magical")
                .font(.system(size: 12.5, weight: .semibold))
            Spacer(minLength: 4)
            if let status {
                Text(status)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            QuickAddButton()
        }
    }
}

enum Metrics {
    static let hairline = Color.primary.opacity(0.08)
    static let cardFill = Color.primary.opacity(0.06)
    static let accent = Color.accentColor
}

/// The one action worth interrupting someone for.
///
/// A `Link` rather than a `Button` behind an App Intent. The destination is the
/// conference URL, already converted for the desktop client, so the app that
/// opens is Zoom, Teams or the browser; Magical is not the handler for any of
/// those schemes and does not come forward.
struct JoinButton: View {
    let url: URL
    var compact = false

    var body: some View {
        Link(destination: url) {
            Label("Join", systemImage: "video.fill")
                .font(.system(size: compact ? 10.5 : 11, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, compact ? 8 : 10)
                .padding(.vertical, compact ? 3 : 5)
                .background(RoundedRectangle(cornerRadius: 5).fill(Metrics.accent))
        }
        .buttonStyle(.plain)
    }
}

/// Quick Add, drawn as the popover's header draws it.
///
/// `calendar.badge.plus` rather than a bare plus: a plus on its own names an
/// action that could add anything, and a widget header has no label to say what.
struct QuickAddButton: View {
    var body: some View {
        Link(destination: WidgetLink.quickAdd) {
            Image(systemName: "calendar.badge.plus")
                .font(.system(size: 13))
                .foregroundStyle(.primary)
        }
        .buttonStyle(.plain)
    }
}

/// The countdown.
///
/// Green only while the meeting is actually running. A meeting three hours out
/// in the same green reads as something to drop everything for.
///
/// Upcoming, it uses `Text(_:style: .relative)`, which WidgetKit ticks in place.
/// The helper redraws the menu bar title on a 30-second timer; a widget has no
/// such timer, and a timeline reloaded that often is throttled off.
struct CountdownPill: View {
    let event: CachedEvent
    let now: Date

    var body: some View {
        let running = event.isRunning(at: now)
        let tint = running ? Color.green : Color.secondary
        let label = running
            ? String(localized: "NOW")
            : (WidgetFormat.countdown(to: event.startDate, from: now)
                ?? WidgetFormat.time(event.startDate))

        Text(label)
            .font(.system(size: 9.5, weight: .bold))
            .tracking(1)
            .foregroundStyle(tint)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Capsule().fill(tint.opacity(running ? 0.16 : 0.12)))
    }
}

/// One event.
///
/// The leading bar is the only thing on the card drawn in the calendar's
/// colour. Tinting the border and the fill as well turned a column of cards
/// from six calendars into six washes of colour, and left the bar meant to be
/// read from as the quietest of the three.
struct EventCard: View {
    let event: CachedEvent
    var showsService = false
    var titleSize: CGFloat = 12.5

    private var isCompleted: Bool {
        event.isCompleted == true
    }

    private var meta: String {
        guard showsService, let service = event.conferenceService else { return event.timeRange }
        return "\(event.timeRange) · \(service)"
    }

    var body: some View {
        Link(destination: event.destination ?? WidgetLink.openApp) {
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        // Says what the entry is, in the one place a widget has room for it.
                        if let kind = event.kindGlyph {
                            Image(systemName: kind.symbol)
                                .font(.system(size: titleSize - 1.5))
                                .foregroundStyle(.secondary)
                                .accessibilityLabel(kind.label)
                        }
                        Text(event.title)
                            .font(.system(size: titleSize, weight: .semibold))
                            .foregroundStyle(isCompleted ? .secondary : .primary)
                            .lineLimit(1)
                    }
                    Text(meta)
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 2)
            }
            .padding(.vertical, 6)
            .padding(.leading, 13)
            .padding(.trailing, 6)
            .background(RoundedRectangle(cornerRadius: 7).fill(Metrics.cardFill))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Metrics.hairline, lineWidth: 1))
            .overlay(alignment: .leading) { AccentBar(colour: event.colour) }
            .opacity(isCompleted ? 0.6 : 1.0)
            // The card is as tall as its two lines. Without this a column of
            // cards shares out the whole widget's height between them, and one
            // event fills a large family on its own.
            .fixedSize(horizontal: false, vertical: true)
        }
        .buttonStyle(.plain)
    }
}

/// The calendar's colour on the leading edge.
///
/// Always an overlay, never a sibling in a stack. `Color` is greedy on both
/// axes, so a `Color.clear` bounded only in width swallows every spare point of
/// height its row is offered and stretches the card with it.
struct AccentBar: View {
    let colour: Color
    var inset: CGFloat = 4

    var body: some View {
        Capsule()
            .fill(colour)
            .frame(width: 3)
            .padding(.vertical, inset)
            .padding(.leading, 5)
    }
}

/// `TODAY`, `TOMORROW`, or the weekday.
struct DayHeading: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 9.5, weight: .bold))
            .tracking(1)
            .foregroundStyle(.secondary)
    }
}

/// The hero: what is next, and the one button that joins it.
struct HeroEvent: View {
    let event: CachedEvent
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            CountdownPill(event: event, now: now)

            VStack(alignment: .leading, spacing: 2) {
                Text(event.title)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(2)
                Text(event.timeRange)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                if let service = event.conferenceService {
                    Text(service)
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.leading, 10)
            .overlay(alignment: .leading) { AccentBar(colour: event.colour, inset: 1) }
            .fixedSize(horizontal: false, vertical: true)

            if let join = event.joinUrl, let url = URL(string: join) {
                JoinButton(url: url)
            }
        }
    }
}

/// Shown when nothing has been cached yet, so a widget never renders blank.
struct EmptyState: View {
    var message = String(localized: "Nothing left today")
    var icon = "calendar"

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 20))
                .foregroundStyle(.secondary)
            Text(message)
                .font(.system(size: 11.5))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Mini month grid

/// Seven columns, Monday first whatever the locale says, as the popover's grid
/// is. Under each numeral sit up to four dots, one per distinct calendar with
/// something on that day; a day with nine calendars on it should still read as
/// busy rather than as a smear.
struct MiniMonthGrid: View {
    let cache: WidgetCache
    let now: Date
    var numeralSize: CGFloat = 9.5
    var rowSpacing: CGFloat = 1
    var dotSize: CGFloat = 2.8

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 2
        calendar.locale = .current
        return calendar
    }

    /// `M T W T F S S`, from the user's locale and rotated to Monday, the day
    /// the grid starts on. The letters are not ours to spell out: a locale that
    /// starts its week on Sunday, or does not use Latin letters, would be shown
    /// the wrong seven either way.
    private var weekdaySymbols: [String] {
        let symbols = calendar.veryShortWeekdaySymbols
        let offset = calendar.firstWeekday - 1
        return Array(symbols[offset...] + symbols[..<offset])
    }

    /// Whole weeks covering the month, so every row has seven cells and the
    /// neighbouring months fill the edges rather than leaving holes.
    private var days: [Date] {
        let calendar = calendar
        guard
            let monthStart = calendar.date(from: calendar.dateComponents([.year, .month], from: now)),
            let monthRange = calendar.range(of: .day, in: .month, for: monthStart)
        else {
            return []
        }

        let leading = (calendar.component(.weekday, from: monthStart) - calendar.firstWeekday + 7) % 7
        let total = Int(ceil(Double(leading + monthRange.count) / 7)) * 7

        return (0 ..< total).compactMap {
            calendar.date(byAdding: .day, value: $0 - leading, to: monthStart)
        }
    }

    var body: some View {
        let calendar = calendar
        let month = calendar.component(.month, from: now)

        VStack(spacing: rowSpacing) {
            HStack(spacing: 0) {
                ForEach(Array(weekdaySymbols.enumerated()), id: \.offset) { _, label in
                    Text(label)
                        .font(.system(size: 8.5, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }

            ForEach(Array(stride(from: 0, to: days.count, by: 7)), id: \.self) { start in
                HStack(spacing: 0) {
                    ForEach(days[start ..< min(start + 7, days.count)], id: \.self) { day in
                        // Each cell is its own link, so clicking 23 September
                        // opens the 23rd rather than whatever the widget as a
                        // whole points at.
                        if let destination = cache.dayDestination(day) {
                            Link(destination: destination) {
                                cell(day, inMonth: calendar.component(.month, from: day) == month)
                            }
                            .buttonStyle(.plain)
                        } else {
                            cell(day, inMonth: calendar.component(.month, from: day) == month)
                        }
                    }
                }
            }
        }
    }

    private func cell(_ day: Date, inMonth: Bool) -> some View {
        let isToday = calendar.isDate(day, inSameDayAs: now)
        let dots = cache.dots(on: day)

        return VStack(spacing: 1.5) {
            Text("\(calendar.component(.day, from: day))")
                .font(.system(size: numeralSize, weight: isToday ? .semibold : .regular))
                .foregroundStyle(isToday ? Color.white : (inMonth ? Color.primary : Color.secondary.opacity(0.5)))
                .frame(width: numeralSize * 1.9, height: numeralSize * 1.9)
                .background(
                    Circle()
                        .fill(isToday ? Metrics.accent : Color.clear)
                )

            // A clear dot on an empty day, so every row keeps the same height.
            HStack(spacing: 1.5) {
                if dots.isEmpty {
                    Circle().fill(Color.clear).frame(width: dotSize, height: dotSize)
                } else {
                    ForEach(Array(dots.enumerated()), id: \.offset) { _, colour in
                        Circle().fill(colour).frame(width: dotSize, height: dotSize)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Up next

public struct UpNextSmallView: View {
    public let cache: WidgetCache
    public let now: Date

    public init(cache: WidgetCache, now: Date) {
        self.cache = cache
        self.now = now
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetHeader()

            if let event = cache.nextEvent(from: now) {
                Spacer(minLength: 6)
                CountdownPill(event: event, now: now)
                Spacer(minLength: 6)

                VStack(alignment: .leading, spacing: 2) {
                    Text(event.title)
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(2)
                    Text(event.timeAndService)
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .padding(.leading, 10)
                .overlay(alignment: .leading) { AccentBar(colour: event.colour, inset: 1) }
                .fixedSize(horizontal: false, vertical: true)

                Spacer(minLength: 5)

                if let join = event.joinUrl, let url = URL(string: join) {
                    JoinButton(url: url)
                }
            } else {
                // Nothing to count down to, so the date becomes the subject
                // rather than leaving the tile empty.
                Spacer(minLength: 4)
                DateHero(now: now)
                Spacer(minLength: 4)

                let allDay = cache.allDayToday(from: now)
                if allDay.isEmpty {
                    Text(cache.isSilencedByFocus ? "Silenced by Focus" : "Nothing scheduled")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(allDay.prefix(2)) { event in
                        EventCard(event: event, titleSize: 11.5)
                    }
                }
            }
        }
    }
}

/// The date, large, for a widget with no meeting to show.
struct DateHero: View {
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: -2) {
            DayHeading(text: WidgetFormat.weekday(now))
            Text("\(Calendar.current.component(.day, from: now))")
                .font(.system(size: 34, weight: .semibold))
        }
    }
}

struct UpNextMediumView: View {
    let cache: WidgetCache
    let now: Date

    var body: some View {
        if let event = cache.nextEvent(from: now) {
            VStack(alignment: .leading, spacing: 8) {
                WidgetHeader(status: WidgetHeader.month(now))

                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        HeroEvent(event: event, now: now)
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Divider()

                    VStack(alignment: .leading, spacing: 5) {
                        DayHeading(text: String(localized: "LATER TODAY"))

                        // Two, as elsewhere at 155pt: a third card is drawn with
                        // its second line through the bottom edge.
                        let later = cache.upcoming(from: now).filter { $0.id != event.id }.prefix(2)
                        if later.isEmpty {
                            Text("Nothing else today")
                                .font(.system(size: 10.5))
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(Array(later)) { next in
                                EventCard(event: next, titleSize: 11.5)
                            }
                        }

                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                WidgetHeader(status: WidgetHeader.month(now))

                HStack(alignment: .top, spacing: 12) {
                    DateHero(now: now)

                    Divider()

                    VStack(alignment: .leading, spacing: 5) {
                        DayHeading(text: String(localized: "TODAY"))
                        let allDay = cache.allDayToday(from: now)
                        if allDay.isEmpty {
                            Text(cache.isSilencedByFocus ? "Silenced by Focus" : "Nothing scheduled")
                                .font(.system(size: 10.5))
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(allDay.prefix(2)) { event in
                                EventCard(event: event, titleSize: 11.5)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                Spacer(minLength: 0)
            }
        }
    }
}

// MARK: - Agenda

/// The day number in a left gutter, the day's events beside it.
///
/// A gutter rather than a full-width pinned header: a header costs a row of
/// height per day and takes the date out of the line the cards are read on.
public struct AgendaMediumView: View {
    public let cache: WidgetCache
    public let now: Date

    public init(cache: WidgetCache, now: Date) {
        self.cache = cache
        self.now = now
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            WidgetHeader(status: WidgetHeader.month(now))

            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 0) {
                    DayHeading(text: weekday)
                    Text("\(Calendar.current.component(.day, from: now))")
                        .font(.system(size: 30, weight: .semibold))
                }
                .frame(width: 58, alignment: .leading)

                VStack(alignment: .leading, spacing: 5) {
                    let days = cache.byDay(from: now)
                    if days.isEmpty {
                        EmptyState(
                            message: cache.isSilencedByFocus
                                ? String(localized: "Silenced by Focus")
                                : String(localized: "Nothing left today"),
                            icon: cache.isSilencedByFocus ? "moon.fill" : "calendar"
                        )
                    } else {
                        ForEach(Array(rows(days).enumerated()), id: \.offset) { _, row in
                            switch row {
                            case let .heading(text): DayHeading(text: text).padding(.top, 2)
                            case let .event(event): EventCard(event: event, titleSize: 11.5)
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }

                Spacer(minLength: 0)
            }
        }
    }

    private var weekday: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEEE"
        return formatter.string(from: now).uppercased()
    }

    /// Today's events, then tomorrow's under a heading once today runs out.
    ///
    /// Two cards, not three: at 155pt a third is drawn with its second line
    /// through the bottom edge, which reads as a rendering fault rather than as
    /// a list that continues. A day heading is cheap enough to keep alongside
    /// them, and it is the only thing that says the second card is not today's.
    private func rows(_ days: [(day: Date, events: [CachedEvent])]) -> [AgendaRow] {
        var rows: [AgendaRow] = []
        var shown = 0

        for (index, group) in days.enumerated() {
            guard shown < maxCards else { break }

            // The heading is only worth its row if a card follows it. One with
            // nothing under it says a day is coming and then shows none of it.
            let isToday = Calendar.current.isDate(group.day, inSameDayAs: now)
            var pending: AgendaRow? =
                index > 0 || !isToday
                    ? .heading(WidgetFormat.dayHeading(group.day, now: now))
                    : nil

            for event in group.events {
                if shown == maxCards {
                    break
                }
                if let heading = pending {
                    rows.append(heading)
                    pending = nil
                }
                rows.append(.event(event))
                shown += 1
            }
        }

        return rows
    }

    private var maxCards: Int {
        2
    }
}

enum AgendaRow {
    case heading(String)
    case event(CachedEvent)
}

struct AgendaLargeView: View {
    let cache: WidgetCache
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            WidgetHeader(status: WidgetHeader.month(now))

            let days = cache.byDay(from: now)
            if days.isEmpty {
                EmptyState(
                    message: cache.isSilencedByFocus
                        ? String(localized: "Silenced by Focus")
                        : String(localized: "Nothing in the next few days"),
                    icon: cache.isSilencedByFocus ? "moon.fill" : "calendar"
                )
            } else {
                ForEach(Array(days.prefix(3).enumerated()), id: \.offset) { _, group in
                    DayHeading(text: WidgetFormat.dayHeading(group.day, now: now))
                        .padding(.top, 2)
                    ForEach(group.events.prefix(3)) { event in
                        EventCard(event: event, showsService: true)
                    }
                }
            }

            Spacer(minLength: 0)
        }
    }
}

// MARK: - Month

struct MonthMediumView: View {
    let cache: WidgetCache
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            WidgetHeader(status: WidgetHeader.month(now))

            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    MiniMonthGrid(cache: cache, now: now, numeralSize: 8.5, rowSpacing: 0, dotSize: 2.4)
                    Spacer(minLength: 0)
                }

                Divider()

                VStack(alignment: .leading, spacing: 5) {
                    DayHeading(text: String(localized: "TODAY"))

                    let today = cache.todayEvents(from: now).prefix(2)
                    if today.isEmpty {
                        Text(cache.isSilencedByFocus ? "Silenced by Focus" : "Nothing left today")
                            .font(.system(size: 10.5))
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(today)) { event in
                            EventCard(event: event, titleSize: 11.5)
                        }
                    }

                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

public struct MonthLargeView: View {
    public let cache: WidgetCache
    public let now: Date

    public init(cache: WidgetCache, now: Date) {
        self.cache = cache
        self.now = now
    }

    /// Two, not three. The grid takes about half the tile, and a third card ran
    /// off the bottom edge rather than being dropped.
    private let shown = 2

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            WidgetHeader(status: WidgetHeader.month(now))

            MiniMonthGrid(cache: cache, now: now, numeralSize: 11, rowSpacing: 2, dotSize: 3.2)

            Divider()

            DayHeading(text: WidgetFormat.dayHeading(now, now: now))

            let today = cache.todayEvents(from: now).prefix(shown)
            if today.isEmpty {
                Text(cache.isSilencedByFocus ? "Silenced by Focus" : "Nothing left today")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(today)) { event in
                    EventCard(event: event, showsService: true)
                }
            }

            Spacer(minLength: 0)
        }
    }
}
