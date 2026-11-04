import AppKit
import Foundation
import MagicalHelperLib
import SuiteNative
import SwiftUI

// MARK: - Sidebar Manager (AppKit Host)

@MainActor
public final class SidebarManager {
    public static let shared = SidebarManager()

    public private(set) weak var window: NSWindow?
    private var visualEffectView: NSVisualEffectView?
    private var hostingView: NSHostingView<SidebarRootView>?
    private var trailingConstraint: NSLayoutConstraint?
    private var topConstraint: NSLayoutConstraint?
    private var windowCloseObserver: Any?
    private var scrollMonitor: Any?
    private var accumulatedScrollDeltaX: CGFloat = 0
    private var lastSwipeTime: TimeInterval = 0
    private var lastScrollTime: TimeInterval = 0

    public var isVisible: Bool = true
    public let cardWidth: CGFloat = 324
    public let margin: CGFloat = 8
    public let topMargin: CGFloat = 8
    public let cornerRadius: CGFloat = 10
    public let calendarMinWidth: CGFloat = 980
    public var minRequiredWidth: CGFloat {
        calendarMinWidth + cardWidth + margin * 2
    } // 1320
    public var width: CGFloat {
        cardWidth + margin * 2
    } // 340

    public init() {
        SidebarModel.shared.onAction = { action, value in
            ActionBridge.emit(action, value)
        }
    }

    public func attach(to window: NSWindow) {
        self.window = window
        guard let contentView = window.contentView else { return }

        // Remove old visual effect view if from another window or detached
        if let existing = visualEffectView, existing.window !== window || existing.superview !== contentView {
            existing.removeFromSuperview()
            visualEffectView = nil
            hostingView = nil
            trailingConstraint = nil
            topConstraint = nil
        }

        if let obs = windowCloseObserver {
            NotificationCenter.default.removeObserver(obs)
            windowCloseObserver = nil
        }
        windowCloseObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if let monitor = self.scrollMonitor {
                    NSEvent.removeMonitor(monitor)
                    self.scrollMonitor = nil
                }
                self.accumulatedScrollDeltaX = 0
                self.visualEffectView?.removeFromSuperview()
                self.visualEffectView = nil
                self.hostingView = nil
                self.trailingConstraint = nil
                self.topConstraint = nil
                self.window = nil
            }
        }

        if scrollMonitor == nil {
            scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                guard let self else { return event }
                return handleScrollWheel(event)
            }
        }

        if visualEffectView == nil {
            let effect = NSVisualEffectView(frame: .zero)
            effect.material = .sidebar
            effect.blendingMode = .behindWindow
            effect.state = .followsWindowActiveState
            effect.translatesAutoresizingMaskIntoConstraints = false
            effect.wantsLayer = true
            effect.layer?.cornerRadius = cornerRadius
            effect.layer?.cornerCurve = .continuous
            effect.layer?.masksToBounds = true
            effect.layer?.borderWidth = 1.0
            effect.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.35).cgColor

            let host = NSHostingView(rootView: SidebarRootView())
            host.translatesAutoresizingMaskIntoConstraints = false
            effect.addSubview(host)

            NSLayoutConstraint.activate([
                host.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
                host.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
                host.topAnchor.constraint(equalTo: effect.topAnchor),
                host.bottomAnchor.constraint(equalTo: effect.bottomAnchor),
            ])

            contentView.addSubview(effect, positioned: .above, relativeTo: nil)

            let toolbarHeight: CGFloat = 52
            let initialTrailing: CGFloat = isVisible ? -margin : (cardWidth + margin * 2)
            let trailingC = effect.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: initialTrailing)
            trailingConstraint = trailingC

            let topC = effect.topAnchor.constraint(equalTo: contentView.topAnchor, constant: toolbarHeight + topMargin)
            topConstraint = topC

            NSLayoutConstraint.activate([
                effect.widthAnchor.constraint(equalToConstant: cardWidth),
                topC,
                effect.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -margin),
                trailingC,
            ])

            visualEffectView = effect
            hostingView = host
            effect.alphaValue = isVisible ? 1.0 : 0.0
            effect.isHidden = !isVisible

            applyTransparency()
        }

        window.minSize = NSSize(width: isVisible ? minRequiredWidth : calendarMinWidth, height: 600)
        if isVisible, window.frame.size.width < minRequiredWidth {
            var frame = window.frame
            frame.size.width = minRequiredWidth
            window.setFrame(frame, display: true, animate: false)
        }
    }

    public func setTransparency(_ transparent: Bool, isDark: Bool) {
        SidebarModel.shared.transparentBackground = transparent
        SidebarModel.shared.isDarkMode = isDark
        applyTransparency()
    }

    private func applyTransparency() {
        guard let effect = visualEffectView else { return }
        if SidebarModel.shared.transparentBackground {
            effect.material = .sidebar
            effect.blendingMode = .behindWindow
            effect.state = .followsWindowActiveState
        } else {
            effect.material = .underWindowBackground
            effect.state = .inactive
        }
    }

    private var lastExpandedDelta: CGFloat = 0

    @discardableResult
    public func setVisible(_ visible: Bool, animated: Bool) -> Double {
        guard isVisible != visible else { return 0 }
        isVisible = visible
        SidebarModel.shared.isVisible = visible

        guard let effect = visualEffectView, let trailingC = trailingConstraint else { return 0 }

        if visible {
            effect.isHidden = false
        }

        var targetFrame: NSRect? = nil
        var animatingDelta: CGFloat = 0

        if visible, let window {
            let currentWidth = window.frame.size.width
            if currentWidth < minRequiredWidth {
                let delta = minRequiredWidth - currentWidth
                lastExpandedDelta = delta
                animatingDelta = delta
                var frame = window.frame
                let targetWindowWidth = minRequiredWidth
                if let screen = window.screen ?? NSScreen.main {
                    let maxRight = screen.visibleFrame.maxX
                    if frame.origin.x + targetWindowWidth > maxRight {
                        frame.origin.x = max(screen.visibleFrame.minX, maxRight - targetWindowWidth)
                    }
                }
                frame.size.width = targetWindowWidth
                targetFrame = frame
            } else {
                lastExpandedDelta = 0
            }
        } else if !visible, let window {
            // Lower minSize first so AppKit permits shrinking the window
            window.minSize = NSSize(width: calendarMinWidth, height: 600)
            let delta = lastExpandedDelta > 0 ? lastExpandedDelta : (minRequiredWidth - calendarMinWidth)
            var frame = window.frame
            if frame.size.width <= minRequiredWidth + 2 {
                animatingDelta = delta
                let targetWindowWidth = max(calendarMinWidth, frame.size.width - delta)
                frame.size.width = targetWindowWidth
                targetFrame = frame
            }
            lastExpandedDelta = 0
        }

        let targetTrailing: CGFloat
        if visible {
            targetTrailing = -margin
            if animatingDelta > 0 {
                // Window is expanding from W to W + delta.
                // Setting pre-expansion trailing to (animatingDelta - margin) keeps the card's visual
                // X constant at (calendarMinWidth + margin), seamlessly revealing it as the window opens.
                trailingC.constant = animatingDelta - margin
                effect.alphaValue = 0.0
                window?.contentView?.layoutSubtreeIfNeeded()
            } else {
                trailingC.constant = cardWidth + margin
                effect.alphaValue = 0.0
                window?.contentView?.layoutSubtreeIfNeeded()
            }
        } else {
            if animatingDelta > 0 {
                targetTrailing = animatingDelta - margin
            } else {
                targetTrailing = cardWidth + margin
            }
        }

        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.25
                context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                context.allowsImplicitAnimation = true
                trailingC.animator().constant = targetTrailing
                effect.animator().alphaValue = visible ? 1.0 : 0.0
                if let targetFrame, let window {
                    window.animator().setFrame(targetFrame, display: true)
                }
            } completionHandler: { [weak self] in
                guard let self else { return }
                if let window {
                    window.minSize = NSSize(width: visible ? minRequiredWidth : calendarMinWidth, height: 600)
                }
                if !visible {
                    effect.isHidden = true
                }
            }
        } else {
            trailingC.constant = targetTrailing
            effect.alphaValue = visible ? 1.0 : 0.0
            effect.isHidden = !visible
            if let targetFrame, let window {
                window.setFrame(targetFrame, display: true, animate: false)
            }
            if let window {
                window.minSize = NSSize(width: visible ? minRequiredWidth : calendarMinWidth, height: 600)
            }
        }

        return targetFrame != nil ? Double(targetFrame!.width) : 0.0
    }

    public func updateData(json: String) {
        guard let data = json.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }

        SidebarModel.shared.trayModel.update(from: dict)
        SidebarModel.shared.recomputeWeekDays()
    }

    public func setViewMode(mode: String, anchorDateStr: String?) {
        let viewMode: SidebarViewMode = switch mode.lowercased() {
        case "customday", "custom_days", "fourday", "four_day", "4day", "4_day":
            .fourDay
        case "week", "customweek", "custom_weeks":
            .week
        case "day":
            .day
        case "month", "year", "agenda", "schedule", "fantastical":
            .fantastical
        default:
            .day
        }

        // No anchor in the report means Calendar changed view without changing date, so
        // the sidebar keeps the range it already follows rather than falling back to today.
        var anchor: Date?
        if let str = anchorDateStr, !str.isEmpty {
            let df = DateFormatter()
            df.dateFormat = "yyyy-MM-dd"
            df.timeZone = .current
            anchor = df.date(from: str)
        }

        SidebarModel.shared.setViewMode(viewMode, anchor: anchor, timeframe: mode)
    }

    public func setScrollPosition(
        hour: CGFloat,
        hourHeight: CGFloat,
        gridTop: CGFloat,
        gridHeight: CGFloat,
        cardTop: CGFloat
    ) {
        let toolbarHeight: CGFloat = 52
        let targetTop = toolbarHeight + topMargin
        if let topC = topConstraint, abs(topC.constant - targetTop) > 0.5 {
            topC.constant = targetTop
        }
        SidebarModel.shared.setScrollPosition(
            hour: hour,
            hourHeight: hourHeight,
            gridTop: gridTop,
            gridHeight: gridHeight,
            cardTop: cardTop
        )
    }

    // MARK: - Event Monitoring & Gesture Handling

    func handleScrollWheel(_ event: NSEvent) -> NSEvent? {
        guard isVisible,
              let effect = visualEffectView,
              !effect.isHidden,
              let window,
              event.window === window,
              let contentView = window.contentView
        else {
            return event
        }

        let pointInContent = contentView.convert(event.locationInWindow, from: nil)
        guard effect.frame.contains(pointInContent) else {
            return event
        }

        let deltaX = event.scrollingDeltaX
        let deltaY = event.scrollingDeltaY
        let absX = abs(deltaX)
        let absY = abs(deltaY)

        let isHorizontal = absX > absY && absX > 1.5

        if isHorizontal {
            let mode = SidebarModel.shared.viewMode
            if mode == .week || mode == .fourDay {
                let now = ProcessInfo.processInfo.systemUptime
                if now - lastScrollTime > 0.3 {
                    accumulatedScrollDeltaX = 0
                }
                lastScrollTime = now

                // Only accumulate active user swipes, ignoring momentum flings
                if event.momentumPhase.isEmpty {
                    let effectiveDeltaX = event.isDirectionInvertedFromDevice ? deltaX : -deltaX
                    accumulatedScrollDeltaX += effectiveDeltaX

                    let threshold: CGFloat = 28.0
                    if accumulatedScrollDeltaX <= -threshold {
                        if now - lastSwipeTime >= 0.12 {
                            lastSwipeTime = now
                            accumulatedScrollDeltaX = 0
                            withAnimation(.easeInOut(duration: 0.2)) {
                                SidebarModel.shared.selectNextDay()
                            }
                        }
                    } else if accumulatedScrollDeltaX >= threshold, now - lastSwipeTime >= 0.12 {
                        lastSwipeTime = now
                        accumulatedScrollDeltaX = 0
                        withAnimation(.easeInOut(duration: 0.2)) {
                            SidebarModel.shared.selectPreviousDay()
                        }
                    }
                }
            }

            if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
                accumulatedScrollDeltaX = 0
            }

            // In ALL view modes: consume the horizontal scroll event by returning nil
            // so horizontal gestures over the sidebar NEVER trigger horizontal scrolling in
            // Google Calendar or back/forward navigation in the web view.
            return nil
        }

        if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
            accumulatedScrollDeltaX = 0
        }

        // Vertical gestures return unchanged so timeline scrolling and two-way sync operate smoothly
        return event
    }
}

// MARK: - C Cdecl Exports for Node Addon

@_cdecl("sidebar_attach")
public func sidebarAttach(_ nsViewPtr: UnsafeMutableRawPointer) {
    let contentView = Unmanaged<NSView>.fromOpaque(nsViewPtr).takeUnretainedValue()
    if Thread.isMainThread {
        MainActor.assumeIsolated {
            if let window = contentView.window {
                SidebarManager.shared.attach(to: window)
            }
        }
    } else {
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                if let window = contentView.window {
                    SidebarManager.shared.attach(to: window)
                }
            }
        }
    }
}

@_cdecl("sidebar_set_visible")
public func sidebarSetVisible(_ visible: Bool, _ animated: Bool) -> Double {
    if Thread.isMainThread {
        return MainActor.assumeIsolated {
            SidebarManager.shared.setVisible(visible, animated: animated)
        }
    } else {
        var result: Double = 0
        DispatchQueue.main.sync {
            MainActor.assumeIsolated {
                result = SidebarManager.shared.setVisible(visible, animated: animated)
            }
        }
        return result
    }
}

@_cdecl("sidebar_update_data")
public func sidebarUpdateData(_ json: UnsafePointer<CChar>) {
    let str = String(cString: json)
    DispatchQueue.main.async {
        SidebarManager.shared.updateData(json: str)
    }
}

@_cdecl("sidebar_set_view_mode")
public func sidebarSetViewMode(_ modePtr: UnsafePointer<CChar>, _ anchorPtr: UnsafePointer<CChar>?) {
    let mode = String(cString: modePtr)
    let anchor: String? = anchorPtr != nil ? String(cString: anchorPtr!) : nil
    DispatchQueue.main.async {
        SidebarManager.shared.setViewMode(mode: mode, anchorDateStr: anchor)
    }
}

@_cdecl("sidebar_set_transparency")
public func sidebarSetTransparency(_ transparent: Bool, _ isDark: Bool) {
    DispatchQueue.main.async {
        SidebarManager.shared.setTransparency(transparent, isDark: isDark)
    }
}

@_cdecl("sidebar_set_scroll_position")
public func sidebarSetScrollPosition(
    _ hour: Double,
    _ hourHeight: Double,
    _ gridTop: Double,
    _ gridHeight: Double,
    _ cardTop: Double
) {
    DispatchQueue.main.async {
        SidebarManager.shared.setScrollPosition(
            hour: CGFloat(hour),
            hourHeight: CGFloat(hourHeight),
            gridTop: CGFloat(gridTop),
            gridHeight: CGFloat(gridHeight),
            cardTop: CGFloat(cardTop)
        )
    }
}
