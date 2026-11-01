import HelperUI
import SwiftUI

/// Compact event tile for side-by-side presentation of overlapping/concurrent events.
public struct CompactEventTileView: View {
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
            HStack(spacing: 5) {
                Capsule()
                    .fill(Color(hex: event.colorHex))
                    .frame(width: 3)
                    .padding(.vertical, 2)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 3) {
                        Text(event.formattedTime)
                            .font(.system(size: 9.5, design: .rounded).monospacedDigit())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)

                        Spacer(minLength: 2)

                        if event.conferenceUrl != nil {
                            Image(systemName: "video.fill")
                                .font(.system(size: 8.5))
                                .foregroundStyle(.secondary)
                        }
                    }

                    Text(event.summary)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(event.isCompleted ? .secondary : .primary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)

                    if let calName = event.calendarName, !calName.isEmpty {
                        Text(calName)
                            .font(.system(size: 9))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                .padding(.trailing, 4)
            }
            .padding(.leading, 5)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                ZStack {
                    RoundedRectangle(cornerRadius: 7)
                        .fill(Color(nsColor: .controlBackgroundColor).opacity(0.85))
                    RoundedRectangle(cornerRadius: 7)
                        .fill(Color.primary.opacity(isHovering ? 0.08 : 0.04))
                }
            )
            .overlay(
                RoundedRectangle(cornerRadius: 7)
                    .strokeBorder(Color.primary.opacity(isHovering ? 0.2 : 0.1), lineWidth: 0.75)
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
}
