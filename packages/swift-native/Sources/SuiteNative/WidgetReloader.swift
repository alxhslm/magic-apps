import Foundation
import WidgetKit

public enum WidgetReloader {
    /// Reloads all WidgetKit timelines.
    ///
    /// Must run inside Electron's main process: macOS chronod uses Apple's BaseBoard
    /// framework to check that the calling process executable matches CFBundleExecutable
    /// in Info.plist.
    public static func reloadAllTimelines() {
        WidgetCenter.shared.reloadAllTimelines()
    }
}
