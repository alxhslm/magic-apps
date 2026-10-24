import AppKit

// Renders the SF Symbols the help pages name, so a reader can match a control
// by its glyph rather than by an identifier.
//
// Each file is an alpha mask, not a picture: the stylesheet fills it with the
// colour of the text around it, which is what lets one file serve both themes.
// See `website/README.md`'s Symbol glyphs.
//
// Usage: swift run --package-path tools/shots symbols <output-directory>

let outputDirectory = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : FileManager.default.currentDirectoryPath

/// File name, system symbol. The names the help pages mention, nothing else;
/// a glyph nobody references is a file that goes stale unnoticed.
let symbols: [(file: String, symbol: String)] = [
    ("tray", "tray"),
    ("tray-full", "tray.full"),
    ("circle-badge-plus", "circle.badge.plus"),
    ("calendar-badge-plus", "calendar.badge.plus"),
    ("filter", "line.3.horizontal.decrease.circle"),
    ("chevron-left", "chevron.left"),
    ("chevron-right", "chevron.right"),
    ("compose", "square.and.pencil"),
    ("reply", "arrowshape.turn.up.left"),
    ("reply-all", "arrowshape.turn.up.left.2"),
    ("forward", "arrowshape.turn.up.right"),
    ("archivebox", "archivebox"),
    ("trash", "trash"),
    ("envelope", "envelope"),
    ("printer", "printer"),
]

/// Large enough that the mask survives a Retina line of body text without
/// being resampled, and small enough that the whole set is a few kilobytes.
let pointSize: CGFloat = 40
let pixelsPerPoint: CGFloat = 3

for entry in symbols {
    let configuration = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .regular)
    guard
        let symbol = NSImage(systemSymbolName: entry.symbol, accessibilityDescription: nil)?
        .withSymbolConfiguration(configuration)
    else {
        print("missing: \(entry.symbol)")
        exit(1)
    }

    let size = symbol.size
    let width = Int((size.width * pixelsPerPoint).rounded())
    let height = Int((size.height * pixelsPerPoint).rounded())
    guard
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: width,
            pixelsHigh: height,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        )
    else {
        print("failed: \(entry.file)")
        exit(1)
    }
    rep.size = size

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    // The mask reads the alpha channel alone, so the ink colour is arbitrary;
    // black keeps the file legible if it is ever opened directly.
    NSColor.black.set()
    symbol.draw(
        in: CGRect(origin: .zero, size: size),
        from: .zero,
        operation: .sourceOver,
        fraction: 1
    )
    NSGraphicsContext.restoreGraphicsState()

    guard let png = rep.representation(using: .png, properties: [:]) else {
        print("failed: \(entry.file)")
        exit(1)
    }
    let path = outputDirectory + "/" + entry.file + ".png"
    do {
        try png.write(to: URL(fileURLWithPath: path))
    } catch {
        print("failed: \(entry.file) \(error)")
        exit(1)
    }
    print("\(entry.file).png  \(width)x\(height) px")
}
