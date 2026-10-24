import AppKit

// MARK: - Account switcher

/// The multi-account switcher in the toolbar, as a real `NSSegmentedControl`.
///
/// This deliberately uses the AppKit control rather than a hosted SwiftUI view.
/// A hosted view gets no chrome of its own: on macOS 26 (Tahoe) the system wraps
/// a toolbar item's view in Liquid Glass and tints the active control, which
/// made a bare `HStack` of buttons read as a segmented control, but on Sequoia
/// and earlier nothing is drawn behind it and the switcher rendered as loose
/// labels in the titlebar. Painting that chrome ourselves would then have to
/// chase every appearance the system supports. `NSSegmentedControl` tracks all
/// of them for free, along with keyboard traversal and accessibility.
///
/// The trade-off is that a segment is not a view — it is one image plus one
/// plain-string label, with no attributed text and no badge API. So the
/// red unread pill becomes plain `(N)` text in the label, unread presence is
/// folded into the colour dot (filled vs ring), and the shortcut moves to the
/// tooltip.
public final class AccountSegmentedControl: NSSegmentedControl {
    private var accountIds: [String] = []
    public var showUnreadCounts: Bool = true
    /// The app's toolbar strings, pushed with the other labels. The warning icon's
    /// accessibility description and the account tooltips are built from them.
    public var labels = ToolbarLabels()

    public convenience init(showUnreadCounts: Bool = true) {
        self.init(frame: .zero)
        self.showUnreadCounts = showUnreadCounts
        segmentStyle = .automatic
        trackingMode = .selectOne
        segmentDistribution = .fit
        target = self
        action = #selector(handleSelection)
    }

    /// Rebuilds the segments in place. Called on every account update, including
    /// unread-count changes, so it must not replace the control itself.
    public func configure(accounts: [ToolbarAccount], activeAccountId: String) {
        accountIds = accounts.map(\.id)
        segmentCount = accounts.count

        for (index, account) in accounts.enumerated() {
            let name = displayName(account)
            setLabel(Self.label(for: account, name: name, showUnread: showUnreadCounts), forSegment: index)
            let image = account.needsAuth
                ? warningIcon()
                : Self.dot(
                    hex: account.color,
                    filled: account.unreadCount > 0,
                    dimmed: account.excludedByFocus
                )
            setImage(image, forSegment: index)
            setImageScaling(.scaleNone, forSegment: index)
            setToolTip(tooltip(for: account, name: name, index: index, showUnread: showUnreadCounts), forSegment: index)
            // A disabled segment is greyed *by* being unselectable, which is
            // exactly the intent here: the account stays in the switcher so you
            // can see it exists and why you cannot open it. De-emphasis cannot
            // use this -- it would make the account unreachable -- so that is
            // carried by the dimmed dot instead.
            setEnabled(!account.disabledByFocus, forSegment: index)
        }

        if let active = accountIds.firstIndex(of: activeAccountId) {
            selectedSegment = active
        }

        sizeToFit()
    }

    @objc private func handleSelection() {
        guard accountIds.indices.contains(selectedSegment) else { return }
        ActionBridge.emit("switchAccount", accountIds[selectedSegment])
    }

    /// The account's name, or the catalogue's fallback when the payload carried
    /// none. Both apps always send a name, so this is a broken-payload guard.
    private func displayName(_ account: ToolbarAccount) -> String {
        account.name.isEmpty ? labels[ToolbarLabelKey.accountUnknown] : account.name
    }

    /// The shortcut is repeated here only for hover discovery; the Accounts
    /// menu is the canonical surface, where macOS renders the key equivalent
    /// itself.
    private func tooltip(for account: ToolbarAccount, name: String, index: Int, showUnread: Bool) -> String {
        let shortcut = index < 9 ? " (⌘\(index + 1))" : ""
        if account.needsAuth {
            return labels.format(
                ToolbarLabelKey.accountSignInRequired,
                ["name": name, "shortcut": shortcut]
            )
        }
        guard showUnread else {
            return "\(name)\(shortcut)"
        }
        switch account.unreadCount {
        case 0:
            return labels.format(
                ToolbarLabelKey.accountNoUnread,
                ["name": name, "shortcut": shortcut]
            )
        case 1:
            return labels.format(
                ToolbarLabelKey.accountOneUnread,
                ["name": name, "shortcut": shortcut]
            )
        default:
            return labels.format(
                ToolbarLabelKey.accountUnread,
                ["name": name, "count": String(account.unreadCount), "shortcut": shortcut]
            )
        }
    }

    private static func label(for account: ToolbarAccount, name: String, showUnread: Bool) -> String {
        if account.needsAuth || !showUnread || account.unreadCount <= 0 {
            return name
        }
        let count = account.unreadCount > 99 ? "99+" : "\(account.unreadCount)"
        return "\(name) (\(count))"
    }

    /// Native SF Symbol warning mark for accounts requiring sign-in.
    private func warningIcon() -> NSImage {
        let config = NSImage.SymbolConfiguration(pointSize: 9.5, weight: .semibold)
            .applying(.init(hierarchicalColor: NSColor.systemOrange))
        if let sym = NSImage(
            systemSymbolName: "exclamationmark.triangle.fill",
            accessibilityDescription: labels[ToolbarLabelKey.signInRequired]
        ) {
            let configured = sym.withSymbolConfiguration(config) ?? sym
            configured.isTemplate = false
            return configured
        }
        return Self.dot(hex: "#f59e0b", filled: true)
    }

    /// Identity and unread state in one mark: the account's colour always,
    /// filled when mail is waiting and a ring when it is not. Both states are
    /// painted in fixed colours, so unlike a bitmap that borrows system
    /// colours this never has to be redrawn when the appearance changes.
    ///
    /// Non-template so AppKit draws the real colour rather than tinting it to
    /// match the control, which is what a segmented `Picker` would do.
    /// `dimmed` is how an account excluded by a Focus Filter reads: the same
    /// mark at reduced opacity, so it recedes without disappearing and without
    /// inventing a second visual language. Text cannot carry this -- a segment
    /// label is a plain string with no attributed form -- so the dot does.
    public static func dot(hex: String, filled: Bool, dimmed: Bool = false) -> NSImage {
        let diameter = dotDiameter
        let image = NSImage(
            size: NSSize(width: diameter, height: diameter),
            flipped: false
        ) { rect in
            let color = dimmed
                ? NSColor(hex: hex).withAlphaComponent(dimmedAlpha)
                : NSColor(hex: hex)
            color.setStroke()
            color.setFill()

            if filled {
                NSBezierPath(ovalIn: rect).fill()
            } else {
                // Inset by half the stroke so the ring stays inside the bounds.
                let stroke = ringStroke
                let path = NSBezierPath(ovalIn: rect.insetBy(dx: stroke / 2, dy: stroke / 2))
                path.lineWidth = stroke
                path.stroke()
            }
            return true
        }
        image.isTemplate = false
        return image
    }

    private static let dotDiameter: CGFloat = 9
    private static let ringStroke: CGFloat = 1.5
    private static let dimmedAlpha: CGFloat = 0.35
}

// MARK: - Color from Hex

public extension NSColor {
    convenience init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let scanner = Scanner(string: hex)
        var rgb: UInt64 = 0
        scanner.scanHexInt64(&rgb)
        self.init(
            srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}
