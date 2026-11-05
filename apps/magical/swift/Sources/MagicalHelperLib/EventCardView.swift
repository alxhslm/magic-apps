import HelperUI
import SwiftUI

/// The glyph that says what a card is: birthday, focus time, task, working location.
///
/// Every card density draws it from here. The densities differ, but the atom does not:
/// when the glyph lived in one of them only, a task lost its tick depending on which
/// surface happened to draw it.
struct EventKindBadge: View {
    let event: TrayEvent
    var size: CGFloat = 10.5

    var body: some View {
        if let kind = event.kindGlyph {
            Image(systemName: kind.symbol)
                .font(.system(size: size))
                .foregroundStyle(.secondary)
                .accessibilityLabel(kind.label)
        }
    }
}

/// How much room a card has, not what kind of card it is.
///
/// The event, its colour, its glyph, its completion state and its context menu are the
/// same everywhere. Only the arrangement changes: the half-width column beside a
/// concurrent event, the fixed-height block in the day grid, and the one-line all-day row
/// that must not eat the timeline.
public enum EventCardStyle: Sendable {
    /// A full-width agenda row: title, then time, calendar and location.
    case agenda
    /// One of two concurrent events, in roughly half the width.
    case compact
    /// A block in the day or week time grid, whose height follows its duration.
    case grid
    /// A single 20pt line above the grid, for an all-day event.
    case allDay
}

/// One event in any surface that draws it.
///
/// The leading accent bar is the only thing on the card that carries the calendar's colour
/// (`docs/shared/design.md#account-colour-language-across-surfaces`). The card's own surface
/// and border are neutral, so a column of cards from six calendars reads as one list rather
/// than six washes of colour.
public struct EventCardView: View {
    public let event: TrayEvent
    public let style: EventCardStyle
    public let date: Date?
    public let height: CGFloat
    public let onSelect: () -> Void
    public let onJoinCall: ((String, String) -> Void)?
    public let onRsvp: ((String) -> Void)?
    public let onDelete: ((TrayEvent) -> Void)?
    public let onComplete: ((TrayEvent, Bool) -> Void)?

    @State private var isHovering = false

    public init(
        event: TrayEvent,
        onSelect: @escaping () -> Void,
        onJoinCall: ((String, String) -> Void)? = nil,
        onRsvp: ((String) -> Void)? = nil,
        onDelete: ((TrayEvent) -> Void)? = nil,
        onComplete: ((TrayEvent, Bool) -> Void)? = nil,
        style: EventCardStyle = .agenda,
        date: Date? = nil,
        height: CGFloat = .infinity
    ) {
        self.event = event
        self.onSelect = onSelect
        self.onJoinCall = onJoinCall
        self.onRsvp = onRsvp
        self.onDelete = onDelete
        self.onComplete = onComplete
        self.style = style
        self.date = date
        self.height = height
    }

    public var body: some View {
        Button(action: onSelect) {
            if style == .allDay {
                allDayLine
            } else {
                stackedCard
            }
        }
        .buttonStyle(.plain)
        .opacity(event.isCompleted ? 0.6 : 1.0)
        .onHover { isHovering = $0 }
        .eventContextMenu(
            event: event,
            onSelect: onSelect,
            onJoinCall: onJoinCall,
            onRsvp: onRsvp,
            onDelete: onDelete,
            onComplete: onComplete
        )
    }

    // MARK: - Stacked cards

    private var stackedCard: some View {
        HStack(alignment: .top, spacing: stackSpacing) {
            Capsule()
                .fill(Color(hex: event.colorHex))
                .frame(width: barWidth)
                .padding(.vertical, barInset)

            VStack(alignment: .leading, spacing: contentSpacing) {
                if style == .agenda {
                    titleRow
                } else {
                    timeRow
                }

                if style == .agenda {
                    metaRow
                } else {
                    title
                    if showsCalendar {
                        calendarLine
                    }
                }
            }
            .padding(.trailing, trailingInset)
        }
        .padding(.leading, leadingInset)
        .padding(.vertical, verticalInset)
        .frame(
            maxWidth: .infinity,
            maxHeight: style == .grid ? .infinity : nil,
            alignment: .topLeading
        )
        .background(cardSurface)
        .overlay(cardBorder)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
    }

    /// The full agenda row: what the event is, outstanding on it, and where to join it.
    private var titleRow: some View {
        HStack(alignment: .center, spacing: 6) {
            EventKindBadge(event: event)

            Text(event.summary)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(event.isCompleted ? .secondary : .primary)
                .lineLimit(1)

            // The outline says a reply is outstanding; this says it again in a shape, for
            // anyone who cannot tell the two surfaces apart.
            if event.needsRsvp {
                Image(systemName: "questionmark.circle")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Awaiting your reply")
            } else if event.isTentative {
                Text("Maybe")
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(.tertiary)
            }

            Spacer(minLength: 4)

            // A monochrome SF Symbol, not the service's own mark. A row this dense has one
            // thing the eye should land on, the title, and a brand logo in full colour
            // outranks it.
            if let service = event.conferenceServiceName, event.conferenceUrl != nil {
                HStack(spacing: 3) {
                    Image(systemName: "video.fill")
                        .font(.system(size: 10))
                    Text(service)
                        .font(.system(size: 10))
                }
                .foregroundStyle(.secondary)
            }
        }
    }

    /// The narrow column: the time needs its own line, or the title has nowhere to go.
    private var timeRow: some View {
        HStack(spacing: 3) {
            if style != .grid || height > 30 {
                EventKindBadge(event: event, size: glyphSize)
            }

            Text(timeText)
                .font(.system(size: timeSize, design: .rounded).monospacedDigit())
                .foregroundStyle(.secondary)
                .lineLimit(1)

            Spacer(minLength: 2)

            if event.conferenceUrl != nil {
                Image(systemName: "video.fill")
                    .font(.system(size: style == .grid ? 8 : 8.5))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var title: some View {
        Text(event.summary)
            .font(.system(size: titleSize, weight: .semibold))
            .foregroundStyle(event.isCompleted ? .secondary : .primary)
            .lineLimit(titleLineLimit)
            .fixedSize(horizontal: false, vertical: style == .compact)
    }

    @ViewBuilder
    private var calendarLine: some View {
        if let name = event.calendarName, !name.isEmpty {
            Text(name)
                .font(.system(size: calendarSize))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
    }

    /// The full agenda row's second line: when it runs, on which calendar, and where.
    private var metaRow: some View {
        HStack(spacing: 6) {
            // When a meeting starts and ends is the one thing on this line that cannot be
            // guessed from the rest of it, so it never truncates; the organiser and the
            // location give way instead.
            Text(timeText)
                .font(.system(size: 11, design: .rounded).monospacedDigit())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: true, vertical: false)
                .layoutPriority(1)

            if let name = event.calendarName, !name.isEmpty {
                Text(verbatim: "·")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                Text(name)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }

            if let loc = event.location, !loc.isEmpty {
                Text(verbatim: "·")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                Text(loc)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            // Laid out on every row that has a call, and only revealed under the pointer.
            // A mini prominent button is taller than the meta text beside it, so a button
            // that came and went with the hover would grow the row and shuffle the list
            // under the pointer that summoned it. Opacity keeps it reachable by keyboard
            // and VoiceOver, neither of which can hover.
            if let url = event.conferenceUrl, let onJoinCall {
                Button("Join") { onJoinCall(url, event.accountId) }
                    .modifier(TrayProminentButton())
                    .controlSize(.mini)
                    .font(.system(size: 10, weight: .semibold))
                    .opacity(isHovering ? 1 : 0)
            }
        }
    }

    // MARK: - All-day row

    private var allDayLine: some View {
        HStack(spacing: 5) {
            Capsule()
                .fill(Color(hex: event.colorHex))
                .frame(width: 3, height: 12)

            EventKindBadge(event: event, size: 9.5)

            Text(event.summary)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(event.isCompleted ? .secondary : .primary)
                .lineLimit(1)

            Spacer(minLength: 4)

            if let calName = event.calendarName, !calName.isEmpty {
                Text(calName)
                    .font(.system(size: 8.5))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }

            Text("All day")
                .font(.system(size: 8, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .background(
                    Capsule()
                        .fill(Color.primary.opacity(0.06))
                )
        }
        .padding(.leading, 6)
        .padding(.trailing, 6)
        .frame(height: 20)
        .background(cardSurface)
        .overlay(cardBorder)
    }

    // MARK: - Shared measurements

    private var timeText: String {
        if let date {
            event.formattedTime(on: date)
        } else {
            event.formattedTime
        }
    }

    private var glyphSize: CGFloat {
        switch style {
        case .agenda: 10.5
        case .compact: 9
        case .grid: 8.5
        case .allDay: 9.5
        }
    }

    private var titleSize: CGFloat {
        switch style {
        case .agenda: 12
        case .compact: 11
        case .grid: height > 40 ? 10.5 : 9.5
        case .allDay: 10.5
        }
    }

    private var timeSize: CGFloat {
        style == .grid ? 8.5 : 9.5
    }

    private var calendarSize: CGFloat {
        style == .grid ? 8.5 : 9
    }

    private var titleLineLimit: Int {
        switch style {
        case .agenda, .allDay: 1
        case .compact: 2
        case .grid: height > 40 ? 2 : 1
        }
    }

    private var showsCalendar: Bool {
        switch style {
        case .agenda: true
        case .compact: true
        case .grid: height >= 46
        case .allDay: true
        }
    }

    private var barWidth: CGFloat {
        style == .agenda ? 3.5 : 3
    }

    private var barInset: CGFloat {
        style == .agenda ? 2 : (style == .grid ? 3 : 2)
    }

    private var stackSpacing: CGFloat {
        style == .agenda ? 8 : (style == .grid ? 4 : 5)
    }

    private var contentSpacing: CGFloat {
        style == .agenda ? 3 : (style == .grid ? 1 : 2)
    }

    private var leadingInset: CGFloat {
        style == .agenda ? 6 : (style == .grid ? 4 : 5)
    }

    private var trailingInset: CGFloat {
        style == .agenda ? 8 : (style == .grid ? 3 : 4)
    }

    private var verticalInset: CGFloat {
        style == .agenda ? 7 : (style == .grid ? 3 : 5)
    }

    private var cornerRadius: CGFloat {
        switch style {
        case .agenda: 8
        case .compact: 7
        case .grid: 6
        case .allDay: 5
        }
    }

    private var cardSurface: some View {
        ZStack {
            // Opaque enough that desktop vibrancy does not read through the title
            // (`docs/shared/design.md#solid--opaque-boundaries`).
            RoundedRectangle(cornerRadius: cornerRadius)
                .fill(Color(nsColor: .controlBackgroundColor).opacity(style == .grid ? 0.88 : 0.85))
            RoundedRectangle(cornerRadius: cornerRadius)
                .fill(surfaceTint)
        }
    }

    private var surfaceTint: Color {
        switch style {
        case .allDay:
            Color(hex: event.colorHex).opacity(isHovering ? 0.22 : 0.14)
        case .agenda:
            Color.primary.opacity(surfaceOpacity)
        case .compact:
            Color.primary.opacity(isHovering ? 0.08 : 0.04)
        case .grid:
            Color.primary.opacity(isHovering ? 0.08 : 0.04)
        }
    }

    @ViewBuilder
    private var cardBorder: some View {
        if style == .allDay {
            RoundedRectangle(cornerRadius: cornerRadius)
                .strokeBorder(
                    Color(hex: event.colorHex).opacity(isHovering ? 0.45 : 0.28),
                    lineWidth: 0.5
                )
        } else {
            RoundedRectangle(cornerRadius: cornerRadius)
                .strokeBorder(Color.primary.opacity(borderOpacity), style: borderStyle)
        }
    }

    /// An invitation nobody has answered loses its surface tint, so it reads as an outline
    /// against the filled cards around it; the tint returns, at half strength, once the
    /// answer is maybe.
    private var surfaceOpacity: Double {
        if event.needsRsvp {
            return isHovering ? 0.04 : 0
        }
        if event.isTentative {
            return isHovering ? 0.07 : 0.03
        }
        return isHovering ? 0.10 : 0.05
    }

    /// The border is what carries an outlined card, so it is drawn harder than on a filled one.
    private var borderOpacity: Double {
        if style == .compact || style == .grid {
            return isHovering ? 0.2 : 0.1
        }
        if event.needsRsvp || event.isTentative {
            return isHovering ? 0.28 : 0.18
        }
        return isHovering ? 0.12 : 0.06
    }

    private var borderStyle: StrokeStyle {
        let width: CGFloat = style == .agenda ? 1 : 0.75
        return event.isTentative
            ? StrokeStyle(lineWidth: width, dash: [3, 2])
            : StrokeStyle(lineWidth: width)
    }
}
