import AppKit
import HelperRPC
import UniformTypeIdentifiers
import UserNotifications

/// Renders a category symbol into something a banner can show.
///
/// macOS gives an app no say over a banner's icon — that is always the app's
/// own, and there is no API to override it per notification. An attachment is
/// the one channel that puts a per-notification image in the banner, which the
/// system draws as a thumbnail on the trailing edge.
///
/// The PNG is baked once per category and written afresh for every banner:
/// `UNNotificationAttachment` takes ownership of the file it is handed and
/// moves it into the system's own store, so one file on disk cannot serve two
/// notifications.
enum CategoryAttachment {
    /// The banner's background follows the appearance and the attachment is
    /// baked once, so the glyph is drawn in a mid grey that holds contrast
    /// against both rather than vanishing into one of them.
    private static let glyphColor = NSColor(white: 0.45, alpha: 1)

    /// Square, so symbols of different proportions — `person.2` is wide, `tag`
    /// is not — are all scaled to the same footprint by the time macOS gets them.
    private static let side: CGFloat = 64

    private static var pngCache: [MailCategory: Data] = [:]

    static func make(for category: MailCategory) -> UNNotificationAttachment? {
        guard let png = png(for: category) else { return nil }

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("magimail-\(category.rawValue)-\(UUID().uuidString).png")

        do {
            try png.write(to: url)
            return try UNNotificationAttachment(
                identifier: "category.\(category.rawValue)",
                url: url,
                options: [UNNotificationAttachmentOptionsTypeHintKey: UTType.png.identifier]
            )
        } catch {
            HelperLog.error("Notifications", "Category attachment failed: \(error)")
            try? FileManager.default.removeItem(at: url)
            return nil
        }
    }

    private static func png(for category: MailCategory) -> Data? {
        if let cached = pngCache[category] {
            return cached
        }
        guard let rendered = render(category) else { return nil }
        pngCache[category] = rendered
        return rendered
    }

    private static func render(_ category: MailCategory) -> Data? {
        // Hierarchical rather than a template drawn through a fill: the symbol
        // keeps its own optical weight, and the same route the tray's warning
        // icon takes.
        let config = NSImage.SymbolConfiguration(pointSize: 34, weight: .regular)
            .applying(.init(hierarchicalColor: glyphColor))

        guard let symbol = NSImage(
            systemSymbolName: category.symbolName,
            accessibilityDescription: category.title
        )?.withSymbolConfiguration(config) else {
            return nil
        }
        symbol.isTemplate = false

        let canvas = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            let size = symbol.size
            symbol.draw(in: NSRect(
                x: (rect.width - size.width) / 2,
                y: (rect.height - size.height) / 2,
                width: size.width,
                height: size.height
            ))
            return true
        }

        guard let tiff = canvas.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff)
        else {
            return nil
        }
        return rep.representation(using: .png, properties: [:])
    }
}
