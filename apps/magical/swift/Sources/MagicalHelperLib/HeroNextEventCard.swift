import SwiftUI

/// The meeting that is running or about to, at the top of the popover.
///
/// Drawn as a full-width header band on the popover's own material, not as a card. It was a card
/// once, with the same rounded rectangle, neutral fill, hairline border and leading accent bar as
/// an agenda row, and a title half a point larger; it read as a large agenda row rather than as
/// something of a different kind. A band above the divider is a different sort of object from an
/// inset card below it, so the two cannot be confused whatever the type does.
public struct HeroNextEventCard: View {
    public let event: TrayEvent
    public let minutesUntil: Int
    public let calendarColor: Color
    public let onJoinCall: (String) -> Void
    public let onSelectEvent: (TrayEvent) -> Void
    public let onRsvp: ((String) -> Void)?
    public let onDeleteEvent: ((TrayEvent) -> Void)?
    public let onCompleteTask: ((TrayEvent, Bool) -> Void)?

    @State private var isHovering = false

    public init(
        event: TrayEvent,
        minutesUntil: Int,
        calendarColor: Color,
        onJoinCall: @escaping (String) -> Void,
        onSelectEvent: @escaping (TrayEvent) -> Void,
        onRsvp: ((String) -> Void)? = nil,
        onDeleteEvent: ((TrayEvent) -> Void)? = nil,
        onCompleteTask: ((TrayEvent, Bool) -> Void)? = nil
    ) {
        self.event = event
        self.minutesUntil = minutesUntil
        self.calendarColor = calendarColor
        self.onJoinCall = onJoinCall
        self.onSelectEvent = onSelectEvent
        self.onRsvp = onRsvp
        self.onDeleteEvent = onDeleteEvent
        self.onCompleteTask = onCompleteTask
    }

    public var body: some View {
        Button(action: { onSelectEvent(event) }) {
            VStack(alignment: .leading, spacing: 3) {
                // Eyebrow: everything contextual on one line, so the band is two rows rather
                // than four. Whose calendar, how long there is, when, and on what.
                HStack(spacing: 5) {
                    // One pill, one colour. The dot and the countdown say the same thing, so a
                    // dot in the calendar's colour beside green text read as two signals.
                    HStack(spacing: 4) {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 6, height: 6)

                        Text(countdownText)
                            .font(.system(size: 10.5, weight: .bold))
                            .foregroundStyle(statusColor)
                            .tracking(0.4)
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2.5)
                    .background(statusColor.opacity(0.15))
                    .clipShape(Capsule())

                    Text(verbatim: "·")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)

                    Text(event.formattedTime)
                        .font(.system(size: 10.5, design: .rounded).monospacedDigit())
                        .foregroundStyle(.secondary)

                    if let service = event.conferenceServiceName, event.conferenceUrl != nil {
                        Text(verbatim: "·")
                            .font(.system(size: 10))
                            .foregroundStyle(.tertiary)
                        Text(service)
                            .font(.system(size: 10.5))
                            .foregroundStyle(.secondary)
                    }

                    // The band stands alone, with no filled card beside it to read an outline
                    // against, so it says where the invitation stands in words.
                    if event.needsRsvp {
                        rsvpChip("Reply needed")
                    } else if event.isTentative {
                        rsvpChip("Maybe")
                    }

                    Spacer(minLength: 4)
                }

                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    // The largest text in the popover; every agenda title is 12pt.
                    Text(event.summary)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Spacer(minLength: 8)

                    // A verb, carrying `video.fill`. The service is named in the line above,
                    // where the agenda rows name theirs, so the button does not repeat it.
                    if let url = event.conferenceUrl, !url.isEmpty {
                        Button(action: { onJoinCall(url) }) {
                            Label("Join", systemImage: "video.fill")
                        }
                        .modifier(TrayProminentButton())
                        // Regular, not small. This is the one action in the popover that is
                        // worth interrupting someone for, and a small control does not read
                        // that way next to a 14pt title.
                        .controlSize(.regular)
                    }
                }
            }
            .padding(.leading, 14)
            .padding(.trailing, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            // The calendar's colour, as the same inset capsule the agenda cards carry. Flush to
            // the window it ran into the popover's own rounded corner. It stays an overlay, so
            // it takes the band's height without a greedy shape claiming the layout.
            .overlay(alignment: .leading) {
                Capsule()
                    .fill(calendarColor)
                    .frame(width: 3.5)
                    .padding(.leading, 6)
                    .padding(.vertical, 4)
            }
            .contentShape(Rectangle())
            .background(Color.primary.opacity(isHovering ? 0.05 : 0))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .eventContextMenu(
            event: event,
            onSelect: { onSelectEvent(event) },
            onJoinCall: onJoinCall,
            onRsvp: onRsvp,
            onDelete: onDeleteEvent,
            onComplete: onCompleteTask
        )
    }

    private func rsvpChip(_ text: LocalizedStringKey) -> some View {
        Text(text)
            .font(.system(size: 9.5, weight: .semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .overlay(
                Capsule()
                    .strokeBorder(Color.secondary.opacity(0.45), lineWidth: 1)
            )
    }

    /// Green only while it is actually running. A meeting three hours out in the same green reads
    /// as something to drop what you are doing for.
    private var statusColor: Color {
        minutesUntil <= 0 ? .green : .secondary
    }

    private var countdownText: String {
        TrayCountdown.label(minutes: minutesUntil)
    }
}
