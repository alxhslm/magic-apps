import HelperUI
import SwiftUI

/// Prominent action button modifier matching Magical's tray prominent button style.
public struct TrayProminentButton: ViewModifier {
    public init() {}
    public func body(content: Content) -> some View {
        content
            .buttonStyle(.borderedProminent)
            .tint(.accentColor)
            .environment(\.controlActiveState, .active)
    }
}

/// A verification code card at the top of the popover, styled as a full-width band
/// matching Magical's hero card.
public struct HeroVerificationCodeCard: View {
    public let item: TrayVerificationCode
    public let accountColor: Color
    public let onSelectThread: (String, String) -> Void

    @State private var isHovering = false
    @State private var copied = false
    @State private var copyResetTask: Task<Void, Never>?

    public init(
        item: TrayVerificationCode,
        accountColor: Color,
        onSelectThread: @escaping (String, String) -> Void
    ) {
        self.item = item
        self.accountColor = accountColor
        self.onSelectThread = onSelectThread
    }

    public var body: some View {
        Button(action: { onSelectThread(item.accountId, item.threadId) }) {
            VStack(alignment: .leading, spacing: 3) {
                // Eyebrow: service name, relative arrival time
                HStack(spacing: 5) {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(Color.accentColor)
                            .frame(width: 6, height: 6)

                        Text("Verification Code")
                            .font(.system(size: 10.5, weight: .bold))
                            .foregroundStyle(Color.accentColor)
                            .tracking(0.4)
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2.5)
                    .background(Color.accentColor.opacity(0.15))
                    .clipShape(Capsule())

                    Text(verbatim: "·")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)

                    Text(eyebrowServiceName)
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)

                    Text(verbatim: "·")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)

                    Text(relativeTimeText)
                        .font(.system(size: 10.5, design: .rounded))
                        .foregroundStyle(.secondary)

                    Spacer(minLength: 4)
                }

                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.code)
                            .font(.system(size: 16, weight: .bold, design: .monospaced))
                            .foregroundStyle(.primary)

                        if !item.subject.isEmpty {
                            Text(item.subject)
                                .font(.system(size: 11.5))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }

                    Spacer(minLength: 8)

                    Button(action: copyToClipboard) {
                        Label(
                            copied ? String(localized: "Copied") : String(localized: "Copy"),
                            systemImage: copied ? "checkmark" : "doc.on.doc.fill"
                        )
                    }
                    .modifier(TrayProminentButton())
                    .controlSize(.regular)
                }
            }
            .padding(.leading, 14)
            .padding(.trailing, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .leading) {
                Capsule()
                    .fill(accountColor)
                    .frame(width: 3.5)
                    .padding(.leading, 6)
                    .padding(.vertical, 4)
            }
            .contentShape(Rectangle())
            .background(Color.primary.opacity(isHovering ? 0.05 : 0))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
    }

    private var eyebrowServiceName: String {
        if let service = item.service, !service.isEmpty {
            return service
        }
        if !item.from.isEmpty {
            return item.from
        }
        return String(localized: "Email")
    }

    private var relativeTimeText: String {
        let elapsed = Int(max(0, Date().timeIntervalSince(item.receivedAt)))
        let minutes = elapsed / 60
        if minutes < 1 {
            return String(localized: "Just now")
        }
        if minutes == 1 {
            return String(localized: "1m ago")
        }
        if minutes < 60 {
            return String(localized: "\(minutes)m ago")
        }
        let hours = minutes / 60
        return String(localized: "\(hours)h ago")
    }

    private func copyToClipboard() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(item.code, forType: .string)

        withAnimation(.easeInOut(duration: 0.15)) {
            copied = true
        }

        copyResetTask?.cancel()
        copyResetTask = Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                withAnimation(.easeInOut(duration: 0.2)) {
                    copied = false
                }
            }
        }
    }
}
