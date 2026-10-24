import Cocoa
import WebKit

let currentDir = FileManager.default.currentDirectoryPath
let svgPath = URL(fileURLWithPath: "\(currentDir)/apps/magimail/build/icon.svg")
let iconsetDir = URL(fileURLWithPath: "\(currentDir)/apps/magimail/build/icon.iconset")
let icnsPath = URL(fileURLWithPath: "\(currentDir)/apps/magimail/build/icon.icns")
let png1024Path = URL(fileURLWithPath: "\(currentDir)/apps/magimail/build/icon.png")

try? FileManager.default.createDirectory(at: iconsetDir, withIntermediateDirectories: true)

guard let svgData = try? Data(contentsOf: svgPath),
      let svgImage = NSImage(data: svgData)
else {
    print("Failed to load SVG data directly, trying WebKit renderer...")
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
    image.draw(in: bounds,
               from: NSRect(x: 0, y: 0, width: image.size.width, height: image.size.height),
               operation: .sourceOver,
               fraction: 1.0)
    cg.endTransparencyLayer()
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
    let outUrl = iconsetDir.appendingPathComponent(name)
    renderPNG(image: svgImage, size: size, destUrl: outUrl)
}

// Write 1024x1024 png
renderPNG(image: svgImage, size: 1024, destUrl: png1024Path)

print("Iconset generated successfully.")
