import AppIntents
import Foundation
import WidgetKit

// MARK: - Calendar Entity

/// One calendar in a widget's own picker, offered in Edit Widget.
///
/// Identified by its account *and* its calendar id, joined by a `|`, as the Focus filter's
/// picker identifies one. A Google calendar id does not identify a calendar on its own:
/// Birthdays, Tasks and each locale's holidays carry the same id in every account, so two
/// accounts would otherwise produce two rows sharing an id and stop being two rows. `|`
/// cannot appear in either half.
struct WidgetCalendarEntity: AppEntity {
    static var defaultQuery = WidgetCalendarQuery()
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Calendar"

    var id: String
    var name: String
    var detail: String
    /// `#rrggbb`, the colour Google Calendar draws this calendar in.
    var colorHex: String

    /// The calendar this row stands for, or nil for an id no longer in the snapshot.
    var ref: CalendarRef? {
        guard let separator = id.firstIndex(of: "|") else { return nil }
        return CalendarRef(
            accountId: String(id[id.startIndex ..< separator]),
            calendarId: String(id[id.index(after: separator)...])
        )
    }

    var displayRepresentation: DisplayRepresentation {
        guard let dot = CalendarDot.png(hex: colorHex) else {
            return DisplayRepresentation(title: "\(name)", subtitle: "\(detail)")
        }
        return DisplayRepresentation(
            title: "\(name)",
            subtitle: "\(detail)",
            image: DisplayRepresentation.Image(data: dot)
        )
    }
}

// MARK: - Calendar Entity Query

struct WidgetCalendarQuery: EntityQuery, EnumerableEntityQuery {
    /// Reads the snapshot, which is the only thing this extension can see of Magical.
    ///
    /// The system renders this as one flat list: no sections, no headings, and nothing of
    /// ours in it. With more than one account every row carries the account's name,
    /// because two accounts commonly both have a Birthdays, a Tasks and a UK Holidays, and
    /// an unprefixed list would offer the same name twice with no way to tell them apart.
    /// A single account needs no prefix and reads worse with one.
    func loadEntities() -> [WidgetCalendarEntity] {
        let calendars = WidgetCache.load().calendars
        let prefixed = Set(calendars.map(\.accountId)).count > 1
        return calendars.map { calendar in
            WidgetCalendarEntity(
                id: "\(calendar.accountId)|\(calendar.calendarId)",
                name: prefixed ? "\(calendar.accountName) · \(calendar.name)" : calendar.name,
                detail: calendar.accountName,
                colorHex: calendar.colorHex
            )
        }
    }

    func entities(for identifiers: [String]) async throws -> [WidgetCalendarEntity] {
        loadEntities().filter { identifiers.contains($0.id) }
    }

    func allEntities() async throws -> [WidgetCalendarEntity] {
        loadEntities()
    }

    func suggestedEntities() async throws -> [WidgetCalendarEntity] {
        loadEntities()
    }
}

// MARK: - Configuration Intent

/// What Edit Widget asks: which calendars this widget shows.
///
/// Per widget rather than per app, so two Agenda widgets can carry different calendars,
/// and neither has to match the menu bar popover. A widget is glanceable and the popover is
/// where the whole day is checked, so a calendar worth keeping out of one is often worth
/// keeping in the other.
struct CalendarSelectionIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Choose Calendars"
    static var description = IntentDescription(
        "Choose which calendars this widget shows. It starts with the ones the menu bar shows."
    )

    /// Empty means an empty widget, having been asked and told nothing.
    ///
    /// Optional only because AppIntents requires it: a `WidgetConfigurationIntent` whose
    /// parameters are not all optional fails to compile. `init()` always seeds a list, so
    /// nil arrives only if the framework hands over no configuration at all, and nothing is
    /// filtered when it does.
    @Parameter(title: "Calendars")
    var calendars: [WidgetCalendarEntity]?

    /// A new widget starts with the calendars the popover shows, rather than with none.
    ///
    /// The picker renders whatever the parameter holds, so starting empty offered a list
    /// with nothing ticked while the widget drew a full day. Unticking has to read as taking
    /// something off what is already on screen. Seeding from the popover rather than from
    /// every calendar keeps one switched off there from reappearing when a widget is added.
    ///
    /// A starting point, not a subscription: once this list is stored the widget keeps it,
    /// and later changes to the popover's filter leave it alone.
    init() {
        let hidden = Set(WidgetCache.load().hiddenCalendars)
        calendars = WidgetCalendarQuery().loadEntities().filter { entity in
            guard let ref = entity.ref else { return true }
            return !hidden.contains(ref)
        }
    }

    init(calendars: [WidgetCalendarEntity]?) {
        self.calendars = calendars
    }
}

// MARK: - Applying the choice

extension WidgetCache {
    /// The snapshot as one widget draws it, with the calendars it does not show taken out.
    ///
    /// The app writes every event it has, because the choice lives in each widget's
    /// configuration and only this extension can read that.
    func showing(_ selection: [WidgetCalendarEntity]?) -> WidgetCache {
        let widgetHidden = hiddenFor(selection)
        let focusSilenced = Set(silencedCalendars ?? [])
        let effectiveHidden = widgetHidden.union(focusSilenced)
        guard !effectiveHidden.isEmpty else { return self }

        var filtered = self
        filtered.events = events.filter { !isHiddenEverywhere($0, in: effectiveHidden) }
        filtered.densityDots = densityDots.compactMapValues { dots in
            let kept = dots.filter { !effectiveHidden.contains($0.ref) }
            return kept.isEmpty ? nil : kept
        }

        // Mark the widget silenced when Focus removed events that would otherwise show.
        // Checking against widgetHidden alone (without Focus) ensures we only set the flag
        // when Focus is what caused the list to go empty — not the user's own calendar picker.
        if isFocusActive == true, !focusSilenced.isEmpty, filtered.events.isEmpty {
            let withoutFocus = events.filter { !isHiddenEverywhere($0, in: widgetHidden) }
            filtered.isSilencedByFocus = !withoutFocus.isEmpty
        }

        return filtered
    }

    /// The calendars this widget takes off screen.
    ///
    /// A choice is stored as what to show and applied as what to hide, so that a calendar
    /// the picker never offered stays on screen either way. The picker is built from the
    /// snapshot's calendar list, and an account's own view names calendars that are not on
    /// that list; the popover's filter leaves those alone too.
    private func hiddenFor(_ selection: [WidgetCalendarEntity]?) -> Set<CalendarRef> {
        // No configuration at all, which `init()` makes sure never happens in practice.
        guard let selection else { return [] }

        let chosen = Set(selection.compactMap(\.ref))
        return Set(calendars.map(\.ref).filter { !chosen.contains($0) })
    }

    /// Whether the filter takes an event off screen, which it does only when every calendar
    /// the event is on is hidden.
    ///
    /// Hiding one calendar an event is on says nothing about the others. An interview on a
    /// recruiting calendar and on the user's own stays in their day when they hide the
    /// recruiting one, because they are still attending it. This is the rule the popover
    /// applies too.
    ///
    /// An event on no calendar at all stays, because hiding calendars has said nothing
    /// about it either way.
    private func isHiddenEverywhere(_ event: CachedEvent, in hidden: Set<CalendarRef>) -> Bool {
        guard !event.calendarIds.isEmpty else { return false }
        return event.calendarIds.allSatisfy {
            hidden.contains(CalendarRef(accountId: event.accountId, calendarId: $0))
        }
    }
}
