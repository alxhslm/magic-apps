import AppKit
@testable import HelperBrand
import Testing

@Suite("Brand artwork")
struct BrandArtworkTests {
    /// Both marks are drawn 18pt wide, and the height is always taken from the
    /// box. A height picked anywhere else squashes one of them.
    @Test func everyMarkDrawsEighteenPointsWide() throws {
        for kind in BrandMarkKind.allCases {
            let image = try #require(BrandMark(kind).image())
            #expect(abs(image.size.width - 18) < 0.0001)
            #expect(abs(image.size.height - 18 / BrandMark(kind).aspectRatio) < 0.0001)
        }
    }

    /// One box unit is one device pixel, and both boxes are 36 across. The two
    /// glyphs share a line weight only while they share a width, because the
    /// stroke is set in box units; a box of another width would break the pair.
    @Test func bothBoxesAreThirtySixUnitsAcross() {
        for kind in BrandMarkKind.allCases {
            #expect(MarkArtwork.definition(of: kind).boxWidth == 36)
        }
        #expect(
            MarkArtwork.definition(of: .magimail).strokeWidth
                == MarkArtwork.definition(of: .magical).strokeWidth
        )
    }

    /// Magical's card covers less of its box than Magimail's envelope covers its
    /// own, so its box is taller: matching the heights left the card looking the
    /// smaller of the two.
    @Test func theTallerBoxIsMagicals() {
        #expect(
            MarkArtwork.definition(of: .magical).boxHeight
                > MarkArtwork.definition(of: .magimail).boxHeight
        )
    }

    /// Only the menu bar asks for a template image. A template keeps nothing but
    /// the alpha, which would flatten the brands' colours in the popover and the
    /// widgets to one tint.
    @Test func onlyTheMenuBarGlyphIsATemplateImage() throws {
        let glyph = try #require(MenuBarGlyph(.magimail).statusItemImage())
        #expect(glyph.isTemplate)
        let mark = try #require(BrandMark(.magimail).image())
        #expect(!mark.isTemplate)
    }

    @Test func statusItemSizeFollowsTheBox() {
        for kind in BrandMarkKind.allCases {
            let size = MenuBarGlyph(kind).size
            #expect(abs(size.width - 18) < 0.0001)
            #expect(abs(size.height - 18 / BrandMark(kind).aspectRatio) < 0.0001)
        }
    }

    /// A mark whose SVG does not parse rasterises to nil, which is a blank menu
    /// bar and an empty widget header rather than a drawn one.
    @Test func bothMarksRasterise() {
        for kind in BrandMarkKind.allCases {
            #expect(BrandMark(kind).image() != nil)
            #expect(MenuBarGlyph(kind).statusItemImage() != nil)
        }
    }

    /// The two marks are different artwork, so picking the wrong kind draws the
    /// other app's icon rather than its own.
    @Test func theTwoMarksAreDifferentArtwork() {
        #expect(
            MarkArtwork.definition(of: .magimail).svg
                != MarkArtwork.definition(of: .magical).svg
        )
    }

    /// The menu bar glyph is the one surface `tools/shots` never draws — a status
    /// item lives in the system's bar, not in a window a shot can host — so this
    /// is the only check that it puts ink there at all.
    ///
    /// It is also where "one box unit is one device pixel" is checkable: at 18pt on
    /// a Retina display the rasterised box must come out exactly the box, which is
    /// what keeps the mark sharp in a widget.
    @MainActor
    @Test func everyGlyphRasterisesToItsBox() throws {
        for kind in BrandMarkKind.allCases {
            let definition = MarkArtwork.definition(of: kind)
            let image = try #require(MenuBarGlyph(kind).statusItemImage())
            let ink = try #require(inkBounds(of: image))

            // On a Retina display the rasterised box matches boxWidth/boxHeight;
            // on non-Retina / headless CI it matches the rounded 1x image size.
            #expect(ink.width == Int(definition.boxWidth) || ink.width == Int(image.size.width.rounded()))
            #expect(ink.height == Int(definition.boxHeight) || ink.height == Int(image.size.height.rounded()))

            // Some ink, so a path that no longer parses is a failure rather than a
            // blank status item.
            #expect(ink.count > 0)
            #expect(ink.inkWidth > ink.width / 2)
            #expect(ink.inkHeight > ink.height / 2)

            // And a transparent margin: the box is bigger than the artwork, which
            // is what keeps the mark centred against the title's capitals.
            #expect(ink.maxX < ink.width - 1)
            #expect(ink.maxY < ink.height - 1)
        }
    }

    private struct Ink {
        let width: Int
        let height: Int
        let count: Int
        let maxX: Int
        let maxY: Int

        var inkWidth: Int {
            maxX + 1
        }

        var inkHeight: Int {
            maxY + 1
        }
    }

    /// Rasterises `image` at the size it claims and reads the drawn pixels out of
    /// it, or `nil` when the image rasterises to nothing.
    @MainActor
    private func inkBounds(of image: NSImage) -> Ink? {
        var proposed = CGRect(origin: .zero, size: image.size)
        guard let cgImage = image.cgImage(forProposedRect: &proposed, context: nil, hints: nil) else {
            return nil
        }

        let width = cgImage.width
        let height = cgImage.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        var count = 0, maxX = -1, maxY = -1
        for y in 0 ..< height {
            for x in 0 ..< width where pixels[(y * width + x) * 4 + 3] > 8 {
                count += 1
                maxX = max(maxX, x)
                maxY = max(maxY, y)
            }
        }
        return Ink(width: width, height: height, count: count, maxX: maxX, maxY: maxY)
    }
}
