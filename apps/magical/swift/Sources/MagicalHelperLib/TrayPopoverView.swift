import HelperUI
import SwiftUI

// MARK: - Tray Accessory Modifiers (Matching Magimail 1:1)

public struct TrayIconMenu: ViewModifier {
    public init() {}
    public func body(content: Content) -> some View {
        content
            .menuStyle(.button)
            .buttonStyle(.accessoryBar)
            .menuIndicator(.hidden)
            .fixedSize()
    }
}

public struct TrayAccessoryButton: ViewModifier {
    public init() {}
    public func body(content: Content) -> some View {
        content.buttonStyle(.accessoryBar)
    }
}

/// Presentation for the popover's call-to-action buttons: Join, and Sign In on the auth banner.
///
/// AppKit greys an accent-coloured control when its window is not key. `MenuBarController` keys the
/// popover as it opens, which is what actually settles this; the environment override here is the
/// fallback for a window that loses key while still on screen. The one action a banner or a live
/// meeting exists for cannot go quiet because of where focus sat.
///
/// It sets no control size. `controlSize` is an environment value and the innermost one wins, so a
/// size set here would override the `.mini` the agenda row's hover chip asks for.
public struct TrayProminentButton: ViewModifier {
    public init() {}
    public func body(content: Content) -> some View {
        content
            .buttonStyle(.borderedProminent)
            .tint(.accentColor)
            .environment(\.controlActiveState, .active)
    }
}

// MARK: - Main Popover View

public struct TrayPopoverView: View {
    @EnvironmentObject var model: TrayModel
    @State private var searchQuery = ""

    let onOpenApp: () -> Void
    let onSearch: (String, String?) -> Void
    let onQuickAdd: (String?) -> Void
    let onOpenSettings: () -> Void
    let onQuit: () -> Void
    let onJoinCall: (String) -> Void
    let onSelectEvent: (TrayEvent) -> Void
    let onRsvp: (TrayEvent, String) -> Void
    let onShowAccount: (String) -> Void
    let onRefresh: () -> Void
    let onDeleteEvent: ((TrayEvent) -> Void)?
    let onCompleteTask: ((TrayEvent, Bool) -> Void)?

    public init(
        onOpenApp: @escaping () -> Void,
        onSearch: @escaping (String, String?) -> Void,
        onQuickAdd: @escaping (String?) -> Void,
        onOpenSettings: @escaping () -> Void,
        onQuit: @escaping () -> Void,
        onJoinCall: @escaping (String) -> Void,
        onSelectEvent: @escaping (TrayEvent) -> Void,
        onRsvp: @escaping (TrayEvent, String) -> Void,
        onShowAccount: @escaping (String) -> Void,
        onRefresh: @escaping () -> Void,
        onDeleteEvent: ((TrayEvent) -> Void)? = nil,
        onCompleteTask: ((TrayEvent, Bool) -> Void)? = nil
    ) {
        self.onOpenApp = onOpenApp
        self.onSearch = onSearch
        self.onQuickAdd = onQuickAdd
        self.onOpenSettings = onOpenSettings
        self.onQuit = onQuit
        self.onJoinCall = onJoinCall
        self.onSelectEvent = onSelectEvent
        self.onRsvp = onRsvp
        self.onShowAccount = onShowAccount
        self.onRefresh = onRefresh
        self.onDeleteEvent = onDeleteEvent
        self.onCompleteTask = onCompleteTask
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()

            if model.accounts.isEmpty {
                Spacer()
                Text("No accounts configured")
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
                Spacer()
            } else {
                content
            }

            Divider()
            footer
        }
        .frame(
            width: TrayPopoverMetrics.defaultWidth,
            height: popoverHeight
        )
    }

    private var popoverHeight: CGFloat {
        TrayPopoverMetrics.height(isCalendarCollapsed: model.isCalendarCollapsed)
    }

    // MARK: - Header (Suite Consistent with Magimail)

    private var header: some View {
        HStack(spacing: 2) {
            HStack(spacing: 8) {
                if let mark = BrandArtwork.mark.image() {
                    Image(nsImage: mark)
                        .renderingMode(.original)
                }
                Text("Magical")
                    .font(.system(size: 13.5, weight: .semibold))
            }

            Spacer()

            calendarFilterMenu

            // No refresh button. Polling runs on its own and `tray.popoverOpened` re-polls a
            // stale cache as the popover appears, so the header would be offering a button for
            // something that has already happened. It stays in the gear menu, on ⌘R, for a
            // user who wants to force it.

            // Add Event button
            Button(action: { onQuickAdd(quickAddAccount?.id) }) {
                Image(systemName: "calendar.badge.plus")
                    .font(.system(size: 14))
            }
            .modifier(TrayAccessoryButton())
            .help(quickAddHelp)

            // Settings gear menu matching Magimail
            Menu {
                Toggle("Show Completed Tasks", isOn: Binding(
                    get: { model.showCompletedTasks },
                    set: { model.setShowCompletedTasks($0) }
                ))
                Divider()
                Button("Refresh Calendars") {
                    model.isRefreshing = true
                    onRefresh()
                }
                .keyboardShortcut("r")
                .disabled(model.isRefreshing)
                Divider()
                Button("Preferences…") { onOpenSettings() }
                Divider()
                Button("Quit Magical") { onQuit() }
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

    /// Sits in the top bar rather than beside the month, because it is not a property of
    /// the month. It persists across months and applies to the agenda, which scrolls
    /// through months of its own; next to the month title it would claim a scope it does
    /// not have.
    @ViewBuilder
    private var calendarFilterMenu: some View {
        if model.availableCalendars.count > 1 || model.hasTasks {
            Menu {
                ForEach(model.accounts) { account in
                    let accountCalendars = model.availableCalendars.filter { $0.accountId == account.id }
                    if !accountCalendars.isEmpty {
                        Section(account.name) {
                            ForEach(accountCalendars) { cal in
                                calendarToggle(cal)
                            }
                        }
                    }
                }

                let unassigned = model.availableCalendars.filter { cal in
                    !model.accounts.contains(where: { $0.id == cal.accountId })
                }
                if !unassigned.isEmpty {
                    Section("Other") {
                        ForEach(unassigned) { cal in
                            calendarToggle(cal)
                        }
                    }
                }

                if model.hasTasks {
                    Divider()
                    Toggle("Show Completed Tasks", isOn: Binding(
                        get: { model.showCompletedTasks },
                        set: { model.setShowCompletedTasks($0) }
                    ))
                }

                if model.isUserFilteringCalendars {
                    Divider()
                    Button("Show All Calendars") {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            model.showAllCalendars()
                        }
                    }
                }
            } label: {
                Image(systemName: model.isFilteringCalendars ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                    .font(.system(size: 13))
                    .foregroundStyle(model.isFilteringCalendars ? Color.accentColor : .primary)
            }
            .modifier(TrayAccessoryButton())
            .help(filterHelp)
        }
    }

    /// One calendar's row.
    ///
    /// A calendar a Focus has silenced is shown unticked and disabled rather than left out.
    /// Removing it would take away the only thing on screen that says why the agenda is
    /// short, and leaving it tickable would offer a choice the Focus overrules.
    @ViewBuilder
    private func calendarToggle(_ cal: TrayCalendarItem) -> some View {
        let silencedByFocus = model.isSilencedByFocus(cal)
        Toggle(isOn: Binding(
            get: { model.isCalendarVisible(cal) },
            set: { _ in
                withAnimation(.easeInOut(duration: 0.2)) {
                    model.toggleCalendar(cal)
                }
            }
        )) {
            Label {
                Text(cal.name)
            } icon: {
                Image(nsImage: AccountDot.image(hex: cal.colorHex))
            }
        }
        .disabled(silencedByFocus)
    }

    private var quickAddHelp: LocalizedStringKey {
        quickAddAccount.map { "New Event in \($0.name)" } ?? "New Event"
    }

    private var filterHelp: LocalizedStringKey {
        if FocusFilterController.shared.isFilterActive {
            return "Filter Calendars (a Focus is silencing some)"
        }
        return model.isFilteringCalendars ? "Filter Calendars (Active)" : "Filter Calendars"
    }

    /// The tick reads the account a search would actually run in, the same one the
    /// placeholder names, so it sits on the first account before anything has been picked.
    private var searchAccountSelection: Binding<String?> {
        Binding(
            get: { searchAccount?.id },
            set: { model.selectedAccountId = $0 }
        )
    }

    private var searchAccount: TrayAccount? {
        if let id = model.selectedAccountId {
            return model.accounts.first { $0.id == id }
        }
        return model.accounts.first
    }

    private var searchPlaceholder: String {
        if let account = searchAccount {
            return String(localized: "Search \(account.name) — opens in app")
        }
        return String(localized: "Search — opens in app")
    }

    private var searchField: some View {
        TraySearchField(
            text: $searchQuery,
            placeholder: searchPlaceholder,
            accounts: model.accounts,
            selectedAccountId: searchAccountSelection,
            onSubmit: { query, accountId in
                onSearch(query, accountId ?? searchAccount?.id)
            }
        )
        .frame(maxWidth: .infinity)
    }

    private var quickAddAccount: TrayAccount? {
        model.accounts.first
    }

    // MARK: - Content

    private var content: some View {
        VStack(spacing: 8) {
            searchField
                .padding(.horizontal, 12)
                .padding(.top, 4)

            // The meeting you are about to be late for comes first. Below the month grid it sat
            // 35 day cells down the popover, so the Join button was the last thing on screen for
            // the one state where it is the only thing you opened the popover for.
            if let hero = model.heroNextEvent {
                // Zero spacing, so the band sits flush between the dividers.
                // A gap either side would draw it as a card again.
                VStack(spacing: 0) {
                    Divider()

                    HeroNextEventCard(
                        event: hero.event,
                        minutesUntil: hero.minutesUntil,
                        calendarColor: Color(hex: hero.event.colorHex),
                        onJoinCall: onJoinCall,
                        onSelectEvent: onSelectEvent,
                        onRsvp: { response in onRsvp(hero.event, response) },
                        onDeleteEvent: onDeleteEvent,
                        onCompleteTask: onCompleteTask
                    )

                    Divider()
                }
            }

            // Row directly underneath: month name and navigation arrows
            monthHeader
                .padding(.horizontal, 12)
                .padding(.top, model.heroNextEvent == nil ? 4 : 0)

            // One band at most, in order of what the user can do about it. Offline
            // explains every account at once, so it wins; sign-in names the one account
            // the user can personally fix; stale is what is left when the agenda has
            // simply stopped moving and nothing else has said why.
            if model.isOffline {
                offlineBanner
                    .padding(.horizontal, 12)
            } else if let authAccount = accountsNeedingAuth.first {
                signInRequiredBanner(for: authAccount)
                    .padding(.horizontal, 12)
            } else if model.isRestricted {
                restrictedBanner
                    .padding(.horizontal, 12)
            } else if let syncedAt = model.lastSyncedAt {
                staleBanner(lastSyncedAt: syncedAt)
                    .padding(.horizontal, 12)
            }

            // Mini Calendar Grid (collapsible)
            if !model.isCalendarCollapsed {
                MiniMonthGridView(
                    displayedMonth: model.displayedMonthDate,
                    selectedDate: model.selectedDate,
                    densityDots: model.densityDotsByDay,
                    onSelectDate: { date in
                        withAnimation(.easeInOut(duration: 0.2)) {
                            model.requestScrollTo(date: date)
                        }
                    }
                )
                .padding(.horizontal, 12)
                .transition(.opacity.combined(with: .move(edge: .top)))

                Divider()
                    .padding(.horizontal, 12)
            }

            // Schedule Agenda View
            ScheduleAgendaView(
                feedItems: model.scheduleFeedItems,
                selectedDate: model.selectedDate,
                requestedScrollDate: model.requestedScrollDate,
                onSelectEvent: onSelectEvent,
                onJoinCall: onJoinCall,
                onRsvp: onRsvp,
                onDeleteEvent: onDeleteEvent,
                onCompleteTask: onCompleteTask,
                onDayScrolledIntoView: { date in
                    withAnimation(.easeInOut(duration: 0.2)) {
                        model.selectDate(date)
                    }
                },
                onScrolledNearEnd: { date in
                    model.requestMoreEvents(around: date.addingTimeInterval(90 * 86400))
                },
                isExplainedElsewhere: isDegraded
            )
            // The scroll view runs out to the popover's trailing margin so the scroller sits in
            // the margin; the cards keep their inset from inside the content (see
            // `ScheduleAgendaView`), so they still line up with the month header above.
            .padding(.leading, 12)
            .padding(.trailing, 2)
            // The agenda scrolls under whatever sits above it. Without the clip a row part-way
            // off the top of the scroll view draws past its own bounds and reads as leaking out
            // from beneath the divider.
            .clipped()

            Spacer(minLength: 0)
        }
        .padding(.bottom, 4)
    }

    // MARK: - Month Header (Month Name on Left, Arrows on Right)

    private var monthHeader: some View {
        HStack {
            // Month Title (Click jumps to today) + In-Place Toggle Chevron
            HStack(spacing: 5) {
                Button(action: {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        model.jumpToToday()
                    }
                }) {
                    Text(model.displayedMonthTitle)
                        .font(.system(size: 13.5, weight: .bold))
                        .foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
                .help("Jump to Now")

                Button(action: {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
                        model.toggleCalendarCollapse()
                    }
                }) {
                    Image(systemName: model.isCalendarCollapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help(model.isCalendarCollapsed ? "Expand Calendar" : "Collapse Calendar")
            }

            Spacer()

            // Month Navigation Arrows
            HStack(spacing: 4) {
                Button(action: {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        model.previousMonth()
                    }
                }) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                .modifier(TrayAccessoryButton())
                .help("Previous Month")

                Button(action: {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        model.nextMonth()
                    }
                }) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                .modifier(TrayAccessoryButton())
                .help("Next Month")
            }
        }
    }

    // MARK: - Banners

    /// Whether any banner is currently explaining that the agenda cannot be trusted.
    ///
    /// The agenda reads this to withhold "No events scheduled", so the two cannot
    /// contradict each other: a band saying the network is gone above a line saying the
    /// day is clear is worse than either alone.
    private var isDegraded: Bool {
        model.isOffline || !accountsNeedingAuth.isEmpty || model.isRestricted || model.lastSyncedAt != nil
    }

    private var accountsNeedingAuth: [TrayAccount] {
        model.accounts.filter { account in
            account.needsAuth && (model.selectedAccountId == nil || account.id == model.selectedAccountId)
        }
    }

    private var offlineBanner: some View {
        HStack(spacing: 9) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 1) {
                Text("Offline")
                    .font(.system(size: 12, weight: .semibold))
                Text("Waiting for network connection…")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.primary.opacity(0.05))
        )
    }

    /// Says how old the agenda underneath it is.
    ///
    /// Drawn when a calendar has stopped reading for a reason the other two banners do
    /// not cover: the wire format moved, or Google answered with an error. The user can
    /// do nothing about either, so the banner offers no button; what it gives them is the
    /// one thing they need, which is to know that what they are looking at is not current
    /// before they act on it.
    private func staleBanner(lastSyncedAt: Date) -> some View {
        HStack(spacing: 9) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 1) {
                Text("Not up to date")
                    .font(.system(size: 12, weight: .semibold))
                Text("Last synced \(Self.staleFormatter.localizedString(for: lastSyncedAt, relativeTo: Date()))")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.primary.opacity(0.05))
        )
    }

    /// Says the server refused this account by policy rather than by session.
    ///
    /// There is no button, because no credential the user can enter lifts an organisation
    /// policy; what they can do is ask the administrator, so the copy points there instead
    /// of at a sign-in that would not help.
    private var restrictedBanner: some View {
        HStack(spacing: 9) {
            Image(systemName: "lock.slash")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 1) {
                Text("Calendar access blocked")
                    .font(.system(size: 12, weight: .semibold))
                Text("An account's organization has blocked Google Calendar.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.primary.opacity(0.05))
        )
    }

    /// "25 minutes ago", in the user's own language and units.
    private static let staleFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter
    }()

    private func signInRequiredBanner(for account: TrayAccount) -> some View {
        HStack(spacing: 9) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 14))
                .foregroundStyle(.orange)

            VStack(alignment: .leading, spacing: 1) {
                Text("Sign in required")
                    .font(.system(size: 12, weight: .semibold))
                Text("\(account.name) session has expired")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)

            Button("Sign In") {
                onShowAccount(account.id)
            }
            .modifier(TrayProminentButton())
            .controlSize(.small)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.orange.opacity(0.1))
        )
    }

    // MARK: - Footer (Suite Consistent with Magimail)

    private var footer: some View {
        HStack {
            Spacer()
            Button(action: onOpenApp) {
                HStack(spacing: 5) {
                    Image(systemName: "arrow.up.forward.square")
                        .font(.system(size: 12))
                    Text("Open Calendar")
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

// MARK: - Search Field

/// The popover's search box, forwarding a submitted query to Google Calendar in the app.
///
/// A real `NSSearchField` rather than a `TextField` in a hand-drawn capsule, matching Magimail.
/// AppKit supplies the bezel, the magnifier, the clear button, the focus ring
/// and the vibrancy behind it — a painted background gets none of that and does
/// not follow the system's appearance. The field carries no local filtering;
/// submitting hands the query to the main window.
///
/// When multiple accounts are configured, `searchMenuTemplate` provides a native
/// dropdown menu on the search icon listing each account with its colour dot,
/// allowing the user to select which account session the search runs in.
struct TraySearchField: NSViewRepresentable {
    @Binding var text: String
    var placeholder: String = "Search — opens in app"
    var accounts: [TrayAccount] = []
    @Binding var selectedAccountId: String?
    let onSubmit: (String, String?) -> Void

    func makeNSView(context: Context) -> NSSearchField {
        let field = NSSearchField()
        field.placeholderString = placeholder
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
        context.coordinator.selectedAccountId = $selectedAccountId
        context.coordinator.onSubmit = onSubmit
        context.coordinator.accounts = accounts

        if field.placeholderString != placeholder {
            field.placeholderString = placeholder
        }

        updateSearchMenu(field, context: context)

        // Guarded so reassigning does not fight the user's insertion point.
        if field.stringValue != text {
            field.stringValue = text
        }
    }

    private func updateSearchMenu(_ field: NSSearchField, context: Context) {
        if accounts.count > 1 {
            let menu = NSMenu()
            menu.autoenablesItems = false

            let headerItem = NSMenuItem(
                title: String(localized: "Search in Account"),
                action: nil,
                keyEquivalent: ""
            )
            headerItem.isEnabled = false
            menu.addItem(headerItem)

            for account in accounts {
                let item = NSMenuItem(
                    title: account.name,
                    action: #selector(Coordinator.selectAccount(_:)),
                    keyEquivalent: ""
                )
                item.target = context.coordinator
                item.representedObject = account.id
                item.image = AccountDot.image(hex: account.color)
                item.state = (account.id == selectedAccountId) ? .on : .off
                menu.addItem(item)
            }
            field.searchMenuTemplate = menu
        } else {
            field.searchMenuTemplate = nil
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    final class Coordinator: NSObject, NSSearchFieldDelegate {
        var text: Binding<String>?
        var selectedAccountId: Binding<String?>?
        var onSubmit: ((String, String?) -> Void)?
        var accounts: [TrayAccount] = []

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
                onSubmit?(trimmed, selectedAccountId?.wrappedValue)
            }
            return true
        }
    }
}
