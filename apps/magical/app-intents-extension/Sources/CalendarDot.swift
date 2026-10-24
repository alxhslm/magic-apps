import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: - Calendar Dot

/// A filled circle in a calendar's own colour, as PNG data.
///
/// Drawn for the Focus filter's picker and for each widget's own, which is why it sits in a
/// file of its own; the widget extension compiles the same source.
///
/// A picker takes an image per row and nothing else; there is no tint to set, so the
/// colour has to be drawn. It is the same language the menu bar popover's filter uses, and
/// the reason a list of nine calendars is scannable there rather than nine lines of text.
///
/// Drawn with Core Graphics rather than `NSImage`: this runs in a sandboxed extension whose
/// only job is to answer a picker, and AppKit is a large thing to load for one circle.
///
/// `aspect` is the width of the canvas relative to its height, and exists because the two
/// places these rows appear scale the image differently. A list behind a Choose button
/// keeps the image square, so a square canvas draws a circle. Rows rendered inline in the
/// filter sheet stretch it to a frame about half again as wide as it is tall, which turns
/// a square canvas into an obvious ellipse; a canvas already in the frame's aspect, with
/// the circle centred in it, comes out round.
enum CalendarDot {
    /// Measured from the inline rows in the Focus filter sheet.
    static let inlineRowAspect = 1.5

    static func png(hex: String, height: Int = 48, aspect: Double = 1) -> Data? {
        let (red, green, blue) = components(hex: hex)
        let size = height
        let width = Int((Double(height) * aspect).rounded())
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return nil
        }

        context.setFillColor(red: red, green: green, blue: blue, alpha: 1)
        // Inset, so the circle is not clipped by the bitmap's own edge once scaled, and
        // centred, so a canvas wider than it is tall leaves equal transparent margins.
        let inset = CGFloat(size) * 0.1
        let diameter = CGFloat(size) - inset * 2
        context.fillEllipse(in: CGRect(
            x: (CGFloat(width) - diameter) / 2,
            y: inset,
            width: diameter,
            height: diameter
        ))

        guard let image = context.makeImage() else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            out, UTType.png.identifier as CFString, 1, nil
        ) else {
            return nil
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return out as Data
    }

    /// `#rrggbb`, which is what `accounts.json` holds. An unparseable value falls back to
    /// Google's own default blue rather than to no dot, so one bad colour cannot leave a
    /// single row looking like a different kind of thing.
    private static func components(hex: String) -> (CGFloat, CGFloat, CGFloat) {
        var value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("#") {
            value.removeFirst()
        }
        guard value.count == 6, let rgb = UInt32(value, radix: 16) else {
            return (0x03 / 255, 0x9B / 255, 0xE5 / 255)
        }
        return (
            CGFloat((rgb >> 16) & 0xFF) / 255,
            CGFloat((rgb >> 8) & 0xFF) / 255,
            CGFloat(rgb & 0xFF) / 255
        )
    }
}
