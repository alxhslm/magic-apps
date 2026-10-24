import HelperUI
import SwiftUI

/// One event in the agenda.
///
/// The leading accent bar is the only thing on the card that carries the calendar's colour
/// (`docs/shared/design.md#account-colour-language-across-surfaces`). The card's own surface and border are neutral, so a
/// column of cards from six calendars reads as one list rather than six washes of colour.
public struct EventCardView: View {
    public let event: TrayEvent
    public let onSelect: () -> Void
    public let onJoinCall: ((String) -> Void)?
    public let onRsvp: ((String) -> Void)?
    public let onDelete: ((TrayEvent) -> Void)?
    public let onComplete: ((TrayEvent, Bool) -> Void)?

    @State private var isHovering = false

    public init(
        event: TrayEvent,
        onSelect: @escaping () -> Void,
        onJoinCall: ((String) -> Void)? = nil,
        onRsvp: ((String) -> Void)? = nil,
        onDelete: ((TrayEvent) -> Void)? = nil,
        onComplete: ((TrayEvent, Bool) -> Void)? = nil
    ) {
        self.event = event
        self.onSelect = onSelect
        self.onJoinCall = onJoinCall
        self.onRsvp = onRsvp
        self.onDelete = onDelete
        self.onComplete = onComplete
    }

    public var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 8) {
                Capsule()
                    .fill(Color(hex: event.colorHex))
                    .frame(width: 3.5)
                    .padding(.vertical, 2)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .center, spacing: 6) {
                        // Says what the entry is, where the badges after the title say
                        // what is outstanding on it.
                        if let kind = event.kindGlyph {
                            Image(systemName: kind.symbol)
                                .font(.system(size: 10.5))
                                .foregroundStyle(.secondary)
                                .accessibilityLabel(kind.label)
                        }

                        Text(event.summary)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(event.isCompleted ? .secondary : .primary)
                            .lineLimit(1)

                        // The outline says a reply is outstanding; this says it again in a
                        // shape, for anyone who cannot tell the two surfaces apart.
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

                        // A monochrome SF Symbol, not the service's own mark. A row this
                        // dense has one thing the eye should land on, the title, and a
                        // brand logo in full colour outranks it.
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

                    HStack(spacing: 6) {
                        // When a meeting starts and ends is the one thing on this line that
                        // cannot be guessed from the rest of it, so it never truncates; the
                        // organiser and the location give way instead.
                        Text(event.formattedTime)
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

                        // Laid out on every row that has a call, and only revealed under
                        // the pointer. A mini prominent button is taller than the meta text
                        // beside it, so a button that came and went with the hover would
                        // grow the row and shuffle the list under the pointer that summoned
                        // it. Opacity keeps it reachable by keyboard and VoiceOver, neither
                        // of which can hover.
                        if let url = event.conferenceUrl, let onJoinCall {
                            Button("Join") { onJoinCall(url) }
                                .modifier(TrayProminentButton())
                                .controlSize(.mini)
                                .font(.system(size: 10, weight: .semibold))
                                .opacity(isHovering ? 1 : 0)
                        }
                    }
                }
                .padding(.trailing, 8)
            }
            .padding(.leading, 6)
            .padding(.vertical, 7)
            .background(
                ZStack {
                    // Opaque enough that desktop vibrancy does not read through the title
                    // (`docs/shared/design.md#solid--opaque-boundaries`).
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color(nsColor: .controlBackgroundColor).opacity(0.85))
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color.primary.opacity(surfaceOpacity))
                }
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(Color.primary.opacity(borderOpacity), style: borderStyle)
            )
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

    /// An invitation nobody has answered loses its surface tint, so it reads as an outline against
    /// the filled cards around it; the tint returns, at half strength, once the answer is maybe.
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
        if event.needsRsvp || event.isTentative {
            return isHovering ? 0.28 : 0.18
        }
        return isHovering ? 0.12 : 0.06
    }

    private var borderStyle: StrokeStyle {
        event.isTentative ? StrokeStyle(lineWidth: 1, dash: [3, 2]) : StrokeStyle(lineWidth: 1)
    }
}
