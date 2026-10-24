import AppKit
import SwiftUI

/// A single editable account.
///
/// The name is held locally rather than bound straight into the model. Writing
/// each keystroke into the account list republishes it, which rebuilds the row
/// and drops keyboard focus — so the field could not be typed into at all. It
/// commits on Return and when focus leaves instead.
public struct AccountRow: View {
    public let name: String
    public let color: String
    public let needsAuth: Bool
    public let onCommit: (String, String) -> Void
    public let onSignIn: () -> Void
    public let onRemove: () -> Void

    @State private var draftName: String
    @State private var draftColor: Color
    @FocusState private var editing: Bool

    public init(
        name: String,
        color: String,
        needsAuth: Bool = false,
        onCommit: @escaping (String, String) -> Void,
        onSignIn: @escaping () -> Void = {},
        onRemove: @escaping () -> Void = {}
    ) {
        self.name = name
        self.color = color
        self.needsAuth = needsAuth
        self.onCommit = onCommit
        self.onSignIn = onSignIn
        self.onRemove = onRemove
        _draftName = State(initialValue: name)
        _draftColor = State(initialValue: Color(hex: color))
    }

    public var body: some View {
        HStack(spacing: 8) {
            ColorPicker("", selection: $draftColor, supportsOpacity: false)
                .labelsHidden()
                .frame(width: 44)

            TextField("Account name", text: $draftName)
                .textFieldStyle(.plain)
                .focused($editing)
                .onSubmit { commit() }

            // Settings is where an account is added, so it is where the user comes back
            // to when one stops working. Without this the row offers nothing but a
            // colour swatch for an account that cannot read anything.
            if needsAuth {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .font(.system(size: 11))

                    Button("Sign In", action: onSignIn)
                        .buttonStyle(.borderedProminent)
                        .controlSize(.mini)
                }
                .help("Sign in required")
            }
        }
        .padding(.vertical, 2)
        .onChange(of: draftColor) { _, _ in commit() }
        .onChange(of: name) { _, updated in
            // The main process replaces the list on any account change, so a
            // rename made elsewhere should land here — but not over the top of
            // what is being typed.
            if !editing {
                draftName = updated
            }
        }
        .onChange(of: editing) { _, isEditing in
            // Commit on focus loss too, so a rename is not lost by clicking
            // away rather than pressing Return.
            if !isEditing {
                commit()
            }
        }
        .contextMenu {
            Button("Remove Account", action: onRemove)
        }
    }

    private func commit() {
        let trimmed = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
        // An empty name would leave an unidentifiable row in the switcher, so the
        // previous one stands.
        guard !trimmed.isEmpty else {
            draftName = name
            return
        }

        let hex = NSColor(draftColor).hexString
        guard trimmed != name || hex != color else { return }
        onCommit(trimmed, hex)
    }
}
