import AppKit
import HelperRPC
import SwiftUI

// MARK: - Menu Bar Controller

@MainActor
public final class MenuBarController: NSObject, NSPopoverDelegate {
    public static let shared = MenuBarController()

    private var statusItem: NSStatusItem?
    private var popover: NSPopover?
    var transport: StdioTransport?
    private var tickTimer: Timer?
    private var transitionTimer: Timer?
    private var lastActiveEventId: String?
    private var lastUpcomingEventId: String?
    public private(set) var popoverClosedTimestamp: CFAbsoluteTime = 0

    override public init() {
        super.init()
    }

    public func create(transport: StdioTransport) {
        self.transport = transport
        guard statusItem == nil else { return }

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = BrandArtwork.mark.menuBarGlyph.statusItemImage()
                ?? NSImage(systemSymbolName: "calendar", accessibilityDescription: "Magical")
            // Sized by the glyph itself: its box is taller than it is wide, and a
            // square size here would squash the calendar.
            button.image?.size = BrandArtwork.mark.menuBarGlyph.size
            button.imageScaling = .scaleProportionallyDown
            button.imagePosition = .imageLeading
            button.image?.isTemplate = true
            button.image?.accessibilityDescription = "Magical"
            button.action = #selector(StatusItemTarget.handleClick)
            button.target = StatusItemTarget.shared
            button.sendAction(on: [.leftMouseDown, .rightMouseDown])
        }
        statusItem = item
        StatusItemTarget.shared.controller = self

        TrayModel.shared.onCollapseToggled = { [weak self] isCollapsed in
            self?.transport?.sendEvent(method: "tray.setCalendarCollapsed", params: ["isCollapsed": isCollapsed])
            if let pop = self?.popover, pop.isShown {
                pop.contentSize = NSSize(
                    width: TrayPopoverMetrics.defaultWidth,
                    height: TrayPopoverMetrics.height(isCalendarCollapsed: isCollapsed)
                )
            }
        }

        TrayModel.shared.onCalendarFilterChanged = { [weak self] hidden in
            self?.transport?.sendEvent(method: "tray.setHiddenCalendars", params: [
                "hiddenCalendars": hidden,
            ])
            // The title counts down to an event on a calendar that may have just been
            // hidden, and the next push is a poll interval away.
            self?.updateTitle()
            self?.scheduleNextTransitionTimer()
        }

        TrayModel.shared.onEnsureRange = { [weak self] date in
            self?.transport?.sendEvent(method: "tray.ensureRange", params: [
                "targetDateMs": date.timeIntervalSince1970 * 1000,
            ])
        }

        TrayModel.shared.onShowCompletedTasksChanged = { [weak self] showCompleted in
            self?.transport?.sendEvent(method: "tray.setShowCompletedTasks", params: [
                "showCompletedTasks": showCompleted,
            ])
            self?.updateTitle()
            self?.scheduleNextTransitionTimer()
        }

        updateTitle()
        startTicking()
        _ = getOrCreatePopover()
    }

    public func destroy() {
        dismissPopover()
        popover = nil
        tickTimer?.invalidate()
        tickTimer = nil
        transitionTimer?.invalidate()
        transitionTimer = nil
        if let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
        }
        statusItem = nil
    }

    /// Re-renders the title between the main process's pushes.
    ///
    /// `tray.update` only arrives on the poll interval — five minutes on mains, fifteen on
    /// battery — so a countdown driven by it alone would still read twenty minutes when the
    /// meeting started. `.common` mode keeps it firing while a menu is tracking.
    private func startTicking() {
        tickTimer?.invalidate()
        let timer = Timer(timeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.updateTitle()
                TrayModel.shared.refreshNow()
                self?.scheduleNextTransitionTimer()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        tickTimer = timer
        scheduleNextTransitionTimer()
    }

    /// Schedules a precise timer at the next boundary where an event starts or ends,
    /// so back-to-back transitions advance immediately without waiting for the 30s tick.
    private func scheduleNextTransitionTimer() {
        transitionTimer?.invalidate()
        transitionTimer = nil

        guard let nextTransition = TrayModel.shared.nextScheduleTransitionDate() else {
            return
        }

        // Fire 50ms past the boundary to guarantee now >= targetDate even with timer jitter
        let fireDate = nextTransition.addingTimeInterval(0.05)
        let timer = Timer(fire: fireDate, interval: 0, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.handleScheduleTransition(targetDate: nextTransition)
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        transitionTimer = timer
    }

    private func handleScheduleTransition(targetDate: Date) {
        let evalNow = max(Date(), targetDate)
        checkMeetingTransitions(now: evalNow)
        updateTitle()
        TrayModel.shared.refreshNow()
        scheduleNextTransitionTimer()
    }

    /// Strips query and fragment from URLs while preserving scheme and host/path for logs.
    static func redactUrl(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "none" }
        guard let components = URLComponents(string: raw) else {
            return "<invalid-url>"
        }
        if components.scheme?.lowercased() == "mailto" {
            return "mailto:<redacted>"
        }
        var base = ""
        if let scheme = components.scheme {
            base += "\(scheme)://"
        }
        if let host = components.host {
            base += host
        }
        base += components.percentEncodedPath
        let hasParams = !(components.query?.isEmpty ?? true) || !(components.fragment?.isEmpty ?? true)
        return hasParams ? "\(base)?<redacted>" : base
    }

    /// Logs transitions between active and upcoming meetings with remaining/until seconds.
    func checkMeetingTransitions(now: Date = Date()) {
        let model = TrayModel.shared
        let currentActive = model.activeEvent(now: now)
        let currentUpcoming = model.upcomingEvent(within: nil, now: now)

        if currentActive?.id != lastActiveEventId {
            lastActiveEventId = currentActive?.id
            if let active = currentActive {
                let remaining = max(0, Int(active.endTime.timeIntervalSince(now)))
                HelperLog.info(
                    "Tray",
                    "Active meeting transition: eventId=\(active.id) start=\(active.startTime) end=\(active.endTime) remainingSeconds=\(remaining)"
                )
            } else {
                HelperLog.info("Tray", "Active meeting ended: no active meeting")
            }
        }

        if currentUpcoming?.event.id != lastUpcomingEventId {
            lastUpcomingEventId = currentUpcoming?.event.id
            if let upcoming = currentUpcoming {
                let secondsUntil = max(0, Int(upcoming.event.startTime.timeIntervalSince(now)))
                HelperLog.info(
                    "Tray",
                    "Upcoming meeting transition: eventId=\(upcoming.event.id) start=\(upcoming.event.startTime) end=\(upcoming.event.endTime) secondsUntilStart=\(secondsUntil)"
                )
            } else {
                HelperLog.info("Tray", "Upcoming meeting transition: no upcoming meetings left today")
            }
        }
    }

    public func updateData(params: [String: Any]) {
        TrayModel.shared.update(from: params)
        // The account list has just changed. A filter entry naming an account that is no
        // longer offered is a dangling reference: drop it, so a Focus configured to keep
        // only that account on does not silence everything now that its target is gone.
        FocusFilterController.shared.prune(to: Set(TrayModel.shared.accounts.map(\.id)))
        updateTitle()
        scheduleNextTransitionTimer()
    }

    public func updateTitle() {
        checkMeetingTransitions()
        guard let button = statusItem?.button else { return }

        let model = TrayModel.shared
        let title = NSMutableAttributedString()

        func appendImage(_ image: NSImage, width: CGFloat) {
            title.append(NSAttributedString(attachment: MenuBarTitle.attachment(image, width: width)))
        }

        func appendBar(_ hex: String) {
            appendImage(AccountBar.image(hex: hex), width: AccountBar.width)
        }

        // Holds a width open without drawing anything in it. A width below a tenth of a
        // point is dropped; there is nothing to see at that size.
        func appendSpacer(_ width: CGFloat) {
            guard width > 0.1 else { return }
            appendImage(MenuBarTitle.spacer(width: width), width: width)
        }

        func appendText(_ string: String) {
            title.append(NSAttributedString(string: string, attributes: [
                .foregroundColor: NSColor.labelColor,
                .font: MenuBarTitle.font,
            ]))
        }

        switch model.menuBarDisplayMode {
        case "dayOfMonth":
            let dayNum = Calendar.current.component(.day, from: Date())
            appendText(" \(dayNum)")

        case "dayAndMonth":
            let df = DateFormatter()
            df.dateFormat = "E d MMM"
            df.timeZone = .current
            appendText(" \(df.string(from: Date()))")

        // Whatever is left today, not just the next four hours the hero card covers; the
        // title going blank mid-afternoon reads as the feature breaking. The bar is the
        // account's own colour rather than the event's, so it answers "whose calendar is
        // this" — the question the menu bar is asked.
        case "nextEvent":
            // Nothing left today shows nothing. Falling back to the date would put a
            // number in the menu bar that the chosen mode never promised, and it reads as
            // the countdown having broken rather than the day being over.
            guard let next = model.nextEvent(within: nil) else { break }
            let countdown = TrayCountdown.compact(minutes: next.minutesUntil)
            appendText(" ")
            if model.showMenuBarAccountColor {
                if let account = model.accounts.first(where: { $0.id == next.event.accountId }) {
                    appendBar(account.color)
                } else {
                    // An event whose account has gone leaves the bar's width behind, so
                    // the title does not step sideways for one meeting in a day of them.
                    appendSpacer(AccountBar.width)
                }
            }
            let summary = next.event.summary.trimmingCharacters(in: .whitespacesAndNewlines)
            let short = summary.count > 16 ? "\(summary.prefix(15))…" : summary
            appendText(" \(countdown): \(short)")
            // The countdown changes width as it runs, and not only by shrinking: `2h`
            // widens to `1h 59m` before it narrows to `59m`, `9m` and `Now`. A status item
            // that changes width drags every item to its left along with it, so the
            // countdown is held to the width of its longest reading. The reserve trails
            // the title rather than leading it: at the end it is empty space beside the
            // neighbouring item, whereas in front it would slide the words themselves.
            appendSpacer(MenuBarTitle.countdownWidth - MenuBarTitle.width(of: countdown))

        default:
            break
        }

        button.attributedTitle = title
    }

    func togglePopover() {
        if let popover, popover.isShown {
            dismissPopover()
        } else {
            showPopover()
        }
    }

    // MARK: - Secondary-click menu

    /// A right-click gets a menu rather than the popover.
    ///
    /// Joining the call you are late for is the one thing worth doing without reading anything
    /// first, and the popover costs an appearance animation and a whole agenda to get to the
    /// same button. The menu opens over the menu bar and the first item is already under the
    /// pointer.
    func showQuickMenu() {
        guard let item = statusItem, let button = item.button else { return }
        dismissPopover()

        let model = TrayModel.shared
        let menu = NSMenu()
        menu.autoenablesItems = false

        let next = model.nextEvent(within: nil)
        if let next {
            let joinUrl = next.event.conferenceUrl
            HelperLog.info("Tray", "Quick menu opened: eventId=\(next.event.id) joinUrl=\(Self.redactUrl(joinUrl)) minutesUntil=\(next.minutesUntil)")
        } else {
            HelperLog.info("Tray", "Quick menu opened: no event resolved")
        }

        if let next,
           let url = next.event.conferenceUrl, !url.isEmpty
        {
            let summary = next.event.summary.trimmingCharacters(in: .whitespacesAndNewlines)
            let short = summary.count > 40 ? "\(summary.prefix(39))…" : summary
            let join = NSMenuItem(
                title: String(localized: "Join “\(short)”"),
                action: #selector(StatusItemTarget.joinCall),
                keyEquivalent: ""
            )
            join.attributedTitle = NSAttributedString(
                string: join.title,
                attributes: [.font: NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)]
            )
            join.image = NSImage(systemSymbolName: "video.fill", accessibilityDescription: nil)
            join.target = StatusItemTarget.shared
            StatusItemTarget.shared.pendingJoinUrl = url
            menu.addItem(join)

            let when = NSMenuItem(
                title: "\(TrayCountdown.label(minutes: next.minutesUntil).capitalized) · \(next.event.formattedTime)",
                action: nil,
                keyEquivalent: ""
            )
            when.isEnabled = false
            menu.addItem(when)
            menu.addItem(.separator())
        }

        for (title, selector) in [
            (String(localized: "Open Calendar"), #selector(StatusItemTarget.openApp)),
            (String(localized: "New Event"), #selector(StatusItemTarget.quickAdd)),
            (String(localized: "Refresh Calendars"), #selector(StatusItemTarget.refresh)),
        ] {
            let entry = NSMenuItem(title: title, action: selector, keyEquivalent: "")
            entry.target = StatusItemTarget.shared
            menu.addItem(entry)
        }

        menu.addItem(.separator())

        let showTasks = NSMenuItem(
            title: String(localized: "Show Completed Tasks"),
            action: #selector(StatusItemTarget.toggleShowCompletedTasks),
            keyEquivalent: ""
        )
        showTasks.state = model.showCompletedTasks ? .on : .off
        showTasks.target = StatusItemTarget.shared
        menu.addItem(showTasks)

        menu.addItem(.separator())

        let prefs = NSMenuItem(
            title: String(localized: "Preferences…"),
            action: #selector(StatusItemTarget.openSettings),
            keyEquivalent: ","
        )
        prefs.target = StatusItemTarget.shared
        menu.addItem(prefs)

        let quit = NSMenuItem(
            title: String(localized: "Quit Magical"),
            action: #selector(StatusItemTarget.quit),
            keyEquivalent: "q"
        )
        quit.target = StatusItemTarget.shared
        menu.addItem(quit)

        // Handing the menu to the status item, rather than popping it up at a point, is what
        // gets the button's own highlight and the menu bar's placement. `performClick` blocks
        // until tracking ends, so clearing it straight after restores the left-click action.
        item.menu = menu
        button.performClick(nil)
        item.menu = nil
    }

    func send(method: String, params: [String: Any] = [:]) {
        transport?.sendEvent(method: method, params: params)
    }

    /// Asks the main process for the settings window rather than showing it here.
    ///
    /// The window is hosted in this process, so showing it directly works and shows the
    /// wrong values: the settings, the account list and the version all live in Electron,
    /// and `SettingsModel` only holds what a `settings.show` last carried. This helper is
    /// restarted freely, so on a fresh one that is the built-in defaults. The round trip
    /// comes back as `settings.show` with the current state attached.
    func requestSettingsWindow() {
        send(method: "tray.openSettings")
    }

    func makePopoverView() -> TrayPopoverView {
        TrayPopoverView(
            onOpenApp: { [weak self] in
                self?.send(method: "tray.openApp")
                self?.dismissPopover()
            },
            onSearch: { [weak self] query, accountId in
                var params: [String: Any] = ["query": query]
                if let accountId, !accountId.isEmpty {
                    params["accountId"] = accountId
                }
                self?.send(method: "tray.search", params: params)
                self?.dismissPopover()
            },
            onQuickAdd: { [weak self] accountId in
                var params: [String: Any] = [:]
                if let accountId, !accountId.isEmpty {
                    params["accountId"] = accountId
                }
                self?.send(method: "tray.openQuickAdd", params: params)
                self?.dismissPopover()
            },
            onOpenSettings: { [weak self] in
                self?.dismissPopover()
                self?.requestSettingsWindow()
            },
            onQuit: { [weak self] in
                self?.dismissPopover()
                self?.send(method: "tray.quit")
            },
            onJoinCall: { [weak self] url in
                self?.send(method: "tray.joinCall", params: ["url": url])
            },
            onSelectEvent: { [weak self] event in
                self?.send(method: "tray.focusEvent", params: [
                    "accountId": event.accountId,
                    "eventId": event.id,
                ])
                self?.dismissPopover()
            },
            onRsvp: { [weak self] event, response in
                self?.send(method: "tray.rsvp", params: [
                    "accountId": event.accountId,
                    "eventId": event.id,
                    "response": response,
                ])
            },
            onShowAccount: { [weak self] accountId in
                self?.send(method: "tray.showAccount", params: ["accountId": accountId])
                self?.dismissPopover()
            },
            onRefresh: { [weak self] in
                self?.send(method: "tray.refresh")
            },
            onDeleteEvent: { [weak self] event in
                self?.send(method: "tray.deleteEvent", params: [
                    "accountId": event.accountId,
                    "eventId": event.id,
                ])
            },
            // The popover stays open, unlike Open in Magical: the task is still in the
            // agenda behind the menu either way, and dismissing would read as the row
            // having gone.
            onCompleteTask: { [weak self] event, completed in
                self?.send(method: "tray.setTaskCompleted", params: [
                    "accountId": event.accountId,
                    "eventId": event.id,
                    "completed": completed,
                ])
            }
        )
    }

    func getOrCreatePopover() -> NSPopover {
        if let existing = popover {
            return existing
        }
        let pop = NSPopover()
        pop.behavior = .transient
        pop.animates = true
        pop.delegate = self
        let view = makePopoverView().environmentObject(TrayModel.shared)
        let host = NSHostingController(rootView: view)
        pop.contentViewController = host
        _ = host.view
        host.view.layoutSubtreeIfNeeded()
        popover = pop
        return pop
    }

    private func showPopover() {
        guard let button = statusItem?.button else { return }

        let model = TrayModel.shared
        model.prepareForPresentation()

        if let hero = model.heroNextEvent {
            HelperLog.info("Tray", "Popover opened: heroEventId=\(hero.event.id) joinUrl=\(Self.redactUrl(hero.event.conferenceUrl)) minutesUntil=\(hero.minutesUntil)")
        } else {
            HelperLog.info("Tray", "Popover opened: no hero event resolved")
        }

        let pop = getOrCreatePopover()
        pop.contentSize = NSSize(
            width: TrayPopoverMetrics.defaultWidth,
            height: TrayPopoverMetrics.height(isCalendarCollapsed: model.isCalendarCollapsed)
        )

        guard !pop.isShown else { return }
        pop.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)

        // A popover shown from a status item does not become key on its own: clicking the menu
        // bar leaves whichever app was frontmost still holding focus. AppKit then draws the
        // popover's accent-coloured controls in their inactive grey, and no keyboard shortcut
        // inside it is reachable — so Join came up grey and turned blue only when something
        // else happened to make the window key, and ⌘R did nothing at all. Keying the popover
        // itself, rather than activating Magical, leaves the other app's windows where they are.
        pop.contentViewController?.view.window?.makeKey()

        transport?.sendEvent(method: "tray.popoverOpened")
    }

    public func dismissPopover() {
        popoverClosedTimestamp = CFAbsoluteTimeGetCurrent()
        popover?.performClose(nil)
    }

    // MARK: - NSPopoverDelegate

    public nonisolated func popoverWillClose(_: Notification) {
        MainActor.assumeIsolated {
            self.popoverClosedTimestamp = CFAbsoluteTimeGetCurrent()
        }
    }

    public nonisolated func popoverDidClose(_: Notification) {
        MainActor.assumeIsolated {
            self.popoverClosedTimestamp = CFAbsoluteTimeGetCurrent()
        }
    }
}

/// Target for the status item button and its secondary-click menu.
@MainActor
private final class StatusItemTarget: NSObject {
    static let shared = StatusItemTarget()
    weak var controller: MenuBarController?

    /// The conference link the menu's Join item opens, set as that menu is built.
    var pendingJoinUrl: String?

    @objc func handleClick() {
        let isSecondary = NSApp.currentEvent.map { event in
            event.type == .rightMouseDown || (event.type == .leftMouseDown && event.modifierFlags.contains(.control))
        } ?? false

        if isSecondary {
            controller?.showQuickMenu()
            return
        }

        // If the popover was closed by this click (transient dismissal on mouse-down), do not reopen it.
        if let controller, CFAbsoluteTimeGetCurrent() - controller.popoverClosedTimestamp < 0.25 {
            return
        }

        controller?.togglePopover()
    }

    @objc func joinCall() {
        guard let url = pendingJoinUrl else { return }
        controller?.send(method: "tray.joinCall", params: ["url": url])
    }

    @objc func openApp() {
        controller?.send(method: "tray.openApp")
    }

    @objc func quickAdd() {
        controller?.send(method: "tray.openQuickAdd")
    }

    @objc func refresh() {
        controller?.send(method: "tray.refresh")
    }

    @objc func toggleShowCompletedTasks() {
        TrayModel.shared.toggleShowCompletedTasks()
    }

    @objc func openSettings() {
        controller?.requestSettingsWindow()
    }

    @objc func quit() {
        controller?.send(method: "tray.quit")
    }
}
