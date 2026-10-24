import AppKit

// MARK: - Mouse Navigation Monitor

/// Native back/forward input, translated into one pair of actions.
///
/// macOS delivers a mouse's side buttons three different ways depending on the
/// mouse and its driver, and none of them reach the web view:
///
/// - A plain HID mouse sends `otherMouseDown`/`otherMouseUp` carrying button
///   number 3 (back) and 4 (forward). That is the numbering Chromium uses, so
///   it is also what Chrome itself acts on.
/// - A mouse using the HID consumer codes `AC_Back`/`AC_Forward` — a Logitech
///   mouse with no vendor software installed, for instance — arrives as a
///   `.swipe` event with `deltaX` of ±1. AppKit folds the trackpad's page swipe
///   into the same event, so one case covers both, and nothing in the event
///   distinguishes them.
/// - A driver that translates the buttons itself sends `.systemDefined` with
///   subtype `NX_SUBTYPE_AUX_MOUSE_BUTTONS` and the button in `data1`.
///
/// Chrome answers all three, but its gesture handling lives in Chrome's own
/// history swiper rather than in the content layer, so an Electron app inherits
/// none of it and has to translate the input for itself.
///
/// The monitor acts on release rather than press, matching both Chrome and the
/// AppKit convention for a click. One press is reported on up to three of the
/// paths at once — a Logitech mouse sends `otherMouseUp` and then an aux-button
/// release, a few milliseconds apart — so the first report navigates and the
/// rest of the group is dropped.
@MainActor
public final class MouseNavigationMonitor {
    public enum Direction {
        case back
        case forward
    }

    /// Which inputs this app answers with a navigation.
    public struct Sources: OptionSet, Sendable {
        public let rawValue: Int

        public init(rawValue: Int) {
            self.rawValue = rawValue
        }

        /// A mouse's back and forward buttons.
        public static let sideButtons = Sources(rawValue: 1 << 0)
        /// A trackpad swipe, whether macOS reports it as a swipe event or as a scroll
        /// gesture carrying phases.
        public static let trackpad = Sources(rawValue: 1 << 1)
        /// A sideways wheel notch, which arrives as a scroll gesture with no phase.
        public static let wheel = Sources(rawValue: 1 << 2)

        public static let all: Sources = [.sideButtons, .trackpad, .wheel]
    }

    /// Adopted by the app: Magimail leaves the wheel alone, Magical the side buttons.
    public var sources: Sources = .all

    /// `NX_SUBTYPE_AUX_MOUSE_BUTTONS`, spelled out because AppKit exposes it to
    /// Objective-C only.
    private static let auxMouseButtonSubtype = NSEvent.EventSubtype(rawValue: 7)

    /// How close two reports have to be to count as one press. The duplicate
    /// reports of a single press arrive within a few milliseconds; two
    /// deliberate taps land further apart than this.
    private static let coalesceInterval: TimeInterval = 0.15

    private let onNavigate: (Direction, Sources) -> Void
    private var monitor: Any?
    private var lastNavigation: Date?

    // MARK: - Trackpad and wheel gestures

    /// Accumulated travel of the scroll gesture in flight, in points.
    private var travelledX: CGFloat = 0
    private var travelledY: CGFloat = 0
    /// Whether this gesture has been claimed, and its events are consumed from here on.
    private var ownsGesture = false
    /// Whether the gesture in flight is a trackpad's, which is what its phases say.
    private var fromTrackpad = false
    private var wheelEnd: Timer?

    /// How far a gesture must travel before it is a swipe rather than a scroll.
    private static let swipeTravel: CGFloat = 16
    /// How much more horizontal than vertical that travel must be.
    private static let swipeRatio: CGFloat = 2.5
    /// How long a wheel with no phases has to be quiet before its gesture ends.
    private static let wheelQuiet: TimeInterval = 0.2

    public init(onNavigate: @escaping (Direction, Sources) -> Void) {
        self.onNavigate = onNavigate
    }

    deinit {
        // AppKit keeps the block until the token is removed, and the block holds
        // only a weak `self`, so a monitor released without this would leave a
        // registration behind that consumes side-button presses forever.
        if let monitor {
            NSEvent.removeMonitor(monitor)
        }
    }

    /// Watch `window` until `remove()` or the next `install(for:)`.
    ///
    /// A local monitor sees an event before the responder chain does, and
    /// returning nil consumes it, so the same press cannot also reach the web
    /// view or Electron's own `swipe` event.
    public func install(for window: NSWindow) {
        remove()
        monitor = NSEvent.addLocalMonitorForEvents(
            matching: [.otherMouseDown, .otherMouseUp, .swipe, .systemDefined, .scrollWheel]
        ) { [weak self, weak window] event in
            guard let self, let window,
                  event.window === window || (event.window == nil && NSApp.keyWindow === window)
            else { return event }
            return handle(event)
        }
    }

    public func remove() {
        wheelEnd?.invalidate()
        wheelEnd = nil
        guard let monitor else { return }
        NSEvent.removeMonitor(monitor)
        self.monitor = nil
    }

    /// nil consumes the event; the event itself lets it continue.
    private func handle(_ event: NSEvent) -> NSEvent? {
        switch event.type {
        case .otherMouseDown:
            // Consumed without acting: the release is what navigates, as it is
            // in Chrome. Consumed even where this app ignores the buttons, or Chromium
            // would answer them itself.
            return direction(forButton: event.buttonNumber) == nil ? event : nil

        case .otherMouseUp:
            guard let direction = direction(forButton: event.buttonNumber) else { return event }
            guard sources.contains(.sideButtons) else { return nil }
            navigate(direction, source: .sideButtons)
            return nil

        case .swipe:
            guard sources.contains(.trackpad),
                  let direction = direction(forDeltaX: event.deltaX)
            else { return event }
            navigate(direction, source: .trackpad)
            return nil

        case .scrollWheel:
            return handleScrollWheel(event)

        case .systemDefined:
            guard event.subtype == Self.auxMouseButtonSubtype,
                  let direction = direction(forAuxButton: event.data1)
            else { return event }
            // `data1` names the button and `data2` carries its state, so the
            // release is the event with `data2` back at zero.
            if event.data2 == 0, sources.contains(.sideButtons) {
                navigate(direction, source: .sideButtons)
            }
            return nil

        default:
            return event
        }
    }

    /// Recognises a horizontal swipe from a scroll gesture, which is how macOS delivers
    /// one on the "Scroll left and right with two fingers" setting.
    ///
    /// The page cannot see where such a gesture ends: it is told about wheel events and
    /// nothing else, and a fling keeps sending them for about a second after the fingers
    /// come off, so two quick swipes read as one. Here the phases say outright when the
    /// hand left the trackpad, and a wheel notch, which carries no phase, ends on quiet.
    private func handleScrollWheel(_ event: NSEvent) -> NSEvent? {
        // The tail of a fling: the page keeps coasting, the reader's hand is not moving.
        if event.momentumPhase != [] {
            return ownsGesture ? nil : event
        }

        travelledX += event.scrollingDeltaX
        travelledY += event.scrollingDeltaY
        fromTrackpad = event.phase != []
        if !ownsGesture, isHorizontalSwipe, sources.contains(fromTrackpad ? .trackpad : .wheel) {
            ownsGesture = true
        }

        if event.phase == [] {
            // A wheel notch: no phases to go by, so the gesture ends when they stop.
            wheelEnd?.invalidate()
            wheelEnd = Timer.scheduledTimer(withTimeInterval: Self.wheelQuiet, repeats: false) {
                [weak self] _ in
                // The run loop this timer is scheduled on is the main one.
                MainActor.assumeIsolated { self?.endScrollGesture() }
            }
        } else if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
            endScrollGesture()
        }

        return ownsGesture ? nil : event
    }

    /// Whether the travel so far is a swipe rather than a scroll.
    private var isHorizontalSwipe: Bool {
        let horizontal = abs(travelledX)
        return horizontal >= Self.swipeTravel && horizontal > abs(travelledY) * Self.swipeRatio
    }

    private func endScrollGesture() {
        wheelEnd?.invalidate()
        wheelEnd = nil

        let travelled = travelledX
        let owned = ownsGesture
        let isTrackpad = fromTrackpad
        travelledX = 0
        travelledY = 0
        ownsGesture = false
        fromTrackpad = false

        guard owned else { return }
        // Straight out, without the coalescing the mouse paths need: a gesture is
        // reported once, and its end is exact. A sideways scroll is positive towards the
        // right, and that swipe goes back, whichever device produced it.
        onNavigate(travelled > 0 ? .back : .forward, isTrackpad ? .trackpad : .wheel)
    }

    private func navigate(_ direction: Direction, source: Sources) {
        let now = Date()
        if let lastNavigation, now.timeIntervalSince(lastNavigation) <= Self.coalesceInterval {
            return
        }
        lastNavigation = now
        onNavigate(direction, source)
    }

    private func direction(forButton buttonNumber: Int) -> Direction? {
        switch buttonNumber {
        case 3: .back
        case 4: .forward
        default: nil
        }
    }

    private func direction(forDeltaX deltaX: CGFloat) -> Direction? {
        // A swipe towards the right goes back, as it does in Chrome and Safari, and a
        // `swipe` event reports that one with a positive delta — the HID consumer codes
        // `AC_Back` and `AC_Forward` arrive the same way round.
        if deltaX >= 0.5 {
            return .back
        }
        if deltaX <= -0.5 {
            return .forward
        }
        return nil
    }

    private func direction(forAuxButton data1: Int) -> Direction? {
        switch data1 {
        case 1 << 3: .back
        case 1 << 4: .forward
        default: nil
        }
    }
}
