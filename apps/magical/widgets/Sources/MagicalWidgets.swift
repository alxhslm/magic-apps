import AppIntents
import SwiftUI
import WidgetKit

// MARK: - Timeline

struct CacheEntry: TimelineEntry {
    let date: Date
    let cache: WidgetCache
}

/// Reads the snapshot the app writes whenever the diary changes, and keeps only the
/// calendars this widget is set to show.
///
/// Unlike Magimail's provider, this one emits more than one entry. A countdown
/// ticks on its own through `Text(_:style: .relative)`, but the change from
/// "in 2 min" to a green `NOW`, and the disappearance of a finished meeting,
/// are changes of content rather than of a number. Each is an entry at the
/// moment it happens, so the widget is right without asking for a reload.
///
/// `reloadAllTimelines()` after each write is what makes an edited meeting land
/// promptly; the trailing 15-minute policy is the backstop for when the app is
/// not running.
struct CacheProvider: AppIntentTimelineProvider {
    /// Entries past this are wasted: the snapshot only carries three days, and
    /// WidgetKit discards a timeline it considers unreasonably long.
    private let maxEntries = 24

    func placeholder(in _: Context) -> CacheEntry {
        CacheEntry(date: Date(), cache: .empty)
    }

    func snapshot(for configuration: CalendarSelectionIntent, in _: Context) async -> CacheEntry {
        WidgetsLogger.shared.info("snapshot requested")
        return CacheEntry(date: Date(), cache: WidgetCache.load().showing(configuration.calendars))
    }

    func timeline(for configuration: CalendarSelectionIntent, in _: Context) async -> Timeline<CacheEntry> {
        WidgetsLogger.shared.info("timeline requested")

        let now = Date()
        let cache = WidgetCache.load().showing(configuration.calendars)
        let entries = momentsThatChangeTheView(in: cache, from: now)
            .prefix(maxEntries)
            .map { CacheEntry(date: $0, cache: cache) }

        let backstop = Calendar.current.date(byAdding: .minute, value: 15, to: now) ?? now
        return Timeline(entries: Array(entries), policy: .after(backstop))
    }

    /// Now, then every moment an event starts or finishes.
    ///
    /// A start flips the countdown to `NOW`; a finish drops the meeting out of
    /// the list and promotes the one behind it.
    private func momentsThatChangeTheView(in cache: WidgetCache, from now: Date) -> [Date] {
        var moments: Set<Date> = [now]

        for event in cache.events {
            if event.startDate > now {
                moments.insert(event.startDate)
            }
            if event.endDate > now {
                moments.insert(event.endDate)
            }
        }

        return moments.sorted()
    }
}

// MARK: - Container

//
// containerBackground is required from macOS 14 on; without it the widget is
// rejected by the host with a blank render.

private struct WidgetContainer<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .containerBackground(.fill.tertiary, for: .widget)
    }
}

// MARK: - Widgets

//
// Three widgets, not six. Each answers one question and declares the sizes that
// can answer it, so choosing a widget is choosing a question and choosing a
// size is choosing how much of the answer fits.
//
// Each is configurable, which is what puts the calendar picker in Edit Widget. Two
// Agenda widgets can therefore carry different calendars, and none of them has to
// carry what the menu bar popover carries.

struct UpNextWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: "com.alexhaslam.magical.widget.upnext",
            intent: CalendarSelectionIntent.self,
            provider: CacheProvider()
        ) { entry in
            WidgetContainer {
                UpNextContent(entry: entry)
            }
            .widgetURL(URL(string: "magical://open"))
        }
        .configurationDisplayName("Up Next")
        .description("Your next event and a button to join it.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct UpNextContent: View {
    @Environment(\.widgetFamily) private var family
    let entry: CacheEntry

    var body: some View {
        switch family {
        case .systemSmall: UpNextSmallView(cache: entry.cache, now: entry.date)
        default: UpNextMediumView(cache: entry.cache, now: entry.date)
        }
    }
}

struct AgendaWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: "com.alexhaslam.magical.widget.agenda",
            intent: CalendarSelectionIntent.self,
            provider: CacheProvider()
        ) { entry in
            WidgetContainer {
                AgendaContent(entry: entry)
            }
            .widgetURL(URL(string: "magical://open"))
        }
        .configurationDisplayName("Agenda")
        .description("Your next few days of events.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

private struct AgendaContent: View {
    @Environment(\.widgetFamily) private var family
    let entry: CacheEntry

    var body: some View {
        switch family {
        case .systemLarge: AgendaLargeView(cache: entry.cache, now: entry.date)
        default: AgendaMediumView(cache: entry.cache, now: entry.date)
        }
    }
}

struct MonthWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: "com.alexhaslam.magical.widget.month",
            intent: CalendarSelectionIntent.self,
            provider: CacheProvider()
        ) { entry in
            WidgetContainer {
                MonthContent(entry: entry)
            }
            .widgetURL(URL(string: "magical://open"))
        }
        .configurationDisplayName("Month")
        .description("A month grid with today's events.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

private struct MonthContent: View {
    @Environment(\.widgetFamily) private var family
    let entry: CacheEntry

    var body: some View {
        switch family {
        case .systemLarge: MonthLargeView(cache: entry.cache, now: entry.date)
        default: MonthMediumView(cache: entry.cache, now: entry.date)
        }
    }
}

@main
struct MagicalWidgetBundle: WidgetBundle {
    var body: some Widget {
        UpNextWidget()
        AgendaWidget()
        MonthWidget()
    }
}
