import HelperUI
import SwiftUI

/// Compact full-width banner for an all-day event in schedule and day views.
public struct AllDayBannerView: View {
    public let event: TrayEvent
    public let onSelect: () -> Void
    public let onDelete: ((TrayEvent) -> Void)?
    public let onComplete: ((TrayEvent, Bool) -> Void)?

    @State private var isHovering = false

    public init(
        event: TrayEvent,
        onSelect: @escaping () -> Void,
        onDelete: ((TrayEvent) -> Void)? = nil,
        onComplete: ((TrayEvent, Bool) -> Void)? = nil
    ) {
        self.event = event
        self.onSelect = onSelect
        self.onDelete = onDelete
        self.onComplete = onComplete
    }

    public var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 6) {
                Capsule()
                    .fill(Color(hex: event.colorHex))
                    .frame(width: 3.5, height: 14)

                Text(event.summary)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Spacer(minLength: 4)

                if let calName = event.calendarName, !calName.isEmpty {
                    Text(calName)
                        .font(.system(size: 9.5))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }

                Text("All day")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(
                        Capsule()
                            .fill(Color.primary.opacity(0.06))
                    )
            }
            .padding(.leading, 6)
            .padding(.trailing, 8)
            .padding(.vertical, 4)
            .frame(height: 26)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color(hex: event.colorHex).opacity(isHovering ? 0.22 : 0.14))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(Color(hex: event.colorHex).opacity(isHovering ? 0.45 : 0.28), lineWidth: 0.75)
            )
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .eventContextMenu(
            event: event,
            onSelect: onSelect,
            onJoinCall: nil,
            onRsvp: nil,
            onDelete: onDelete,
            onComplete: onComplete
        )
    }
}
