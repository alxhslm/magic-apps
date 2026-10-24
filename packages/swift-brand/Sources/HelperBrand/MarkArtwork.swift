import AppKit

/// The two marks, and the one place either is defined.
///
/// `BrandMark` and `MenuBarGlyph` both come here, and each chooses only a width
/// and whether the result is a template image. The artwork is a compiled-in
/// string rather than a bundled `.svg`: the helper ships as a bare executable and
/// the widget extension links this package into an `.appex`, so neither wants a
/// resource bundle for two files.
enum MarkArtwork {
    static func definition(of kind: BrandMarkKind) -> BrandMarkDefinition {
        switch kind {
        case .magimail: Envelope.definition
        case .magical: Calendar.definition
        }
    }
}

/// Magimail's mark: the envelope, and the magic star on its top-left corner.
private enum Envelope {
    static let boxWidth: CGFloat = 36
    /// 36 x 30 on a Retina display, 18 x 15 without one.
    ///
    /// The box is centred on the envelope outline alone, without the star. The
    /// star's tips reach a little outside it and are clipped; at 0.7 of a device
    /// pixel, it is not missed.
    static let boxHeight: CGFloat = 30

    /// There is no even width near the 2.215 the old box worked out at, so the
    /// outline gives up 0.108pt of weight to land on 2. Magical's card follows
    /// it; the two share a line weight.
    ///
    /// The flap, the seams and the star are diagonal or curved. Nothing about the
    /// grid helps them, so they keep the weights they were drawn with.
    static let strokeWidth: CGFloat = 2

    /// TRADEMARK NOTE: a generic postal envelope. It must never reintroduce
    /// Gmail's trade dress: no thick vertical red side pillars, and no thick red
    /// "V" folds forming the letter "M".
    static let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 \(boxWidth) \(boxHeight)" width="\(boxWidth)" height="\(boxHeight)">
      <!-- Envelope, open at the top left where the star sits: moving one means
           moving the other. Its four straight runs are on whole units, and it
           spans 5 to 31 across and 6 to 24 down, which is the box's own centre. -->
      <path d="M 16 6 L 28 6 A 3 3 0 0 1 31 9 L 31 21 A 3 3 0 0 1 28 24 \
    L 8 24 A 3 3 0 0 1 5 21 L 5 12"
            fill="none" stroke="#C05A4E" stroke-width="\(strokeWidth)" stroke-linecap="round" stroke-linejoin="round" />
      <!-- The flap, folding down to the middle of the face -->
      <path d="M 30.46 8.58 L 19.25 16.95 A 1.66 1.66 0 0 1 16.75 16.95 L 10.94 12.49"
            fill="none" stroke="#C05A4E" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
      <!-- Seams running up from the bottom corners -->
      <line x1="5.95" y1="22.81" x2="14.54" y2="15.56" stroke="#C05A4E" stroke-width="1.5" stroke-linecap="round" />
      <line x1="30.05" y1="22.81" x2="21.46" y2="15.56" stroke="#C05A4E" stroke-width="1.5" stroke-linecap="round" />
      <!-- The magic star. Top left because the dock badge covers the top right. -->
      <path d="M 6 -0.7 Q 6 6 12.7 6 Q 6 6 6 12.7 Q 6 6 -0.7 6 Q 6 6 6 -0.7 Z"
            fill="#EBC24A" />
    </svg>
    """

    static let definition = BrandMarkDefinition(
        boxWidth: boxWidth,
        boxHeight: boxHeight,
        strokeWidth: strokeWidth,
        svg: svg
    )
}

/// Magical's mark: the calendar card, and the sparkles on its top-left corner.
private enum Calendar {
    static let boxWidth: CGFloat = 36
    /// 36 x 39 on a Retina display, 18 x 19.5 without one.
    ///
    /// 39 rather than 30: a line-drawn calendar covers less of its box than
    /// Magimail's envelope covers its own, so matching the box sizes left this
    /// mark looking the smaller of the two.
    ///
    /// The box is centred on the card alone, without the sparkles or the binders.
    ///
    /// Keep the frame under the 22pt status button while changing these: 39 units
    /// renders 19.5pt tall, and a box past 44 would render over 22pt and AppKit
    /// would shrink the whole glyph to fit.
    static let boxHeight: CGFloat = 39

    /// 2 units is 1pt at the width the mark is drawn, and Magimail's envelope is
    /// the same: the pair share a line weight, not a `stroke-width`, and both
    /// boxes are now 36 wide so here the two agree.
    static let strokeWidth: CGFloat = 2

    /// The separator is the card's other horizontal run and needs the grid just
    /// as much, so it takes the same width. It used to be lighter than the
    /// outline; there is no even width between 2 and nothing.
    static let separatorWidth: CGFloat = 2

    static let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 \(boxWidth) \(boxHeight)" width="\(boxWidth)" height="\(boxHeight)">
      <!-- Two sparkles rather than three, and both larger: at 16pt the third read
           as a speck and took size off the other two. -->
      <path d="M 7.9 4.67 Q 7.9 8.6 11.83 8.6 Q 7.9 8.6 7.9 12.53 Q 7.9 8.6 3.97 8.6 Q 7.9 8.6 7.9 4.67 Z"
            fill="#FBBF24" />
      <path d="M 10.15 2.05 Q 10.15 4.34 12.44 4.34 Q 10.15 4.34 10.15 6.63 Q 10.15 4.34 7.86 4.34 Q 10.15 4.34 10.15 2.05 Z"
            fill="#F59E0B" />

      <!-- Calendar card, a little wider than tall so it reads at the size of
           Magimail's envelope. Open at the top-left, where the sparkles sit.
           Its straight runs are on whole units, and it spans 6 to 30 across and
           8 to 31 down, which is the box's own centre. -->
      <path d="M 13 8 L 26 8 A 4 4 0 0 1 30 12 L 30 27 A 4 4 0 0 1 26 31 \
    L 10 31 A 4 4 0 0 1 6 27 L 6 16"
            fill="none" stroke="#2563EB" stroke-width="\(strokeWidth)" stroke-linecap="round" stroke-linejoin="round" />
      <line x1="6" y1="16" x2="30" y2="16"
            stroke="#2563EB" stroke-width="\(separatorWidth)" stroke-linecap="round" />
      <!-- Ring binder hangers, centred on the card as binder rings are -->
      <line x1="14" y1="4.5" x2="14" y2="11"
            stroke="#2563EB" stroke-width="\(strokeWidth)" stroke-linecap="round" />
      <line x1="22" y1="4.5" x2="22" y2="11"
            stroke="#2563EB" stroke-width="\(strokeWidth)" stroke-linecap="round" />
    </svg>
    """

    static let definition = BrandMarkDefinition(
        boxWidth: boxWidth,
        boxHeight: boxHeight,
        strokeWidth: strokeWidth,
        svg: svg
    )
}
