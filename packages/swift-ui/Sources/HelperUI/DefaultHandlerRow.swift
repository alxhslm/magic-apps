import AppKit
import SwiftUI

/// One file type or scheme a helper can claim, and the button that claims it.
///
/// A button rather than a switch, because macOS offers no way to stop being a
/// handler — the only way back is to name another app, which is the user's to do
/// in System Settings. Once the app holds the type the row is plain text, so
/// nothing offers an off position that could not work.
///
/// The app's own settings model describes a row in its own terms (`isMagimail`,
/// `isMagical`, a `Target` enum or a raw string). This is the neutral shape they
/// both map onto; `appName` is what makes the two sentences and the button title
/// read as Magimail's or Magical's.
public struct DefaultHandlerRow: View {
    public struct Item: Identifiable {
        public let id: String
        /// What the type is called in the user's language of files, e.g. "Email links".
        public let label: String
        /// The app that opens this type today, by its display name.
        public let handler: String
        /// Whether the app this window belongs to already holds the type.
        public let isClaimed: Bool

        public init(id: String, label: String, handler: String, isClaimed: Bool) {
            self.id = id
            self.label = label
            self.handler = handler
            self.isClaimed = isClaimed
        }
    }

    public let item: Item
    /// The app this window belongs to, as it is shown in the button and subtitle.
    public let appName: String
    /// False outside an app bundle, as under `pnpm dev`, where there is nothing to register.
    public let canClaim: Bool
    public let claim: () -> Void

    public init(item: Item, appName: String, canClaim: Bool, claim: @escaping () -> Void) {
        self.item = item
        self.appName = appName
        self.canClaim = canClaim
        self.claim = claim
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.label)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if !item.isClaimed, canClaim {
                Button("Use \(appName)", action: claim)
            }
        }
    }

    /// Both states are the same sentence with a different app in it, so the row reads as one
    /// fact that changes rather than as two different messages.
    private var subtitle: String {
        if !canClaim {
            return String(localized: "Only the installed app can be the default reader")
        }
        if item.isClaimed {
            return String(localized: "\(appName) is the default reader")
        }
        return item.handler.isEmpty
            ? String(localized: "No default reader")
            : String(localized: "\(item.handler) is the default reader")
    }
}
