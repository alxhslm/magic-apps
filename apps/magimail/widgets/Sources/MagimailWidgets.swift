import AppIntents
import SwiftUI
import WidgetKit

// MARK: - Timeline

struct CacheEntry: TimelineEntry {
    let date: Date
    let cache: WidgetCache
}

/// Reads the snapshot the app writes on every Atom poll.
///
/// The timeline is a single entry refreshed on an interval rather than a series
/// of future entries: the content is entirely driven by what the app has already
/// fetched, so there is nothing to project forward. The app also calls
/// `WidgetCenter.reloadAllTimelines()` after each write, which is what makes
/// updates land promptly; the interval is only a backstop for when the app is
/// not running.
struct CacheProvider: TimelineProvider {
    func placeholder(in _: Context) -> CacheEntry {
        CacheEntry(date: Date(), cache: .empty)
    }

    func getSnapshot(in _: Context, completion: @escaping (CacheEntry) -> Void) {
        WidgetsLogger.shared.info("getSnapshot requested")
        completion(CacheEntry(date: Date(), cache: WidgetCache.load()))
    }

    func getTimeline(in _: Context, completion: @escaping (Timeline<CacheEntry>) -> Void) {
        WidgetsLogger.shared.info("getTimeline requested")
        let entry = CacheEntry(date: Date(), cache: WidgetCache.load())
        let nextRefresh = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date()
        completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
    }
}

// MARK: - Configuration

/// What Edit Widget asks of a widget that draws a thread list: every thread, or unread only.
///
/// Per widget rather than per app, so a Recents widget can show only what still needs an
/// answer while the dashboard beside it keeps the whole list. This is the shape Magical's
/// calendar picker uses, which is where the precedent is.
struct WidgetThreadFilterIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Choose Threads"
    static var description = IntentDescription(
        "Choose whether this widget lists every thread or unread ones only."
    )

    /// The parameter carries its own default so the system can build a configuration for a
    /// widget that has never been edited, which is the state every freshly added widget is in.
    @Parameter(title: "Unread only", default: false)
    var unreadOnly: Bool

    init() {}

    init(unreadOnly: Bool) {
        self.unreadOnly = unreadOnly
    }
}

/// The provider for the two widgets that draw a thread list: the same snapshot, with the
/// read threads taken out when this widget was configured unread only.
struct ThreadListCacheProvider: AppIntentTimelineProvider {
    func placeholder(in _: Context) -> CacheEntry {
        CacheEntry(date: Date(), cache: .empty)
    }

    func snapshot(for configuration: WidgetThreadFilterIntent, in _: Context) async -> CacheEntry {
        WidgetsLogger.shared.info("snapshot requested")
        return CacheEntry(date: Date(), cache: resolved(configuration))
    }

    func timeline(for configuration: WidgetThreadFilterIntent, in _: Context) async -> Timeline<CacheEntry> {
        WidgetsLogger.shared.info("timeline requested")
        let entry = CacheEntry(date: Date(), cache: resolved(configuration))
        let nextRefresh = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date()
        return Timeline(entries: [entry], policy: .after(nextRefresh))
    }

    private func resolved(_ configuration: WidgetThreadFilterIntent) -> WidgetCache {
        let cache = WidgetCache.load()
        return configuration.unreadOnly == true ? cache.onlyUnread() : cache
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

struct UnreadWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.alexhaslam.magimail.widget.unread", provider: CacheProvider()) { entry in
            WidgetContainer { SmallWidgetView(cache: entry.cache) }
                .widgetURL(URL(string: "magimail://inbox"))
        }
        .configurationDisplayName("Unread")
        .description("Unread totals across your accounts.")
        .supportedFamilies([.systemSmall])
    }
}

struct QuickActionsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.alexhaslam.magimail.widget.quickactions", provider: CacheProvider()) { entry in
            WidgetContainer { QuickActionsWidgetView(cache: entry.cache) }
        }
        .configurationDisplayName("Quick Actions")
        .description("Per-account unread counts with one-tap compose.")
        .supportedFamilies([.systemMedium])
    }
}

struct RecentsWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: "com.alexhaslam.magimail.widget.recents",
            intent: WidgetThreadFilterIntent.self,
            provider: ThreadListCacheProvider()
        ) { entry in
            WidgetContainer { RecentsWidgetView(cache: entry.cache) }
        }
        .configurationDisplayName("Recents")
        .description("Your most recent threads.")
        .supportedFamilies([.systemMedium])
    }
}

struct DashboardWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: "com.alexhaslam.magimail.widget.dashboard",
            intent: WidgetThreadFilterIntent.self,
            provider: ThreadListCacheProvider()
        ) { entry in
            WidgetContainer { DashboardWidgetView(cache: entry.cache) }
        }
        .configurationDisplayName("Inbox Dashboard")
        .description("Unread counts plus your latest threads.")
        .supportedFamilies([.systemLarge])
    }
}

@main
struct MagimailWidgets: WidgetBundle {
    var body: some Widget {
        UnreadWidget()
        QuickActionsWidget()
        RecentsWidget()
        DashboardWidget()
    }
}
