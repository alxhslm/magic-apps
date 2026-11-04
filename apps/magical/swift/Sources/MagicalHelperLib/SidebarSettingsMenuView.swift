import HelperUI
import SwiftUI

/// Settings gear menu for the Companion Sidebar with task display and refresh options.
@MainActor
public struct SidebarSettingsMenuView: View {
    @ObservedObject public var model: TrayModel
    public let onRefresh: () -> Void

    @MainActor
    public init(model: TrayModel, onRefresh: @escaping () -> Void = {}) {
        self.model = model
        self.onRefresh = onRefresh
    }

    @MainActor
    public init(onRefresh: @escaping () -> Void = {}) {
        model = .shared
        self.onRefresh = onRefresh
    }

    public var body: some View {
        Menu {
            // Completed tasks are a filter, not a preference, so the toggle lives in
            // `CalendarFilterMenuView` beside the calendar ticks. Keeping a second copy
            // here gave the same setting two places to be changed and one more to drift.
            Button("Refresh Calendars") {
                model.isRefreshing = true
                onRefresh()
            }
            .keyboardShortcut("r")
            .disabled(model.isRefreshing)
        } label: {
            Image(systemName: "gearshape")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 18, height: 18)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Settings")
    }
}
