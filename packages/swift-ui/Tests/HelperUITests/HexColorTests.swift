import AppKit
@testable import HelperUI
import SwiftUI
import Testing

@Suite("Hex colour")
struct HexColorTests {
    @Test func parsesSixDigitHex() throws {
        let colour = NSColor(hex: "#3b82f6").usingColorSpace(.sRGB)
        #expect(colour != nil)
        #expect(try Int((#require(colour?.redComponent) * 255).rounded()) == 0x3B)
        #expect(try Int((#require(colour?.greenComponent) * 255).rounded()) == 0x82)
        #expect(try Int((#require(colour?.blueComponent) * 255).rounded()) == 0xF6)
    }

    @Test func acceptsAHashlessString() {
        #expect(NSColor(hex: "3b82f6").hexString == "#3b82f6")
    }

    @Test func roundTripsThroughHexString() {
        for hex in ["#000000", "#ffffff", "#3b82f6", "#a855f7", "#78716c"] {
            #expect(NSColor(hex: hex).hexString == hex)
        }
    }

    @Test func colourMatchesItsNSColorForm() {
        #expect(NSColor(Color(hex: "#22c55e")).hexString == "#22c55e")
    }

    @Test func fallsBackToGreyWhenUnreadable() {
        // A row offering a wrong-but-visible swatch is better than one that throws
        // while the user is mid-rename.
        #expect(NSColor(hex: "").hexString == "#808080")
        #expect(NSColor(hex: "#12345").hexString == "#808080")
        #expect(NSColor(hex: "#zzzzzz").hexString == "#808080")
    }
}
