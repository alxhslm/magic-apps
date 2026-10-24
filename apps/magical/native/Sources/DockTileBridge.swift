import AppKit
import Darwin

// MARK: - Dock tile base artwork

/// The base artwork — the squircle, wand, stars, card and rings, with the fixed
/// `AUG 31` taken back off — read from `build/icon.svg` at runtime.
///
/// The dylib is a bare `.dylib` with no bundle of its own, so there is no
/// `Bundle.module` to hand. `Bundle.main` is the host application, and under
/// `pnpm dev` that is Electron's own bundle, which holds neither file. The image
/// this code was loaded from is the one place that answers both cases, so the
/// lookup starts there and reads `icon.svg` beside it (`Contents/Resources` in the
/// packaged app); in development it walks up to the app's `build/`. See
/// `docs/magical/dock-icon.md#the-artwork-at-runtime`.
enum DockTileBaseArtwork {
    private static let textElement =
        #"<text id="cal-(?:month-text-back|month-text|date-number)"[\s\S]*?</text>"#

    static let image: NSImage? = {
        guard let url = svgUrl(),
              let svg = try? String(contentsOf: url, encoding: .utf8)
        else { return nil }
        return NSImage(data: Data(stripFixedDate(from: svg).utf8))
    }()

    /// The directory this dylib was loaded from.
    private static func loadedImageDirectory() -> URL? {
        // RTLD_DEFAULT (-2) searches every image already loaded, and this dylib is
        // one of them by the time the tile first draws.
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "dock_tile_update_date")
        else { return nil }
        var info = Dl_info()
        guard dladdr(symbol, &info) != 0, let name = info.dli_fname else { return nil }
        return URL(fileURLWithPath: String(cString: name)).deletingLastPathComponent()
    }

    private static func svgUrl() -> URL? {
        guard let directory = loadedImageDirectory() else { return nil }
        let beside = directory.appendingPathComponent("icon.svg")
        if FileManager.default.fileExists(atPath: beside.path) {
            return beside
        }

        // Development: the dylib lives in `native/.build/<config>/`, a few levels
        // below the app, which is where `build/icon.svg` is.
        var candidate = directory
        for _ in 0 ..< 6 {
            candidate.deleteLastPathComponent()
            let svg = candidate.appendingPathComponent("build/icon.svg")
            if FileManager.default.fileExists(atPath: svg.path) {
                return svg
            }
        }
        return nil
    }

    /// Removes the three `<text>` elements so the tile draws today's date over the
    /// card rather than the fixed one the `.icns` carries.
    private static func stripFixedDate(from svg: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: textElement) else { return svg }
        let range = NSRange(svg.startIndex ..< svg.endIndex, in: svg)
        return regex.stringByReplacingMatches(in: svg, range: range, withTemplate: "")
    }
}

// MARK: - Magical Dock Tile View

final class MagicalDockTileView: NSView {
    var dayText: String = ""
    var monthText: String = ""

    private static let baseImage: NSImage? = DockTileBaseArtwork.image

    /// The application icon as the Dock itself draws it, or nil when this process is not
    /// running out of the packaged app.
    ///
    /// macOS 26 gives every application icon a glass treatment: it masks the artwork to the
    /// squircle, lights the top-left edge, shades the one opposite and lays down the drop
    /// shadow. The treatment reaches the icon the bundle declares and nothing else. Neither
    /// `NSApp.applicationIconImage` nor anything drawn into `dockTile.contentView` gets it,
    /// so a tile painting its own artwork stands beside the static icon at a visibly
    /// different depth. Asking the workspace for the bundle's icon hands the artwork back
    /// already treated, which is the only way to get the treatment onto the tile at all.
    ///
    /// Read afresh on every draw rather than cached, because the treatment follows the Icon
    /// & Widget Style the user picks in System Settings.
    private static var treatedAppIcon: NSImage? {
        // In development the process runs out of Electron's own bundle, whose icon is not
        // Magical's. `icon.icns` belongs to the packaged app, so its absence means the
        // artwork `DockTileBaseArtwork` reads is the only honest source.
        guard Bundle.main.url(forResource: "icon", withExtension: "icns") != nil else { return nil }
        return NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)
    }

    override var isFlipped: Bool {
        false
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let context = NSGraphicsContext.current else { return }
        let cg = context.cgContext

        // The tile fills its Dock slot, but an app icon does not, so the artwork sits on
        // Apple's grid exactly as build/generate-icons.swift puts it for the .icns. The
        // tile stands in for that icon, so the two have to agree. See
        // `docs/magical/dock-icon.md#apples-icon-grid-and-its-shadow`.
        let appleBody = 824.0 / 1024.0
        let svgBody = 448.0 / 512.0
        let margin = (1 - appleBody / svgBody) / 2
        let tile = bounds.insetBy(dx: bounds.width * margin, dy: bounds.height * margin)

        let appIcon = Self.treatedAppIcon

        // 1. The squircle, wand, stars, card and rings.
        if let appIcon {
            // Already on Apple's grid and already carrying the drop shadow, so it fills the
            // whole slot rather than the inset the raw artwork needs.
            appIcon.draw(
                in: bounds,
                from: NSRect(origin: .zero, size: appIcon.size),
                operation: .sourceOver,
                fraction: 1.0
            )
        } else if let baseImage = Self.baseImage {
            let shadowScale = bounds.width / 1024.0
            cg.saveGState()
            cg.setShadow(
                offset: CGSize(width: 0, height: -10 * shadowScale),
                blur: 20 * shadowScale,
                color: NSColor(white: 0, alpha: 0.30).cgColor
            )
            cg.beginTransparencyLayer(auxiliaryInfo: nil)
            baseImage.draw(
                in: tile,
                from: NSRect(origin: .zero, size: baseImage.size),
                operation: .sourceOver,
                fraction: 1.0
            )
            cg.endTransparencyLayer()
            cg.restoreGState()
        }

        // 2. The transform onto the calendar card, matching the SVG's 512x512 canvas and
        // the nested groups it draws the card inside.
        let s = tile.width / 512.0
        let angleInRadians = -2.5 * Double.pi / 180.0
        var toCard = CGAffineTransform(translationX: tile.minX, y: tile.maxY)
            .scaledBy(x: s, y: -s)
            // Group 1: squircle inset
            .translatedBy(x: 32, y: 32)
            .scaledBy(x: 0.875, y: 0.875)
        toCard = toCard
            // Group 2: card scale (0.96)
            .translatedBy(x: 256, y: 256)
            .scaledBy(x: 0.96, y: 0.96)
            .translatedBy(x: -256, y: -256)
            // Group 3: card rotation and position
            .translatedBy(x: 256, y: 256)
            .rotated(by: CGFloat(angleInRadians))
            .translatedBy(x: -170, y: -175)

        // 3. Take the fixed date off the card the bundle icon carries, by redrawing the
        // artwork over it. Only the month and the numeral differ between the two; every
        // other pixel comes from the same `build/icon.svg`, so the two agree either side
        // of the clip.
        //
        // The clip costs the treatment inside itself. Nothing is lost, because the
        // treatment is an edge effect: differencing the raw .icns against the treated icon
        // puts all of it within 60 of the body edge on a 1024 canvas, and this rect stops
        // more than 80 short of every edge.
        if appIcon != nil, let baseImage = Self.baseImage {
            let card = CGRect(x: -30, y: -30, width: 400, height: 400).applying(toCard)
            cg.saveGState()
            cg.clip(to: card)
            baseImage.draw(
                in: tile,
                from: NSRect(origin: .zero, size: baseImage.size),
                operation: .sourceOver,
                fraction: 1.0
            )
            cg.restoreGState()
        }

        // 4. Today's date, on the card the artwork just cleared.
        cg.saveGState()
        cg.concatenate(toCard)

        func drawCenteredText(text: String, font: NSFont, color: NSColor, centerX: CGFloat, centerY: CGFloat, letterSpacing: CGFloat = 0) {
            cg.saveGState()
            cg.translateBy(x: centerX, y: centerY)
            cg.scaleBy(x: 1.0, y: -1.0)

            let style = NSMutableParagraphStyle()
            style.alignment = .center

            var attrs: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: color,
                .paragraphStyle: style,
            ]
            if letterSpacing != 0 {
                attrs[.kern] = letterSpacing
            }

            let astr = NSAttributedString(string: text, attributes: attrs)
            let strSize = astr.size()
            let capHeight = font.capHeight
            let baselineOffset = font.ascender - capHeight / 2
            let drawY = -baselineOffset

            let rect = NSRect(
                x: -strSize.width / 2,
                y: drawY,
                width: strSize.width,
                height: strSize.height
            )
            astr.draw(in: rect)
            cg.restoreGState()
        }

        // Month text: 68pt heavy, white, tracking 2.0, centered in header
        if !monthText.isEmpty {
            let monthFont = NSFont.systemFont(ofSize: 68, weight: .heavy)
            drawCenteredText(text: monthText, font: monthFont, color: .white, centerX: 170, centerY: 72, letterSpacing: 2.0)
        }

        // Date text: 182pt heavy tabular figures, dark slate (#0f172a), tracking -3.0, centered on white paper (y=235)
        if !dayText.isEmpty {
            let dateFont = NSFont.monospacedDigitSystemFont(ofSize: 182, weight: .heavy)
            let dateColor = NSColor(srgbRed: 15 / 255.0, green: 23 / 255.0, blue: 42 / 255.0, alpha: 1.0)
            drawCenteredText(text: dayText, font: dateFont, color: dateColor, centerX: 170, centerY: 235, letterSpacing: -3.0)
        }

        cg.restoreGState()
    }
}

// MARK: - C-callable Bridge Functions

@_cdecl("dock_tile_update_date")
public func dockTileUpdateDate(day: Int32, month: UnsafePointer<CChar>, dayOfWeek _: UnsafePointer<CChar>?) {
    let m = String(cString: month)
    DispatchQueue.main.async {
        let dockTile = NSApplication.shared.dockTile
        let view: MagicalDockTileView
        if let existing = dockTile.contentView as? MagicalDockTileView {
            view = existing
        } else {
            view = MagicalDockTileView(
                frame: NSRect(x: 0, y: 0, width: dockTile.size.width, height: dockTile.size.height)
            )
            dockTile.contentView = view
        }
        view.dayText = "\(day)"
        view.monthText = m.uppercased()
        view.needsDisplay = true
        dockTile.display()
    }
}

@_cdecl("dock_tile_update_svg")
public func dockTileUpdateSvg(svgXml _: UnsafePointer<CChar>) {
    // Retained for ABI compatibility
}

@_cdecl("dock_tile_set_badge")
public func dockTileSetBadge(badge: UnsafePointer<CChar>?) {
    let b = badge != nil ? String(cString: badge!) : nil
    DispatchQueue.main.async {
        let dockTile = NSApplication.shared.dockTile
        dockTile.badgeLabel = (b?.isEmpty == false) ? b : nil
        dockTile.display()
    }
}
