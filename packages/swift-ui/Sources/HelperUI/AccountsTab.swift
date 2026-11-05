import AppKit
import HelperRPC
import SwiftUI

/// The part of a helper's settings model the account list editor reads.
///
/// The two apps' models carry a great deal that is not shared — mail categories,
/// meeting alerts, calendars — but the account list is one problem. Both hold
/// the main process's `{ id, name, color, needsAuth }` rows and both speak the
/// same `account.add` / `account.update` / `account.remove` / `account.reorder` /
/// `account.signIn` events, so this small protocol is all the editor needs to stay out
/// of either app's model. The browser data comes from macOS and from the Chromium
/// browsers' `Local State`, and reaches both models the same way.
///
/// An app that grows a genuinely different account list can drop this and write
/// its own `AccountsTab`; the window takes an opaque view per tab, so nothing
/// else has to change.
@MainActor
public protocol AccountListModel: ObservableObject {
    var accounts: [[String: Any]] { get set }
    var browserProfiles: [String: [[String: String]]] { get set }
    /// The browsers the app can launch, without `system`, as `{ id, name, isChromium }`.
    var browsers: [[String: Any]] { get }
    /// The browser macOS opens `https` links with, as `{ id, name, bundleId, isChromium }`.
    var defaultBrowser: [String: Any] { get }
    /// Which browser links open in, or `system` to follow the Mac's default.
    var openLinksIn: String { get }
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
                        linksMenu: AnyView(profileMenu(for: id)),
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

    /// The browser links actually open in: the app's choice, or the Mac's default.
    private var linkedBrowser: String {
        let chosen = model.openLinksIn
        return chosen == "system" ? (model.defaultBrowser["id"] as? String ?? "system") : chosen
    }

    /// Whether that browser keeps profiles we can choose between.
    private var supportsProfiles: Bool {
        if let row = model.browsers.first(where: { ($0["id"] as? String) == linkedBrowser }) {
            return row["isChromium"] as? Bool ?? false
        }
        // `system` with a default browser outside our list: the answer is in the default.
        return model.openLinksIn == "system" && (model.defaultBrowser["isChromium"] as? Bool ?? false)
    }

    private var linkedBrowserName: String {
        model.browsers.first { ($0["id"] as? String) == linkedBrowser }?["name"] as? String
            ?? model.defaultBrowser["name"] as? String
            ?? "This browser"
    }

    private func profilesForBrowser(_ browser: String) -> [[String: String]] {
        model.browserProfiles[browser] ?? []
    }

    /// The menu's own label: the profile this account's links open in, in one word where
    /// the setting is one of the two rules rather than a named profile.
    private func profileSummary(for id: String) -> String {
        guard supportsProfiles else { return "No profiles" }
        let setting = value(of: id, "browserProfile") ?? "_auto"
        if setting == "_auto" {
            return "Match email"
        }
        if setting == "_last" {
            return "Last used"
        }
        let profile = profilesForBrowser(linkedBrowser).first { $0["directory"] == setting }
        return profile?["name"] ?? setting
    }

    /// The per-account half of link routing, on the row it belongs to.
    ///
    /// The browser itself is one setting for the app, on the General tab: it is where
    /// someone works, not who they are. The profile is the part that differs per account,
    /// which is the whole reason a link needs to know which Google session it belongs to.
    private func profileMenu(for id: String) -> some View {
        Menu {
            Toggle("Match this account’s email", isOn: profileToggle("_auto", for: id))

            let profiles = profilesForBrowser(linkedBrowser)
            if !profiles.isEmpty {
                Divider()
                ForEach(profiles, id: \.self) { profile in
                    Toggle(
                        profile["name"] ?? profile["directory"] ?? "Profile",
                        isOn: profileToggle(profile["directory"] ?? "", for: id)
                    )
                }
            }
        } label: {
            Text(profileSummary(for: id))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(!supportsProfiles)
        .help(
            supportsProfiles
                ? "The Chromium profile this account’s links open in."
                : "\(linkedBrowserName) has no profiles to choose between."
        )
    }

    private func profileToggle(_ setting: String, for id: String) -> Binding<Bool> {
        Binding(
            get: { (value(of: id, "browserProfile") ?? "_auto") == setting },
            set: { isOn in
                guard isOn,
                      let name = value(of: id, "name"),
                      let color = value(of: id, "color")
                else { return }
                update(id: id, name: name, color: color, browserProfile: setting)
            }
        )
    }

    private func update(
        id: String,
        name: String,
        color: String,
        browserProfile: String? = nil
    ) {
        guard !id.isEmpty,
              let index = model.accounts.firstIndex(where: { ($0["id"] as? String) == id })
        else { return }

        model.accounts[index]["name"] = name
        model.accounts[index]["color"] = color

        var params: [String: Any] = ["accountId": id, "name": name, "color": color]
        if let browserProfile {
            model.accounts[index]["browserProfile"] = browserProfile
            params["browserProfile"] = browserProfile
        }
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
