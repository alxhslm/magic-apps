import AppKit
import HelperRPC
import HelperUI
import SwiftUI

// MARK: - Menu Bar Controller

@MainActor
public final class MenuBarController: NSObject, NSPopoverDelegate {
    public static let shared = MenuBarController()

    private var statusItem: NSStatusItem?
    private var popover: NSPopover?
    private var eventMonitor: Any?
    var transport: StdioTransport?
    public private(set) var popoverClosedTimestamp: CFAbsoluteTime = 0

    override public init() {
        super.init()
    }

    public func create(transport: StdioTransport) {
        self.transport = transport
        guard statusItem == nil else { return }

        HelperLog.info("Tray", "Status item attached to system menu bar")
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = BrandArtwork.mark.menuBarGlyph.statusItemImage()
                ?? NSImage(systemSymbolName: "envelope", accessibilityDescription: "Magimail")
            // Sized by the glyph itself: its box is taller than the envelope, and a
            // fixed size here would squash it.
            button.image?.size = BrandArtwork.mark.menuBarGlyph.size
            button.image?.isTemplate = true
            button.image?.accessibilityDescription = "Magimail"
            button.action = #selector(StatusItemTarget.togglePopover)
            button.target = StatusItemTarget.shared
            button.sendAction(on: [.leftMouseDown, .rightMouseDown])
        }
        statusItem = item
        StatusItemTarget.shared.controller = self
        updateTitle()
    }

    public func destroy() {
        HelperLog.info("Tray", "Status item removed from system menu bar")
        dismissPopover()
        if let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
        }
        statusItem = nil
    }

    public func updateData(params: [String: Any]) {
        TrayModel.shared.update(from: params)
        // The account list has just changed. A filter entry naming an account that is no
        // longer offered is a dangling reference: drop it, so a Focus configured to keep
        // only that account on does not mute everything now that its target is gone.
        FocusFilterController.shared.prune(to: Set(TrayModel.shared.accounts.map(\.id)))
        HelperLog.info("Tray", "Updated tray data (\(TrayModel.shared.accounts.count) accounts, \(TrayModel.shared.totalUnread) unread)")
        updateTitle()

        // If popover is showing, also request fresh messages
        if let popover, popover.isShown {
            requestMessages()
        }
    }

    public func updateTitle() {
        guard let button = statusItem?.button else { return }

        let model = TrayModel.shared
        let withUnread = model.accounts.filter { $0.unreadCount > 0 }

        // An attributed title rather than emoji. The emoji dots exist in only a
        // handful of hues, so an account's hex colour had to be mapped onto the
        // nearest one: two accounts could collapse onto the same glyph, grey
        // rendered as white, and a colour outside the set had no glyph at all.
        // A bullet takes the account's exact colour, and the counts stay on
        // `labelColor` so they follow the menu bar's appearance without being
        // redrawn.
        let title = NSMutableAttributedString()

        func appendDot(_ hex: String) {
            title.append(NSAttributedString(string: "\u{25CF}", attributes: [
                .foregroundColor: NSColor(hex: hex),
                .font: NSFont.systemFont(ofSize: 9),
            ]))
        }

        func appendText(_ string: String) {
            title.append(NSAttributedString(string: string, attributes: [
                .foregroundColor: NSColor.labelColor,
                .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular),
            ]))
        }

        if model.showDots, model.showCount {
            for account in withUnread {
                appendText(title.length == 0 ? " " : "  ")
                appendDot(account.color)
                appendText(" \(account.unreadCount)")
            }
        } else if model.showDots {
            for account in withUnread {
                appendText(title.length == 0 ? " " : " ")
                appendDot(account.color)
            }
        } else if model.showCount, model.totalUnread > 0 {
            appendText(" \(model.totalUnread)")
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

    func makePopoverView() -> TrayPopoverView {
        TrayPopoverView(
            onCompose: { [weak self] accountId in
                var params: [String: Any] = [:]
                if let accountId, !accountId.isEmpty {
                    params["accountId"] = accountId
                }
                self?.transport?.sendEvent(method: "tray.compose", params: params)
                self?.dismissPopover()
            },
            onShowAccount: { [weak self] accountId in
                self?.transport?.sendEvent(method: "tray.showAccount", params: ["accountId": accountId])
                self?.dismissPopover()
            },
            onShowThread: { [weak self] accountId, threadId in
                self?.transport?.sendEvent(method: "tray.showThread", params: [
                    "accountId": accountId,
                    "threadId": threadId,
                ])
                self?.dismissPopover()
            },
            onThreadAction: { [weak self] accountId, threadId, action in
                self?.transport?.sendEvent(method: "tray.threadAction", params: [
                    "accountId": accountId,
                    "threadId": threadId,
                    "action": action.rawValue,
                ])
                // The popover stays up, unlike every other closure here. Triage
                // comes in runs — three newsletters off the top of the feed —
                // and dismissing after each one would mean reopening to reach
                // the next.
            },
            onOpenApp: { [weak self] in
                self?.transport?.sendEvent(method: "tray.showAccount", params: ["accountId": ""])
                self?.dismissPopover()
            },
            onSearch: { [weak self] query, accountId in
                var params: [String: Any] = ["query": query]
                if let accountId, !accountId.isEmpty {
                    params["accountId"] = accountId
                }
                self?.transport?.sendEvent(method: "tray.search", params: params)
                self?.dismissPopover()
            },
            onRefresh: { [weak self] in
                // The popover stays up: the point of a refresh is watching the list it
                // is already showing get newer.
                self?.transport?.sendEvent(method: "tray.refresh")
            },
            onOpenSettings: { [weak self] in
                self?.dismissPopover()
                // Through the main process, not `SettingsWindow.show` directly. The
                // settings live in Electron and this helper is restarted freely, so a
                // window opened here would show whatever the last `settings.show`
                // carried — the built-in defaults on a fresh helper. The round trip
                // comes back as `settings.show` with the current state attached.
                self?.transport?.sendEvent(method: "tray.openSettings")
            },
            onQuit: { [weak self] in
                self?.dismissPopover()
                self?.transport?.sendEvent(method: "tray.quit")
            },
            onUnreadOnlyChanged: { [weak self] unreadOnly in
                // The popover applies the filter to its own copy at once; this
                // persists it so the choice survives the popover and a restart.
                self?.transport?.sendEvent(method: "settings.changed", params: [
                    "key": "menuBarUnreadOnly",
                    "value": unreadOnly,
                ])
            }
        )
    }

    private func showPopover() {
        guard let button = statusItem?.button else { return }

        let pop = NSPopover()
        pop.behavior = .transient
        pop.animates = true
        pop.delegate = self

        let view = makePopoverView().environmentObject(TrayModel.shared)

        // The popover takes the size SwiftUI asks for, rather than holding a frame of
        // its own that the view then has to match. Height follows what is in the
        // popover, so a quiet inbox gets a short one instead of a void under its
        // banner, and it grows again as mail arrives while it is open.
        let host = NSHostingController(rootView: view)
        host.sizingOptions = [.preferredContentSize]
        pop.contentViewController = host
        popover = pop
        HelperLog.info("Tray", "Showing tray popover")
        pop.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)

        // Request messages from Electron for all accounts
        requestMessages()

        // The timer decides when mail is fetched, so what the popover shows on opening is
        // as old as the last tick. This asks for a poll on the way up.
        transport?.sendEvent(method: "tray.popoverOpened")
    }

    private func dismissPopover() {
        HelperLog.info("Tray", "Dismissing tray popover")
        popoverClosedTimestamp = CFAbsoluteTimeGetCurrent()
        popover?.performClose(nil)
        popover = nil
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

    private func requestMessages() {
        let accounts = TrayModel.shared.accounts
        for account in accounts {
            transport?.sendEvent(method: "tray.getMessages", params: ["accountId": account.id])
        }
    }

    public func updateMessages(accountId: String, messages: [[String: Any]]) {
        let parsed = messages.map { TrayMessage(from: $0) }
        DispatchQueue.main.async {
            TrayModel.shared.setMessages(accountId: accountId, incoming: parsed)
        }
    }
}

/// Target for the status item button action
@MainActor
private final class StatusItemTarget: NSObject {
    static let shared = StatusItemTarget()
    weak var controller: MenuBarController?

    @objc func togglePopover() {
        if let controller, CFAbsoluteTimeGetCurrent() - controller.popoverClosedTimestamp < 0.25 {
            return
        }
        controller?.togglePopover()
    }
}
