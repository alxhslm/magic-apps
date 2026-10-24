import SwiftUI
import WidgetKit

// MARK: - Shared pieces

//
// Layout follows docs/magimail/widgets.md: iOS widget
// ergonomics in the macOS surface language. Message lists are one unified inset
// group with hairline dividers — never a stack of isolated cards — and the
// account a thread belongs to is carried by an accent pill on the leading edge.

private enum Metrics {
    static let hairline = Color.primary.opacity(0.08)
    static let groupFill = Color.primary.opacity(0.04)
    static let tileFill = Color.primary.opacity(0.06)
}

/// Brand mark, drawn from the same artwork as the app icon and the popover.
///
/// It was Apple's `envelope` symbol in terracotta with a `sparkle` overlaid,
/// which put a system envelope where the brand's own belongs: no gap in the
/// outline for the star to sit in, and a flap of the wrong shape. The artwork is
/// `HelperBrand`'s, which the widget links as a local package while `BrandArtwork`
/// is compiled in by reference, so the widget and the popover cannot drift apart.
///
struct BrandMarkView: View {
    var width: CGFloat = 18

    var body: some View {
        if let image = BrandArtwork.mark.image(width: width) {
            Image(nsImage: image)
                .resizable()
                .frame(width: width, height: width / BrandArtwork.mark.aspectRatio)
        }
    }
}

struct WidgetHeader: View {
    let totalUnread: Int
    var showsName = true
    /// Compose with no account named, as in the Recents header. It belongs to
    /// none of them, so it links to a bare `magimail://compose`; the app answers
    /// that with the same account picker `mailto:` links use, honouring
    /// `composeAccountPicker` and skipping the question when there is only one.
    var showsCompose = false

    var body: some View {
        HStack(spacing: 7) {
            BrandMarkView()
            if showsName {
                Text("Magimail")
                    .font(.system(size: 12.5, weight: .semibold))
            }
            Spacer(minLength: 0)
            Text("\(totalUnread) unread")
                .font(.system(size: 11.5))
                .foregroundStyle(.secondary)
                .monospacedDigit()
            if showsCompose, let url = WidgetCache.composeURL(accountId: nil) {
                Link(destination: url) {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 12))
                        .foregroundStyle(.primary)
                }
                .padding(.leading, 3)
            }
        }
    }
}

/// One row of the unified inset group.
///
/// Read and unread are drawn the way the popover draws them — see
/// `TrayMessageRow`: a dot at the end of the subject line, the weight and
/// strength of the text, and a faint accent wash over the row. The leading
/// pill stays at full strength in both, because in the widget it carries which
/// account a thread belongs to rather than whether it has been read.
struct MessageRow: View {
    let message: CachedMessage
    let accent: Color
    let showsDivider: Bool
    /// Take a share of whatever height the group has spare. See `MessageGroup`.
    var stretches = false

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 6) {
                Text(message.sender)
                    .font(.system(size: 11.5, weight: message.isUnread ? .semibold : .medium))
                    .foregroundStyle(message.isUnread ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(message.displayDate)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                    .opacity(message.isUnread ? 1 : 0.7)
                    .monospacedDigit()
            }
            HStack(spacing: 6) {
                Text(message.subject)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .opacity(message.isUnread ? 1 : 0.7)
                    .lineLimit(1)

                Spacer(minLength: 4)

                // Unread's dot, away from the account pill so the two do not
                // read as one glyph. Mail and Messages mark unread with a dot;
                // the weight and tint carry the rest.
                if message.isUnread {
                    Circle()
                        .fill(accent)
                        .frame(width: 6, height: 6)
                        .accessibilityHidden(true)
                }

                // Flush right, so it sits under the timestamp. Tertiary and
                // unweighted: which tab a thread landed in ranks below who sent
                // it and what it says.
                Image(systemName: message.mailCategory.symbolName)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .accessibilityLabel(message.mailCategory.title)
            }
        }
        .padding(.leading, 18)
        .padding(.trailing, 10)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, maxHeight: stretches ? .infinity : nil, alignment: .leading)
        // The wash the popover puts over an unread row, and nothing at all on a
        // read one. Over the row's own frame, so it reaches the pill and the
        // trailing edge; the group's clip keeps it inside the rounded corners.
        .background(message.isUnread ? accent.opacity(0.07) : Color.clear)
        .accessibilityValue(message.isUnread ? Text("Unread") : Text("Read"))
        // The accent pill is an overlay rather than a row element. A Shape is
        // greedy on both axes, and as a sibling of the text it stretched the row
        // to whatever height was going spare — one message filling the widget.
        // As an overlay it is sized by the row instead of sizing it.
        .overlay(alignment: .leading) {
            Capsule()
                .fill(accent)
                .frame(width: 3)
                .padding(.leading, 7)
                .padding(.vertical, 5)
        }
        .overlay(alignment: .bottom) {
            if showsDivider {
                Rectangle()
                    .fill(Metrics.hairline)
                    .frame(height: 0.5)
                    .padding(.leading, 18)
            }
        }
    }
}

struct MessageGroup: View {
    let cache: WidgetCache
    let limit: Int
    /// Share any height the widget has spare between the rows, so the group
    /// reaches the bottom edge rather than leaving a strip of empty widget
    /// under it. The caller only asks for this when the list came out full —
    /// stretching a short list gives rows of air, which reads worse than the
    /// gap it replaced.
    var fillsHeight = false

    var body: some View {
        let messages = Array(cache.messages.prefix(limit))

        VStack(spacing: 0) {
            ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                let accent = cache.account(for: message).map { Color(hexString: $0.color) } ?? .accentColor

                if let url = cache.threadURL(for: message) {
                    Link(destination: url) {
                        MessageRow(
                            message: message,
                            accent: accent,
                            showsDivider: index < messages.count - 1,
                            stretches: fillsHeight
                        )
                    }
                    .buttonStyle(.plain)
                } else {
                    MessageRow(
                        message: message,
                        accent: accent,
                        showsDivider: index < messages.count - 1,
                        stretches: fillsHeight
                    )
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: 12).fill(Metrics.groupFill))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Metrics.hairline, lineWidth: 1))
    }
}

/// Compact account row: colour dot, name, unread count.
///
/// The counterpart to `QuickActionsWidgetView`'s tile — same information, a
/// third of the height — for the places that must fit more than two accounts.
struct AccountChip: View {
    let account: CachedAccount
    /// One-tap compose, for the surfaces whose job is acting rather than
    /// reporting. A `Link` nested inside the chip's own: the innermost one under
    /// the pointer wins, so composing still beats switching account.
    var showsCompose = false

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Color(hexString: account.color))
                .frame(width: 7, height: 7)
            Text(account.name)
                .font(.system(size: 11.5, weight: .medium))
                .lineLimit(1)
            Spacer(minLength: 2)
            // Sized to lead the row. Folding the tile onto one line costs the
            // count its 24pt, but it must still read as the row's subject
            // rather than a footnote after the name.
            Text("\(account.unreadCount)")
                .font(.system(size: 18, weight: .semibold))
                .monospacedDigit()
            if showsCompose, let url = WidgetCache.composeURL(accountId: account.id) {
                Link(destination: url) {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 12))
                        .foregroundStyle(.primary)
                }
            }
        }
        .padding(.horizontal, 9)
        .frame(height: 34)
        .background(RoundedRectangle(cornerRadius: 10).fill(Metrics.tileFill))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Metrics.hairline, lineWidth: 1))
    }
}

/// Every account, two to a row.
///
/// Two across is what 324pt has room for; a third squeezes "Personal 12" to an
/// ellipsis. Capped at four, which is two rows — beyond that a widget is the
/// wrong surface for the list and the app's own switcher is the right one.
struct AccountGrid: View {
    let accounts: [CachedAccount]
    var showsCompose = false

    static let maxAccounts = 4

    private var shown: ArraySlice<CachedAccount> {
        accounts.prefix(Self.maxAccounts)
    }

    var body: some View {
        VStack(spacing: 8) {
            ForEach(Array(stride(from: 0, to: shown.count, by: 2)), id: \.self) { start in
                HStack(spacing: 10) {
                    ForEach(shown[start ..< min(start + 2, shown.count)]) { account in
                        AccountLink(account: account) {
                            AccountChip(account: account, showsCompose: showsCompose)
                        }
                    }
                    if shown.count - start == 1 {
                        // An odd account out keeps its half of the row rather
                        // than stretching across it and outweighing the rest.
                        //
                        // Height-bounded deliberately. A `Color` is greedy on
                        // both axes, and bounding only the width left this free
                        // to swallow every spare point in the widget — which it
                        // did, stretching its row and stranding the lone chip in
                        // the middle of it. Same trap as the accent pill below.
                        Color.clear.frame(maxWidth: .infinity, maxHeight: 34)
                    }
                }
            }
        }
    }
}

/// Wraps an account's section so clicking it opens the app on that account.
///
/// The compose button inside the Quick Actions tile is a `Link` of its own; the
/// innermost one under the pointer wins, so composing still beats switching.
struct AccountLink<Content: View>: View {
    let account: CachedAccount
    @ViewBuilder let content: Content

    var body: some View {
        if let url = WidgetCache.inboxURL(accountId: account.id) {
            Link(destination: url) { content }
                .buttonStyle(.plain)
        } else {
            content
        }
    }
}

/// Shown when nothing has been cached yet, so a widget never renders blank.
struct EmptyState: View {
    let caughtUp: Bool

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: caughtUp ? "checkmark.circle.fill" : "envelope")
                .font(.system(size: 22))
                .foregroundStyle(caughtUp ? Color.green : Color.secondary)
            Text(caughtUp ? "All caught up" : "Open Magimail to sync")
                .font(.system(size: 11.5))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Small: unread overview

public struct SmallWidgetView: View {
    public let cache: WidgetCache

    public init(cache: WidgetCache) {
        self.cache = cache
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                BrandMarkView()
                Spacer(minLength: 0)
            }

            Spacer(minLength: 4)

            Text("\(cache.totalUnread)")
                .font(.system(size: 34, weight: .semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text("unread")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)

            Spacer(minLength: 4)

            VStack(spacing: 3) {
                ForEach(cache.accounts.prefix(3)) { account in
                    AccountLink(account: account) {
                        HStack(spacing: 5) {
                            Circle()
                                .fill(Color(hexString: account.color))
                                .frame(width: 6, height: 6)
                            Text(account.name)
                                .font(.system(size: 10.5))
                                .lineLimit(1)
                            Spacer(minLength: 2)
                            Text("\(account.unreadCount)")
                                .font(.system(size: 10.5, weight: .medium))
                                .monospacedDigit()
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Medium: per-account counts and quick compose

public struct QuickActionsWidgetView: View {
    public let cache: WidgetCache

    public init(cache: WidgetCache) {
        self.cache = cache
    }

    public var body: some View {
        VStack(spacing: 0) {
            WidgetHeader(totalUnread: cache.totalUnread)

            if cache.accounts.isEmpty {
                EmptyState(caughtUp: false)
            } else if cache.accounts.count <= 2 {
                HStack(spacing: 10) {
                    ForEach(cache.accounts) { account in
                        AccountLink(account: account) {
                            accountTile(account)
                        }
                    }
                }
                .padding(.top, 10)
            } else {
                // Three tiles will not fit: 324pt divided three ways leaves the
                // stacked number nowhere to sit. The tile folds onto one line
                // instead — name, count, compose — which keeps all three and
                // fits four accounts in the height one stacked tile wanted.
                AccountGrid(accounts: cache.accounts, showsCompose: true)
                    .padding(.top, 8)
            }
        }
    }

    private func accountTile(_ account: CachedAccount) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Circle()
                    .fill(Color(hexString: account.color))
                    .frame(width: 7, height: 7)
                Text(account.name)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let url = WidgetCache.composeURL(accountId: account.id) {
                    Link(destination: url) {
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: 12))
                            .foregroundStyle(.primary)
                    }
                }
            }

            Spacer(minLength: 2)

            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("\(account.unreadCount)")
                    .font(.system(size: 24, weight: .semibold))
                    .monospacedDigit()
                Text("unread")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(9)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 14).fill(Metrics.tileFill))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Metrics.hairline, lineWidth: 1))
    }
}

// MARK: - Medium: recent threads

public struct RecentsWidgetView: View {
    public let cache: WidgetCache

    public init(cache: WidgetCache) {
        self.cache = cache
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 7) {
                BrandMarkView()
                Text("Magimail")
                    .font(.system(size: 12.5, weight: .semibold))
                Spacer(minLength: 0)
                if let url = WidgetCache.composeURL(accountId: nil) {
                    Link(destination: url) {
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: 12))
                            .foregroundStyle(.primary)
                    }
                }
            }

            if cache.messages.isEmpty {
                EmptyState(caughtUp: cache.totalUnread == 0 && !cache.accounts.isEmpty)
            } else {
                // Three threads is what fits 324 x 155pt without clipping.
                MessageGroup(cache: cache, limit: 3)
                    .padding(.top, 6)
                Spacer(minLength: 0)
            }
        }
    }
}

// MARK: - Large: dashboard

public struct DashboardWidgetView: View {
    public let cache: WidgetCache

    public init(cache: WidgetCache) {
        self.cache = cache
    }

    /// As many threads as the account chips leave, rather than a constant.
    ///
    /// Measured against the real layout: at three accounts the chips take two
    /// rows and four threads end roughly 28pt clear of the bottom, at a row
    /// pitch of about 38pt. Dropping to one row returns the 42pt that row cost
    /// — a chip and its spacing — which is worth one more thread and no more.
    private var recentLimit: Int {
        let chipRows = (min(cache.accounts.count, AccountGrid.maxAccounts) + 1) / 2
        return chipRows > 1 ? 4 : 5
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetHeader(totalUnread: cache.totalUnread, showsCompose: true)

            if cache.accounts.isEmpty {
                EmptyState(caughtUp: false)
            } else {
                AccountGrid(accounts: cache.accounts)
                    .padding(.top, 10)

                Text("RECENT")
                    .font(.system(size: 10.5, weight: .semibold))
                    .tracking(0.35)
                    .foregroundStyle(.secondary)
                    .padding(.top, 12)
                    .padding(.bottom, 5)

                if cache.messages.isEmpty {
                    EmptyState(caughtUp: cache.totalUnread == 0)
                } else {
                    // A full list takes the slack; a short one keeps its natural
                    // height and lets the spacer hold it up. Two greedy siblings
                    // would split the leftover between them, so it is one or the
                    // other, never both.
                    let fills = cache.messages.count >= recentLimit
                    MessageGroup(cache: cache, limit: recentLimit, fillsHeight: fills)
                    if !fills {
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }
}
