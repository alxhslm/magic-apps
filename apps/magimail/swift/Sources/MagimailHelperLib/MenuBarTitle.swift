import AppKit
import HelperUI

/// One account's contribution to the status item.
///
/// Kept apart from `TrayAccount` so the title's geometry can be built and
/// measured without a whole tray payload.
struct MenuBarAccount {
    let name: String
    let color: String
    let unreadCount: Int
    let needsAuth: Bool
}

/// Builds the status item's attributed title.
///
/// Every reading draws one mark per account, in account list order, so the
/// title's width is a function of the account count and the display setting,
/// never of the unread counts. That is what stops a read in the popover from
/// moving the glyph and the popover anchored to it. A count crossing 99 is the
/// one growth left: the cell reserves two digits and then takes a third rather
/// than truncating the number.
enum MenuBarTitle {
    /// Matches the status item's existing number font, which is also the line
    /// the attachments are placed against.
    static let font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)

    static let dotDiameter: CGFloat = 6
    static let dotRingStroke: CGFloat = 1
    static let dotGap: CGFloat = 1.5
    static let glyphGap: CGFloat = 3
    static let numberGap: CGFloat = 3
    private static let quietOpacity: CGFloat = 0.35
    /// Two digits are what the cell reserves; `9+` used to cost the same two
    /// characters, so showing the exact count costs nothing extra.
    private static let numberCellDigits = 2

    static func attributed(
        display: MenuBarUnreadDisplay,
        accounts: [MenuBarAccount]
    ) -> NSAttributedString {
        switch display {
        case .nothing:
            NSAttributedString()
        case .dots:
            dots(accounts)
        case .numbers:
            numbers(accounts)
        }
    }

    static func width(display: MenuBarUnreadDisplay, accounts: [MenuBarAccount]) -> CGFloat {
        attributed(display: display, accounts: accounts).size().width
    }

    /// The glyph may be the only thing with an accessibility label, because the
    /// title is meant to be read at a glance rather than by VoiceOver. Name the
    /// accounts that are waiting, and say when one is waiting for a sign-in
    /// instead of carrying a trustworthy count.
    static func accessibilityDescription(accounts: [MenuBarAccount]) -> String {
        guard !accounts.isEmpty else { return "Magimail, no accounts" }

        let waiting = accounts.filter { $0.unreadCount > 0 && !$0.needsAuth }
        let signIn = accounts.filter(\.needsAuth)
        if waiting.isEmpty, signIn.isEmpty {
            return "Magimail, no unread mail"
        }

        var parts = waiting.map { "\($0.name) \($0.unreadCount) unread" }
        parts += signIn.map { "\($0.name) needs sign-in" }
        return "Magimail, " + parts.joined(separator: ", ")
    }

    private static func dots(_ accounts: [MenuBarAccount]) -> NSAttributedString {
        guard !accounts.isEmpty else { return NSAttributedString() }

        let title = NSMutableAttributedString()
        title.append(spacer(glyphGap))
        for (index, account) in accounts.enumerated() {
            // A stale count behind an expired session is not a mark of waiting
            // mail, so it takes the ring like a quiet inbox.
            let filled = account.unreadCount > 0 && !account.needsAuth
            let image = AccountDot.image(
                hex: account.color,
                filled: filled,
                diameter: dotDiameter,
                ringStroke: dotRingStroke
            )
            let dot = attachment(image, width: dotDiameter, height: dotDiameter)
            title.append(NSAttributedString(attachment: dot))
            if index < accounts.count - 1 {
                title.append(spacer(dotGap))
            }
        }
        return title
    }

    private static func numbers(_ accounts: [MenuBarAccount]) -> NSAttributedString {
        let title = NSMutableAttributedString()
        for account in accounts {
            // A zero is not information: it is what keeps the account's cell
            // visible, so a lone number still has a position that means
            // something. Same for an account whose count cannot be trusted.
            let count = account.needsAuth ? 0 : account.unreadCount
            let quiet = count == 0
            let digits = String(count)
            // A figure space is one digit wide in a monospaced-digit font, where an
            // ordinary space is narrower and would make 9 narrower than 99. It also
            // keeps the three-digit case growing to the right rather than leftwards
            // into the previous cell, which a right-aligned tab stop would do.
            let padding = String(
                repeating: "\u{2007}",
                count: max(0, numberCellDigits - digits.count)
            )
            let colour = NSColor(hex: account.color)
                .withAlphaComponent(quiet ? quietOpacity : 1)
            title.append(NSAttributedString(
                string: padding + digits,
                attributes: [
                    .font: font,
                    .foregroundColor: colour,
                ]
            ))
            // A spacer rather than a space: the measured cell is two digits plus
            // 3pt, and an ordinary space is 3.375pt, which would make every
            // account 0.375pt wider than the widths the docs state.
            title.append(spacer(numberGap))
        }
        return title
    }

    /// An image inlined in the title, centred on the capitals of the line beside
    /// it. An attachment sits from the baseline up, so a dot shorter than the
    /// capitals has to be lifted by half the difference to come out level with
    /// them. This is the rule Magical uses for its account bar.
    private static func attachment(
        _ image: NSImage,
        width: CGFloat,
        height: CGFloat
    ) -> NSTextAttachment {
        let attachment = NSTextAttachment()
        attachment.image = image
        attachment.bounds = CGRect(
            x: 0,
            y: (font.capHeight - height) / 2,
            width: width,
            height: height
        )
        return attachment
    }

    private static func spacer(_ width: CGFloat) -> NSAttributedString {
        let image = NSImage(
            size: NSSize(width: width, height: dotDiameter),
            flipped: false
        ) { _ in true }
        image.isTemplate = false
        let attachment = attachment(image, width: width, height: dotDiameter)
        return NSAttributedString(attachment: attachment)
    }
}
