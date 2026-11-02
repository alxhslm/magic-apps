import HelperUI
import SwiftUI

// MARK: - Tray Popover View

/// Menu bar popover. See `docs/magimail/menu-bar.md`.
///
/// The list is one unified feed across every account, newest first, narrowed by
/// the filter menu in the header. The account a thread belongs to is carried by
/// the accent pill on the leading edge of its row.
///
/// NSPopover supplies the vibrancy material, so nothing here paints a background.
public struct TrayPopoverView: View {
    @EnvironmentObject var model: TrayModel
    @State private var searchQuery = ""

    /// The account a search runs in while the filter is on "All Accounts". The filter
    /// takes over whenever it names one, so this only matters in the unfiltered state.
    @State private var searchAccountId: String?

    let onCompose: (String?) -> Void
    let onShowAccount: (String) -> Void
    let onShowThread: (String, String) -> Void
    let onThreadAction: (_ accountId: String, _ threadId: String, _ action: TrayThreadAction) -> Void
    let onOpenApp: () -> Void
    let onSearch: (_ query: String, _ accountId: String?) -> Void
    let onRefresh: () -> Void
    let onOpenSettings: () -> Void
    let onQuit: () -> Void
    let onUnreadOnlyChanged: (Bool) -> Void

    public init(
        onCompose: @escaping (String?) -> Void,
        onShowAccount: @escaping (String) -> Void,
        onShowThread: @escaping (String, String) -> Void,
        onThreadAction: @escaping (
            _ accountId: String,
            _ threadId: String,
            _ action: TrayThreadAction
        ) -> Void,
        onOpenApp: @escaping () -> Void,
        onSearch: @escaping (_ query: String, _ accountId: String?) -> Void,
        onRefresh: @escaping () -> Void,
        onOpenSettings: @escaping () -> Void,
        onQuit: @escaping () -> Void,
        onUnreadOnlyChanged: @escaping (Bool) -> Void
    ) {
        self.onCompose = onCompose
        self.onShowAccount = onShowAccount
        self.onShowThread = onShowThread
        self.onThreadAction = onThreadAction
        self.onOpenApp = onOpenApp
        self.onSearch = onSearch
        self.onRefresh = onRefresh
        self.onOpenSettings = onOpenSettings
        self.onQuit = onQuit
        self.onUnreadOnlyChanged = onUnreadOnlyChanged
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()

            if let hero = model.activeVerificationCode {
                HeroVerificationCodeCard(
                    item: hero,
                    accountColor: accountColor(for: hero.accountId),
                    onSelectThread: onShowThread
                )
                Divider()
            }

            if model.accounts.isEmpty {
                Text("No accounts configured")
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
                    .padding(.vertical, 28)
            } else {
                content
            }

            Divider()
            footer
        }
        .frame(width: TrayPopoverMetrics.width)
    }

    // MARK: Header — title plus an icon-only trailing action bar

    private var header: some View {
        HStack(spacing: 2) {
            HStack(spacing: 8) {
                if let mark = BrandArtwork.mark.image() {
                    // .original stops SwiftUI treating it as a template and
                    // flattening the terracotta and gold to a single tint.
                    Image(nsImage: mark)
                        .renderingMode(.original)
                }
                Text("Magimail")
                    .font(.system(size: 13.5, weight: .semibold))
            }

            Spacer()

            filterMenu

            // The filter menu beside this already states which account you mean,
            // so this composes straight into it, falling back to whichever is
            // active when the filter says "All Accounts" — the same thing the
            // main window's own compose button does.
            //
            // Deliberately a plain Button. It was a Menu in one selection state
            // and a Button in the other, which is why the two looked different;
            // collapsing to a Menu with `primaryAction` instead made SwiftUI
            // render a split-style control that `.accessoryBar` cannot style.
            Button(action: { onCompose(composeAccount?.id) }) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 14))
            }
            .modifier(TrayAccessoryButton())
            .help(composeHelp)

            Menu {
                // Polling is on a timer, so the popover can be showing a minute-old list on
                // mains and three minutes on battery. This is the way to hurry it.
                Button("Refresh Inbox") {
                    model.isRefreshing = true
                    onRefresh()
                }
                .keyboardShortcut("r")
                .disabled(model.isRefreshing)
                Divider()
                Button("Preferences…") { onOpenSettings() }
                Divider()
                Button("Quit Magimail") { onQuit() }
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 14))
            }
            .modifier(TrayIconMenu())
            .help("Settings")
        }
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .padding(.vertical, 8)
    }

    /// Narrows the feed to one account, and with it what compose targets.
    ///
    /// A menu rather than a row of segments, so the header costs one icon whatever the
    /// accounts are. The segmented control it replaces took about 36pt of the popover's
    /// height, widened it with every account, and still truncated its labels past three.
    ///
    /// The funnel menu: what to show, then which accounts to draw it from.
    ///
    /// The unread filter is a `Toggle` in the same menu Apple Mail keeps its
    /// filter in, rather than a control of its own, so the header costs one icon
    /// whatever the accounts are. With more than one account the account filter
    /// follows: each is a `Toggle`, which AppKit draws as a tick beside the one
    /// showing. Selecting an account sets the filter to it, so the ticks behave
    /// as a radio group and the only way back to everything is "All Accounts".
    private var filterMenu: some View {
        Menu {
            Toggle(isOn: Binding(
                get: { model.showUnreadOnly },
                set: { value in
                    model.showUnreadOnly = value
                    onUnreadOnlyChanged(value)
                }
            )) {
                Text("Unread Only")
            }

            if model.accounts.count > 1 {
                Divider()

                Toggle(isOn: filterBinding(for: nil)) {
                    Text(filterLabel(title: "All Accounts", count: model.totalUnread))
                }

                Divider()

                ForEach(model.accounts) { account in
                    Toggle(isOn: filterBinding(for: account.id)) {
                        Label {
                            Text(filterLabel(title: account.name, count: account.unreadCount))
                        } icon: {
                            Image(nsImage: filterIcon(for: account))
                        }
                    }
                }
            }
        } label: {
            Image(systemName: isFiltering ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                .font(.system(size: 13))
                .foregroundStyle(isFiltering ? Color.accentColor : .primary)
        }
        .modifier(TrayIconMenu())
        .help(filterHelp)
    }

    /// The compose button's tooltip, naming the account the message will send from
    /// when the filter has narrowed to one.
    private var composeHelp: LocalizedStringKey {
        composeAccount.map { "New Message in \($0.name)" } ?? "New Message"
    }

    /// The filter button's tooltip: which account the feed is showing, or all of them.
    private var filterHelp: LocalizedStringKey {
        filteredAccount.map { "Showing \($0.name)" } ?? "All Accounts"
    }

    private var isFiltering: Bool {
        model.selectedAccountId != nil || model.showUnreadOnly
    }

    /// The account the filter has selected, if it still exists. An account removed in
    /// Settings leaves its id behind in the filter, and the feed already ignores it.
    private var filteredAccount: TrayAccount? {
        guard let id = model.selectedAccountId else { return nil }
        return model.accounts.first { $0.id == id }
    }

    private func filterBinding(for accountId: String?) -> Binding<Bool> {
        Binding(
            get: { model.selectedAccountId == accountId },
            set: { _ in model.selectedAccountId = accountId }
        )
    }

    /// The count is dropped at zero: the dot beside it already says nothing is waiting,
    /// and a nought would be the noisier half of the pair. Capped so one busy account
    /// cannot stretch the menu.
    private func filterLabel(title: String, count: Int) -> String {
        guard count > 0 else { return title }
        let countText = count > 99 ? "99+" : "\(count)"
        return String(localized: "\(title) (\(countText))")
    }

    /// The warning replaces the dot rather than joining it: an account that needs signing
    /// in again has a count nobody should read, since the feed behind it has stopped.
    private func filterIcon(for account: TrayAccount) -> NSImage {
        guard account.needsAuth else {
            return AccountDot.image(hex: account.color, filled: account.unreadCount > 0)
        }

        let config = NSImage.SymbolConfiguration(pointSize: 9.5, weight: .semibold)
            .applying(.init(hierarchicalColor: NSColor.systemOrange))
        guard let symbol = NSImage(
            systemSymbolName: "exclamationmark.triangle.fill",
            accessibilityDescription: String(localized: "Sign in required")
        ) else {
            return AccountDot.image(hex: "#f59e0b", filled: true)
        }

        let configured = symbol.withSymbolConfiguration(config) ?? symbol
        configured.isTemplate = false
        return configured
    }

    private func accountColor(for accountId: String) -> Color {
        if let hex = model.accounts.first(where: { $0.id == accountId })?.color {
            return Color(hex: hex)
        }
        return .accentColor
    }

    /// The account a direct compose targets: whichever the filter has selected,
    /// falling back to the only account when there is just one.
    private var composeAccount: TrayAccount? {
        if let account = filteredAccount {
            return account
        }
        return model.accounts.count == 1 ? model.accounts.first : nil
    }

    // MARK: Body — search, banners, unified feed

    private var content: some View {
        VStack(spacing: 6) {
            searchRow

            if model.isOffline {
                offlineBanner
            } else if let authAccount = accountsNeedingAuth.first {
                signInRequiredBanner(for: authAccount)
            } else if model.isRestricted {
                restrictedBanner
            }

            if model.visibleUnreadCount == 0, !model.isOffline, !model.isRestricted,
               accountsNeedingAuth.isEmpty, !model.showUnreadOnly
            {
                caughtUpBanner
            }

            messageList
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    /// Accounts relevant to the current selection that need authentication.
    private var accountsNeedingAuth: [TrayAccount] {
        model.accounts.filter { account in
            account.needsAuth && (model.selectedAccountId == nil || account.id == model.selectedAccountId)
        }
    }

    private var offlineBanner: some View {
        HStack(spacing: 9) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 16))
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 1) {
                Text("Offline")
                    .font(.system(size: 12.5, weight: .semibold))
                Text("Waiting for network connection…")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.primary.opacity(0.05))
        )
    }

    /// Says the server refused this account by policy rather than by session.
    ///
    /// There is no button: no credential the user can enter lifts an organisation policy,
    /// so the copy points at their administrator instead of a sign-in that would not help.
    private var restrictedBanner: some View {
        HStack(spacing: 9) {
            Image(systemName: "lock.slash")
                .font(.system(size: 16))
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 1) {
                Text("Gmail access blocked")
                    .font(.system(size: 12.5, weight: .semibold))
                Text("An account's organization has blocked Gmail.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.primary.opacity(0.05))
        )
    }

    private func signInRequiredBanner(for account: TrayAccount) -> some View {
        HStack(spacing: 9) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 16))
                .foregroundStyle(.orange)

            VStack(alignment: .leading, spacing: 1) {
                Text("Sign in required")
                    .font(.system(size: 12.5, weight: .semibold))
                Text("\(account.name) session has expired")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            Button("Sign In") {
                onShowAccount(account.id)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.orange.opacity(0.1))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.orange.opacity(0.2), lineWidth: 1)
        )
    }

    /// A Gmail search runs inside one account's session, so the field has to name one.
    /// The filter names it whenever it is set; with the filter on "All Accounts" the field's
    /// own menu does, and it starts on the first account rather than on nothing.
    private var searchRow: some View {
        TraySearchField(
            text: $searchQuery,
            placeholder: searchPlaceholder,
            // A set filter leaves nothing to choose, so the field offers no menu: the
            // search runs where the filter already points.
            accounts: filteredAccount == nil ? model.accounts : [],
            selectedAccountId: searchAccountSelection,
            onSubmit: { query in onSearch(query, searchAccount?.id) }
        )
        .frame(maxWidth: .infinity)
    }

    private var searchAccount: TrayAccount? {
        if let account = filteredAccount {
            return account
        }
        return model.accounts.first { $0.id == searchAccountId } ?? model.accounts.first
    }

    /// Both halves of what the field does: which account the query lands in, and that it
    /// leaves the popover to get there.
    private var searchPlaceholder: String {
        guard let account = searchAccount else { return String(localized: "Search — opens in app") }
        return String(localized: "Search \(account.name) — opens in app")
    }

    /// Bound to the account a search would actually run in, not to the raw `searchAccountId`,
    /// so the menu ticks the first account before anything has been picked.
    private var searchAccountSelection: Binding<String?> {
        Binding(
            get: { searchAccount?.id },
            set: { searchAccountId = $0 }
        )
    }

    private var caughtUpBanner: some View {
        HStack(spacing: 9) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 20))
                .foregroundStyle(.green)

            VStack(alignment: .leading, spacing: 1) {
                Text("All caught up")
                    .font(.system(size: 12.5, weight: .semibold))
                Text(caughtUpSubtitle)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.primary.opacity(0.05))
        )
    }

    private var caughtUpSubtitle: String {
        let names = model.accounts
            .filter { model.selectedAccountId == nil || $0.id == model.selectedAccountId }
            .map(\.name)
        switch names.count {
        case 0: return String(localized: "No unread messages.")
        case 1: return String(localized: "No unread messages in \(names[0]).")
        case 2: return String(localized: "No unread messages in \(names[0]) or \(names[1]).")
        default: return String(localized: "No unread messages across \(names.count) accounts.")
        }
    }

    @ViewBuilder
    private var messageList: some View {
        let messages = model.visibleMessages

        if messages.isEmpty {
            if model.showUnreadOnly, !model.isRestricted {
                // The filter hides the read threads that would otherwise fill the
                // space, so say what the empty list means rather than "nothing
                // recent": there is nothing unread to catch up on.
                caughtUpBanner
            } else {
                Text("Nothing recent to show")
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
            }
        } else {
            if model.visibleUnreadCount == 0 {
                HStack {
                    Text("RECENT")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(0.35)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 4)
            }

            // One unified inset group: hairline dividers, no per-row cards.
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(messages.enumerated()), id: \.element.message.id) { index, entry in
                        TrayMessageRow(
                            message: entry.message,
                            accentColor: Color(hex: entry.account.color),
                            showsDivider: index < messages.count - 1,
                            onTap: { onShowThread(entry.account.id, entry.message.threadId) },
                            onAction: { action in
                                // Shown here rather than waiting for the poll that
                                // will confirm it, so the row answers the click.
                                model.apply(
                                    action,
                                    accountId: entry.account.id,
                                    messageId: entry.message.id
                                )
                                onThreadAction(entry.account.id, entry.message.threadId, action)
                            }
                        )
                    }
                }
            }
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.primary.opacity(0.04))
            )
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
            )
            .frame(maxHeight: TrayPopoverMetrics.maxListHeight)
        }
    }

    // MARK: Footer — one subtle secondary utility link

    private var footer: some View {
        HStack {
            Spacer()
            Button(action: onOpenApp) {
                HStack(spacing: 5) {
                    Image(systemName: "arrow.up.forward.square")
                        .font(.system(size: 12))
                    Text("Open Inbox")
                        .font(.system(size: 11.5))
                }
            }
            .modifier(TrayAccessoryButton())
            .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.vertical, 8)
    }
}

// MARK: - Accessory Bar Presentation

// `.accessoryBar` is the system style for a borderless control in a bar like
// this: AppKit draws its own hover and pressed states, so nothing here paints a
// highlight. It replaces a hand-drawn `RoundedRectangle` fill driven by
// `.onHover`, which never worked on the menus in the first place — a `Menu`
// intercepts pointer events, so an `.onHover` attached to its label is never
// called.

/// Presentation for the header's gear menu. A `Menu` needs `menuStyle` for the
/// button style to reach it; a plain `Button` takes the style directly.
struct TrayIconMenu: ViewModifier {
    func body(content: Content) -> some View {
        content
            .menuStyle(.button)
            .buttonStyle(.accessoryBar)
            .menuIndicator(.hidden)
            .fixedSize()
    }
}

/// Presentation for the header's compose button and the footer's Open Inbox.
struct TrayAccessoryButton: ViewModifier {
    func body(content: Content) -> some View {
        content.buttonStyle(.accessoryBar)
    }
}

// MARK: - Message Row

struct TrayMessageRow: View {
    let message: TrayMessage
    let accentColor: Color
    let showsDivider: Bool
    let onTap: () -> Void
    let onAction: (TrayThreadAction) -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                // Leading account accent pill
                Capsule()
                    .fill(accentColor)
                    .frame(width: 3)
                    .padding(.vertical, 1)
                    .opacity(message.isUnread ? 1 : 0.35)

                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        // Unread reads through weight and full-strength text. No status
                        // dot: a coloured dot competes with the account accent pill.
                        Text(message.senderName)
                            .font(.system(size: 12, weight: message.isUnread ? .semibold : .medium))
                            .foregroundStyle(message.isUnread ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                            .lineLimit(1)

                        Spacer(minLength: 4)

                        Text(message.formattedTime)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .opacity(message.isUnread ? 1 : 0.7)
                    }

                    HStack(spacing: 6) {
                        Text(message.subject)
                            .font(.system(size: 11.5))
                            .foregroundStyle(.secondary)
                            .opacity(message.isUnread ? 1 : 0.7)
                            .lineLimit(1)

                        Spacer(minLength: 4)

                        // Unread's dot, away from the account pill so the two
                        // do not read as one glyph. Mail and Messages mark
                        // unread with a dot; the weight and tint carry the rest.
                        if message.isUnread {
                            Circle()
                                .fill(accentColor)
                                .frame(width: 6, height: 6)
                                .accessibilityHidden(true)
                        }

                        // Flush right, so it sits under the timestamp. Tertiary
                        // and unweighted: which tab a thread landed in ranks
                        // below who sent it and what it says.
                        Image(systemName: message.category.symbolName)
                            .font(.system(size: 10.5))
                            .foregroundStyle(.tertiary)
                            .help(message.category.title)
                            .accessibilityLabel(message.category.title)
                    }
                }
                .padding(.trailing, 10)
            }
            .padding(.leading, 7)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            message.isUnread
                ? accentColor.opacity(isHovering ? 0.14 : 0.07)
                : Color.primary.opacity(isHovering ? 0.05 : 0)
        )
        .accessibilityValue(message.isUnread ? Text("Unread") : Text("Read"))
        .onHover { isHovering = $0 }
        .threadContextMenu(message: message, onOpen: onTap, onAction: onAction)
        .overlay(alignment: .bottom) {
            if showsDivider {
                Rectangle()
                    .fill(Color.primary.opacity(0.08))
                    .frame(height: 0.5)
                    .padding(.leading, 18)
            }
        }
    }
}

// MARK: - Search Field

/// The popover's search box, forwarding a submitted query to Gmail in the app.
///
/// A real `NSSearchField` rather than a `TextField` in a hand-drawn capsule.
/// AppKit supplies the bezel, the magnifier, the clear button, the focus ring
/// and the vibrancy behind it — a painted background gets none of that and does
/// not follow the system's appearance. The field carries no local filtering;
/// submitting hands the query to the main window.
///
/// The placeholder carries both the account the query will run in and the "opens in app"
/// hint, because a native field has nowhere to put a trailing hint of its own.
///
/// When there is more than one account to choose between, they hang off the field's own
/// magnifier icon as a `searchMenuTemplate`, where AppKit draws the chevron and owns the
/// hit target.
struct TraySearchField: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let accounts: [TrayAccount]
    @Binding var selectedAccountId: String?
    let onSubmit: (String) -> Void

    func makeNSView(context: Context) -> NSSearchField {
        let field = NSSearchField()
        field.font = .systemFont(ofSize: 12.5)
        field.delegate = context.coordinator
        // Submission is explicit: nothing happens until the user presses Return.
        field.sendsWholeSearchString = true
        field.sendsSearchStringImmediately = false
        updateSearchMenu(field, context: context)
        return field
    }

    func updateNSView(_ field: NSSearchField, context: Context) {
        context.coordinator.text = $text
        context.coordinator.onSubmit = onSubmit
        context.coordinator.selectedAccountId = $selectedAccountId
        field.placeholderString = placeholder
        updateSearchMenu(field, context: context)

        // Guarded so reassigning does not fight the user's insertion point.
        if field.stringValue != text {
            field.stringValue = text
        }
    }

    /// One account, or a filter already naming one, leaves nothing to choose, and the icon
    /// goes back to a plain magnifier.
    ///
    /// The menu carries none of AppKit's recents tags, so the field passes the items through
    /// rather than treating them as a recent-search list. Rebuilding it on every update is
    /// what keeps the tick on the account the placeholder names.
    private func updateSearchMenu(_ field: NSSearchField, context: Context) {
        guard accounts.count > 1 else {
            field.searchMenuTemplate = nil
            return
        }

        let menu = NSMenu()
        menu.autoenablesItems = false

        let header = NSMenuItem(
            title: String(localized: "Search in"),
            action: nil,
            keyEquivalent: ""
        )
        header.isEnabled = false
        menu.addItem(header)

        for account in accounts {
            let item = NSMenuItem(
                title: account.name,
                action: #selector(Coordinator.selectAccount(_:)),
                keyEquivalent: ""
            )
            item.target = context.coordinator
            item.representedObject = account.id
            // The same colour as the accent pill on that account's rows, so the menu says
            // where a query goes without spending a word on it.
            item.image = AccountDot.image(hex: account.color, filled: true)
            item.state = account.id == selectedAccountId ? .on : .off
            menu.addItem(item)
        }

        field.searchMenuTemplate = menu
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    final class Coordinator: NSObject, NSSearchFieldDelegate {
        var text: Binding<String>?
        var selectedAccountId: Binding<String?>?
        var onSubmit: ((String) -> Void)?

        @objc func selectAccount(_ sender: NSMenuItem) {
            guard let id = sender.representedObject as? String else { return }
            selectedAccountId?.wrappedValue = id
        }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSSearchField else { return }
            text?.wrappedValue = field.stringValue
        }

        /// Same Return-key handling as `SearchDelegate` in the toolbar addon.
        func control(
            _ control: NSControl,
            textView _: NSTextView,
            doCommandBy selector: Selector
        ) -> Bool {
            guard selector == #selector(NSResponder.insertNewline(_:)) else { return false }
            let trimmed = control.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                onSubmit?(trimmed)
            }
            return true
        }
    }
}

// MARK: - Popover Metrics

/// The popover's width, held in one place because two sides set it: `MenuBarController`
/// puts it on the `NSPopover` and the view below puts it on its own frame. Left to
/// disagree, the smaller wins and AppKit clips what the other asked for.
///
/// One width for every account count. The filter is a single icon in the header, so
/// nothing in the popover grows as accounts are added; the segmented control this
/// replaced was measured from its own labels and widened the window with each one.
public enum TrayPopoverMetrics {
    public static let width: CGFloat = 340
    public static let maxListHeight: CGFloat = 320
}

// MARK: - Account Dot

/// Identity and unread state in one mark: the account's colour always, filled
/// when mail is waiting and a ring when it is not.
///
/// Both states use fixed colours, so unlike a bitmap that borrows system colours
/// this never needs redrawing when the appearance changes; that is what makes it
/// safe to hand to AppKit as a menu item's image.
///
/// Twin of the drawing in `AccountSegmentedControl` in the toolbar addon. The
/// two live in separate SwiftPM packages in separate processes, so the geometry
/// is duplicated deliberately — they agree today, and are free to diverge.
enum AccountDot {
    static let diameter: CGFloat = 9
    static let ringStroke: CGFloat = 1.5

    /// Non-template so AppKit draws the real colour rather than tinting it to
    /// match the control.
    static func image(hex: String, filled: Bool) -> NSImage {
        let image = NSImage(
            size: NSSize(width: diameter, height: diameter),
            flipped: false
        ) { rect in
            NSColor(hex: hex).setFill()
            NSColor(hex: hex).setStroke()

            if filled {
                NSBezierPath(ovalIn: rect).fill()
            } else {
                // Inset by half the stroke so the ring stays inside the bounds.
                let path = NSBezierPath(
                    ovalIn: rect.insetBy(dx: ringStroke / 2, dy: ringStroke / 2)
                )
                path.lineWidth = ringStroke
                path.stroke()
            }
            return true
        }
        image.isTemplate = false
        return image
    }
}
