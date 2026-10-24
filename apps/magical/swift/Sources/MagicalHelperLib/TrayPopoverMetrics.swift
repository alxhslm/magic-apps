import AppKit
import Foundation
import HelperUI
import SwiftUI

// MARK: - Account Dot

/// Non-template colored circle representing the account source color inside native controls.
public enum AccountDot {
    public static let diameter: CGFloat = 9
    public static let ringStroke: CGFloat = 1.5

    /// Non-template so AppKit draws the real colour rather than tinting it to match the control.
    public static func image(hex: String, filled: Bool = true) -> NSImage {
        let image = NSImage(
            size: NSSize(width: diameter, height: diameter),
            flipped: false
        ) { rect in
            NSColor(hex: hex).setFill()
            NSColor(hex: hex).setStroke()

            if filled {
                NSBezierPath(ovalIn: rect).fill()
            } else {
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

// MARK: - Popover Metrics

/// The popover's size, in one place so the `NSPopover` and the SwiftUI view inside it cannot
/// disagree about it. They did: the window was sized from a measurement and the view pinned itself
/// to a constant, which left the window wider than what it held.
public enum TrayPopoverMetrics {
    public static let defaultWidth: CGFloat = 340
    public static let collapsedHeight: CGFloat = 492
    public static let expandedHeight: CGFloat = 672

    public static func height(isCalendarCollapsed: Bool) -> CGFloat {
        isCalendarCollapsed ? collapsedHeight : expandedHeight
    }
}

// MARK: - Account Bar

/// A solid vertical bar in an account's colour, for the menu bar title.
///
/// Drawn rather than written as a box-drawing character. A glyph is sized by the font and
/// hinted like text, so `│` comes out a hairline at menu bar size and `▌` comes out a
/// block; neither is a bar of a chosen width. Non-template, so AppKit draws the real
/// colour instead of tinting it to match the menu bar.
public enum AccountBar {
    public static let width: CGFloat = 3
    public static let height: CGFloat = 11

    /// Drawn as a capsule, which is what the popover's cards use for the same rule,
    /// and what the system draws a bar of this size as.
    public static func image(hex: String) -> NSImage {
        let image = NSImage(size: NSSize(width: width, height: height), flipped: false) { rect in
            NSColor(hex: hex).setFill()
            NSBezierPath(roundedRect: rect, xRadius: width / 2, yRadius: width / 2).fill()
            return true
        }
        image.isTemplate = false
        return image
    }
}

// MARK: - Menu Bar Title Metrics

/// The widths the status item's title is laid out against.
///
/// The status item keeps `variableLength`, so anything that changes width drags every item
/// to the left of it along. The countdown is the only part that changes while nobody has
/// touched anything, so it is the only part held to a width.
public enum MenuBarTitle {
    public static let font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)

    /// The width the countdown is held at, measured from its longest reading. The title
    /// counts down to an event later today, so the hours never reach three digits, and the
    /// font is monospaced-digit, so which digits they are does not change the width.
    public static let countdownWidth: CGFloat = width(of: "00h 00m")

    public static func width(of string: String) -> CGFloat {
        (string as NSString).size(withAttributes: [.font: font]).width
    }

    /// An image inlined in the title, centred on the capitals of the words beside it.
    ///
    /// An attachment is placed from the baseline up, so a bar taller than the
    /// capitals has to be dropped below the baseline by half the difference to
    /// come out level with them. A fixed 2pt drop overhung them by 1.75pt below and
    /// 0.38pt above, which reads as the bar having slipped. Taking the offset from
    /// the font keeps the two centred on each other if the title's font ever
    /// changes.
    ///
    /// The rule lives here rather than in the controller so the bar and the
    /// spacers that stand in for it place an image the same way.
    public static func attachment(_ image: NSImage, width: CGFloat) -> NSTextAttachment {
        let attachment = NSTextAttachment()
        attachment.image = image
        attachment.bounds = CGRect(
            x: 0,
            y: (font.capHeight - AccountBar.height) / 2,
            width: width,
            height: AccountBar.height
        )
        return attachment
    }

    /// A transparent run of a measured width, for holding a column open.
    public static func spacer(width: CGFloat) -> NSImage {
        let image = NSImage(
            size: NSSize(width: width, height: AccountBar.height),
            flipped: false
        ) { _ in true }
        image.isTemplate = false
        return image
    }
}
