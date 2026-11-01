import HelperUI
import SwiftUI

/// Reusable calendar filter menu used by both the Menu Bar Tray and Companion Sidebar.
@MainActor
public struct CalendarFilterMenuView: View {
    @ObservedObject public var model: TrayModel

    @MainActor
    public init(model: TrayModel) {
        self.model = model
    }

    @MainActor
    public init() {
        model = .shared
    }

    public var body: some View {
        if model.availableCalendars.count > 1 || model.hasTasks {
            Menu {
                ForEach(model.accounts) { account in
                    let accountCalendars = model.availableCalendars.filter { $0.accountId == account.id }
                    if !accountCalendars.isEmpty {
                        Section(account.name) {
                            ForEach(accountCalendars) { cal in
                                calendarToggle(cal)
                            }
                        }
                    }
                }

                let unassigned = model.availableCalendars.filter { cal in
                    !model.accounts.contains(where: { $0.id == cal.accountId })
                }
                if !unassigned.isEmpty {
                    Section("Other") {
                        ForEach(unassigned) { cal in
                            calendarToggle(cal)
                        }
                    }
                }

                if model.hasTasks {
                    Divider()
                    Toggle("Show Completed Tasks", isOn: Binding(
                        get: { model.showCompletedTasks },
                        set: { model.setShowCompletedTasks($0) }
                    ))
                }

                if model.isUserFilteringCalendars {
                    Divider()
                    Button("Show All Calendars") {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            model.showAllCalendars()
                        }
                    }
                }
            } label: {
                Image(systemName: model.isFilteringCalendars ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                    .font(.system(size: 12))
                    .foregroundStyle(model.isFilteringCalendars ? Color.accentColor : .primary)
            }
            .modifier(TrayAccessoryButton())
            .help(filterHelp)
        }
    }

    @ViewBuilder
    private func calendarToggle(_ cal: TrayCalendarItem) -> some View {
        let silencedByFocus = model.isSilencedByFocus(cal)
        Toggle(isOn: Binding(
            get: { model.isCalendarVisible(cal) },
            set: { _ in
                withAnimation(.easeInOut(duration: 0.2)) {
                    model.toggleCalendar(cal)
                }
            }
        )) {
            Label {
                Text(cal.name)
            } icon: {
                Image(nsImage: AccountDot.image(hex: cal.colorHex))
            }
        }
        .disabled(silencedByFocus)
    }

    private var filterHelp: LocalizedStringKey {
        if FocusFilterController.shared.isFilterActive {
            return "Filter Calendars (a Focus is silencing some)"
        }
        return model.isFilteringCalendars ? "Filter Calendars (Active)" : "Filter Calendars"
    }
}
