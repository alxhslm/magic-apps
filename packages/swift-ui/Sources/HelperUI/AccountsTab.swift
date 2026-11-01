import AppKit
import HelperRPC
import SwiftUI

/// The part of a helper's settings model the account list editor reads.
///
/// The two apps' models carry a great deal that is not shared — mail categories,
/// meeting alerts, calendars — but the account list is one problem. Both hold
/// the main process's `{ id, name, color, needsAuth }` rows and both speak the
/// same `account.add` / `account.update` / `account.remove` / `account.reorder` /
/// `account.signIn` events, so this two-member protocol is all the editor needs
/// to stay out of either app's model.
///
/// An app that grows a genuinely different account list can drop this and write
/// its own `AccountsTab`; the window takes an opaque view per tab, so nothing
/// else has to change.
@MainActor
public protocol AccountListModel: ObservableObject {
    var accounts: [[String: Any]] { get set }
    var browserProfiles: [String: [[String: String]]] { get set }
    var transport: StdioTransport? { get }
}

/// Accounts are edited in place: click a row's swatch to recolour it, its name
/// to rename it, drag to reorder, and right-click or press Delete to remove.
///
/// This replaces a separate compose row of preset swatches, a name field and an
/// Add button, which meant a colour could only be set at creation and only from
/// eight fixed choices. `account.update` already existed in the main process for
/// exactly this and was never wired up.
public struct AccountsTab<Model: AccountListModel>: View {
    @ObservedObject private var model: Model
    /// Starting colours for new accounts, taken in turn so two do not arrive the
    /// same. Only a starting point — any colour can be chosen afterwards.
    private let startingColors: [String]

    @State private var selectedAccountId: String?

    public init(model: Model, startingColors: [String]) {
        _model = ObservedObject(wrappedValue: model)
        self.startingColors = startingColors
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            List(selection: $selectedAccountId) {
                // Keyed by account id, not by index: the main process replaces
                // this list whenever an account is added or removed, and an
                // index-keyed row would keep the previous occupant's in-progress
                // name once the rows below a deletion shifted up.
                ForEach(accountIds, id: \.self) { id in
                    AccountRow(
                        name: value(of: id, "name") ?? "",
                        color: value(of: id, "color") ?? startingColors[0],
                        needsAuth: boolValue(of: id, "needsAuth"),
                        onCommit: { name, color in update(id: id, name: name, color: color) },
                        onSignIn: { signIn(id: id) },
                        onRemove: { remove(id: id) }
                    )
                    .tag(id)
                }
                .onMove(perform: move)
            }
            .listStyle(.bordered)
            .frame(minHeight: 160)
            .onDeleteCommand(perform: removeSelected)

            HStack(spacing: 6) {
                Button(action: addAccount) {
                    Image(systemName: "plus")
                }
                .help("Add an account")

                Button(action: removeSelected) {
                    Image(systemName: "minus")
                }
                .disabled(selectedAccountId == nil || model.accounts.count <= 1)
                .help("Remove the selected account")

                Button("Reset Session…", action: resetSelectedSession)
                    .disabled(selectedAccountId == nil)
                    .help("Sign the selected account out of Google")

                Spacer()

                Text("Drag to reorder")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .padding(.top, 6)

            if let selectedId = selectedAccountId {
                Divider()
                    .padding(.vertical, 8)

                VStack(alignment: .leading, spacing: 6) {
                    Text("External & Meeting Links")
                        .font(.headline)

                    Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 6) {
                        GridRow {
                            Text("Browser:")
                                .gridColumnAlignment(.trailing)
                                .foregroundStyle(.secondary)
                            Picker("", selection: browserBinding(for: selectedId)) {
                                Text("System Default").tag("system")
                                Text("Google Chrome").tag("chrome")
                                Text("Brave Browser").tag("brave")
                                Text("Microsoft Edge").tag("edge")
                                Text("Safari").tag("safari")
                            }
                            .labelsHidden()
                            .frame(maxWidth: 180)
                        }

                        if isChromium(selectedId) {
                            GridRow {
                                Text("Profile:")
                                    .gridColumnAlignment(.trailing)
                                    .foregroundStyle(.secondary)
                                Picker("", selection: profileBinding(for: selectedId)) {
                                    Text("Automatic (Match Email)").tag("_auto")
                                    let profiles = profilesForBrowser(browser(for: selectedId))
                                    ForEach(profiles, id: \.self) { prof in
                                        let dir = prof["directory"] ?? ""
                                        let label = formatProfileLabel(prof)
                                        Text(label).tag(dir)
                                    }
                                }
                                .labelsHidden()
                                .frame(maxWidth: 240)
                            }
                        }
                    }
                }
                .padding(.horizontal, 4)
            }
        }
        .onAppear {
            if selectedAccountId == nil {
                selectedAccountId = accountIds.first
            }
        }
    }

    // MARK: Actions

    private var accountIds: [String] {
        model.accounts.compactMap { $0["id"] as? String }
    }

    private func value(of id: String, _ key: String) -> String? {
        model.accounts.first { ($0["id"] as? String) == id }?[key] as? String
    }

    private func boolValue(of id: String, _ key: String) -> Bool {
        model.accounts.first { ($0["id"] as? String) == id }?[key] as? Bool ?? false
    }

    /// Switches the main window to the account, which lands it on Google's sign-in page.
    ///
    /// The helper cannot sign anyone in; only the account's own view can, and it is in
    /// the other process. So this is a request to go there rather than an action.
    private func signIn(id: String) {
        model.transport?.sendEvent(method: "account.signIn", params: ["accountId": id])
    }

    private func isChromium(_ id: String) -> Bool {
        let b = browser(for: id)
        return b == "chrome" || b == "brave" || b == "edge"
    }

    private func browser(for id: String) -> String {
        value(of: id, "browser") ?? "system"
    }

    private func profilesForBrowser(_ browser: String) -> [[String: String]] {
        model.browserProfiles[browser] ?? []
    }

    private func formatProfileLabel(_ profile: [String: String]) -> String {
        let name = profile["name"] ?? profile["directory"] ?? "Profile"
        if let email = profile["email"], !email.isEmpty {
            return "\(name) (\(email))"
        }
        return name
    }

    private func browserBinding(for id: String) -> Binding<String> {
        Binding(
            get: { value(of: id, "browser") ?? "system" },
            set: { newBrowser in
                guard let name = value(of: id, "name"),
                      let color = value(of: id, "color")
                else { return }
                update(id: id, name: name, color: color, browser: newBrowser)
            }
        )
    }

    private func profileBinding(for id: String) -> Binding<String> {
        Binding(
            get: { value(of: id, "browserProfile") ?? "_auto" },
            set: { newProfile in
                guard let name = value(of: id, "name"),
                      let color = value(of: id, "color")
                else { return }
                update(id: id, name: name, color: color, browserProfile: newProfile)
            }
        )
    }

    private func update(
        id: String,
        name: String,
        color: String,
        browser: String? = nil,
        browserProfile: String? = nil
    ) {
        guard !id.isEmpty,
              let index = model.accounts.firstIndex(where: { ($0["id"] as? String) == id })
        else { return }

        model.accounts[index]["name"] = name
        model.accounts[index]["color"] = color
        let currentBrowser = browser ?? (model.accounts[index]["browser"] as? String) ?? "system"
        let currentProfile = browserProfile ?? (model.accounts[index]["browserProfile"] as? String) ?? "_auto"
        model.accounts[index]["browser"] = currentBrowser
        model.accounts[index]["browserProfile"] = currentProfile

        let params: [String: Any] = [
            "accountId": id,
            "name": name,
            "color": color,
            "browser": currentBrowser,
            "browserProfile": currentProfile,
        ]
        model.transport?.sendEvent(method: "account.update", params: params)
    }

    private func addAccount() {
        let used = Set(model.accounts.compactMap { $0["color"] as? String })
        let color = startingColors.first { !used.contains($0) } ?? startingColors[0]

        model.transport?.sendEvent(method: "account.add", params: [
            "name": String(localized: "New Account"),
            "color": color,
        ])
    }

    private func removeSelected() {
        guard let id = selectedAccountId else { return }
        remove(id: id)
    }

    private func resetSelectedSession() {
        guard let id = selectedAccountId else { return }
        resetSession(id: id)
    }

    /// Confirms through the settings window's own sheet.
    ///
    /// Raised here rather than asked of the main process: the window belongs to this
    /// process, and an alert from the other one comes up behind it. The account is
    /// named in the event because the main process resets the one it is told about,
    /// which is the account selected in this list rather than the one on screen.
    private func resetSession(id: String) {
        guard let name = value(of: id, "name") else { return }

        let alert = NSAlert()
        alert.messageText = String(localized: "Reset the session for “\(name)”?")
        alert.informativeText = String(
            localized: "Signs this account out of Google and clears its cookies. Other accounts are untouched."
        )
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "Reset")).hasDestructiveAction = true
        alert.addButton(withTitle: String(localized: "Cancel"))

        // A sheet on the settings window when there is one, and modal otherwise.
        guard let window = NSApp.keyWindow ?? NSApp.mainWindow else {
            if alert.runModal() == .alertFirstButtonReturn {
                sendReset(for: id)
            }
            return
        }
        alert.beginSheetModal(for: window) { response in
            if response == .alertFirstButtonReturn {
                sendReset(for: id)
            }
        }
    }

    private func sendReset(for id: String) {
        model.transport?.sendEvent(method: "account.resetSession", params: ["accountId": id])
    }

    private func remove(id: String) {
        // The last account cannot be removed: there would be nothing to show.
        guard model.accounts.count > 1, !id.isEmpty else { return }
        model.transport?.sendEvent(method: "account.remove", params: ["accountId": id])
        if selectedAccountId == id {
            selectedAccountId = nil
        }
    }

    private func move(from source: IndexSet, to destination: Int) {
        model.accounts.move(fromOffsets: source, toOffset: destination)
        let ids = model.accounts.compactMap { $0["id"] as? String }
        model.transport?.sendEvent(method: "account.reorder", params: ["accountIds": ids])
    }
}
