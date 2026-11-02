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
    private var windowCloseObserver: Any?

    public var isVisible: Bool = true
    public let cardWidth: CGFloat = 324
    public let margin: CGFloat = 8
    public let topMargin: CGFloat = 6
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
                self.visualEffectView?.removeFromSuperview()
                self.visualEffectView = nil
                self.hostingView = nil
                self.trailingConstraint = nil
                self.window = nil
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

            NSLayoutConstraint.activate([
                effect.widthAnchor.constraint(equalToConstant: cardWidth),
                effect.topAnchor.constraint(equalTo: contentView.topAnchor, constant: toolbarHeight + topMargin),
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

        var anchor: Date? = Date()
        if let str = anchorDateStr, !str.isEmpty {
            let df = DateFormatter()
            df.dateFormat = "yyyy-MM-dd"
            df.timeZone = .current
            if let parsed = df.date(from: str) {
                anchor = parsed
            }
        }

        SidebarModel.shared.setViewMode(viewMode, anchor: anchor)
    }

    public func setScrollPosition(hour: CGFloat, hourHeight: CGFloat) {
        SidebarModel.shared.setScrollPosition(hour: hour, hourHeight: hourHeight)
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
public func sidebarSetScrollPosition(_ hour: Double, _ hourHeight: Double) {
    DispatchQueue.main.async {
        SidebarManager.shared.setScrollPosition(hour: CGFloat(hour), hourHeight: CGFloat(hourHeight))
    }
}
