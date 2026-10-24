import AppKit
import SwiftUI

// The suite's one hex colour parser and formatter.
//
// `#rrggbb` is how the main process stores an account's colour, so both
// helpers need to read one and write one back. The two apps had their own
// copies: one parsed for `NSColor` and never validated, the other validated
// for `Color` and fell back to grey. This is the union of the two — the
// validating parser, on the `NSColor` form, with `Color` delegating to it so
// the tooltip, the tray and the settings swatch cannot disagree about a colour.

public extension NSColor {
    /// Parses `#rrggbb`. An unreadable string falls back to mid grey rather than
    /// failing the whole row that carries it.
    convenience init(hex: String) {
        let cleaned = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard cleaned.count == 6, let value = UInt32(cleaned, radix: 16) else {
            self.init(srgbRed: 0.5, green: 0.5, blue: 0.5, alpha: 1)
            return
        }
        self.init(
            srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }

    /// `#rrggbb`, which is what the main process stores.
    ///
    /// Converted to sRGB first: a colour chosen through `ColorPicker` can arrive
    /// in any colour space, and reading components from one that is not RGB
    /// raises.
    var hexString: String {
        guard let rgb = usingColorSpace(.sRGB) else { return "#808080" }
        let channel = { (value: CGFloat) in Int((value * 255).rounded()) }
        return String(
            format: "#%02x%02x%02x",
            channel(rgb.redComponent),
            channel(rgb.greenComponent),
            channel(rgb.blueComponent)
        )
    }
}

public extension Color {
    /// Delegates so the module has a single hex parser. `AccountDot` needs the
    /// `NSColor` form to draw into an `NSImage`; everything SwiftUI wants the
    /// `Color` form.
    init(hex: String) {
        self.init(nsColor: NSColor(hex: hex))
    }
}
