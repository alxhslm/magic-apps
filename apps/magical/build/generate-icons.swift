// Rasterises apps/magical/build/icon.svg into icon.iconset, icon.icns and a
// 1024px icon.png. Run from the repo root: `swift apps/magical/build/generate-icons.swift`.
//
// A copy of Magimail's generator rather than a shared one: both are a page of
// Cocoa with a path at the top, and the day either app's artwork needs its own
// treatment, a shared script is the thing in the way.
//
// The dock tile's artwork is not generated here: DockTileBridge reads
// build/icon.svg itself at runtime. See `docs/magical/dock-icon.md`.
import Cocoa

let appDir = "apps/magical"
let currentDir = FileManager.default.currentDirectoryPath
let svgPath = URL(fileURLWithPath: "\(currentDir)/\(appDir)/build/icon.svg")
let iconsetDir = URL(fileURLWithPath: "\(currentDir)/\(appDir)/build/icon.iconset")
let png1024Path = URL(fileURLWithPath: "\(currentDir)/\(appDir)/build/icon.png")

try? FileManager.default.createDirectory(at: iconsetDir, withIntermediateDirectories: true)

guard var svg = try? String(contentsOfFile: svgPath.path, encoding: .utf8) else {
    print("Could not read \(svgPath.path)")
    exit(1)
}

// Strip text tags from base SVG for CoreSVG rendering so it only renders the shapes
svg = svg.replacingOccurrences(of: "<text id=\"cal-month-text-back\"[\\s\\S]*?<\\/text>", with: "", options: .regularExpression)
svg = svg.replacingOccurrences(of: "<text id=\"cal-month-text\"[\\s\\S]*?<\\/text>", with: "", options: .regularExpression)
svg = svg.replacingOccurrences(of: "<text id=\"cal-date-number\"[\\s\\S]*?<\\/text>", with: "", options: .regularExpression)

guard let svgData = svg.data(using: .utf8),
      let svgImage = NSImage(data: svgData)
else {
    print("Could not parse SVG")
    exit(1)
}

func renderPNG(image: NSImage, size: Int, destUrl: URL) {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!
    rep.size = NSSize(width: size, height: size)

    NSGraphicsContext.saveGraphicsState()
    let context = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = context
    let cg = context.cgContext

    // Scale the artwork so its body lands on Apple's icon grid: icon.svg's squircle
    // is inset to 448 of 512, Apple's body is 824 of 1024. See
    // `docs/shared/brand-and-icons.md#icon-pipeline` for the measurement.
    let appleBody = 824.0 / 1024.0
    let svgBody = 448.0 / 512.0
    let inset = (Double(size) * (1 - appleBody / svgBody)) / 2
    let bounds = NSRect(
        x: inset,
        y: inset,
        width: Double(size) - inset * 2,
        height: Double(size) - inset * 2
    )

    // Apple's template shadow, scaled to the size being rendered.
    let shadowScale = Double(size) / 1024.0
    cg.saveGState()
    cg.setShadow(
        offset: CGSize(width: 0, height: -10 * shadowScale),
        blur: 20 * shadowScale,
        color: NSColor(white: 0, alpha: 0.30).cgColor
    )
    cg.beginTransparencyLayer(auxiliaryInfo: nil)
    image.draw(
        in: bounds,
        from: NSRect(x: 0, y: 0, width: image.size.width, height: image.size.height),
        operation: .sourceOver,
        fraction: 1.0
    )
    cg.endTransparencyLayer()
    cg.restoreGState()

    // Draw native AppKit text with authentic SF Pro Display Heavy
    cg.saveGState()
    cg.translateBy(x: bounds.minX, y: bounds.minY)
    let s = bounds.width / 512.0
    cg.translateBy(x: 0, y: bounds.height)
    cg.scaleBy(x: s, y: -s)

    cg.translateBy(x: 32, y: 32)
    cg.scaleBy(x: 0.875, y: 0.875)

    cg.translateBy(x: 256, y: 256)
    cg.scaleBy(x: 0.96, y: 0.96)
    cg.translateBy(x: -256, y: -256)

    cg.translateBy(x: 256, y: 256)
    let angleInRadians = -2.5 * Double.pi / 180.0
    cg.rotate(by: CGFloat(angleInRadians))
    cg.translateBy(x: -170, y: -175)

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

    let monthFont = NSFont.systemFont(ofSize: 68, weight: .heavy)
    drawCenteredText(text: "AUG", font: monthFont, color: .white, centerX: 170, centerY: 72, letterSpacing: 2.0)

    let dateFont = NSFont.monospacedDigitSystemFont(ofSize: 182, weight: .heavy)
    let dateColor = NSColor(srgbRed: 15 / 255.0, green: 23 / 255.0, blue: 42 / 255.0, alpha: 1.0)
    drawCenteredText(text: "31", font: dateFont, color: dateColor, centerX: 170, centerY: 235, letterSpacing: -3.0)

    cg.restoreGState()
    NSGraphicsContext.restoreGraphicsState()

    if let pngData = rep.representation(using: .png, properties: [:]) {
        try? pngData.write(to: destUrl)
    }
}

let sizes: [(String, Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

for (name, size) in sizes {
    renderPNG(image: svgImage, size: size, destUrl: iconsetDir.appendingPathComponent(name))
}

renderPNG(image: svgImage, size: 1024, destUrl: png1024Path)

print("Iconset generated.")
