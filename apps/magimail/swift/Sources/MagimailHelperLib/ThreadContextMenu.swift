import SwiftUI

/// Right-click menu on a popover row, so mail can be cleared without opening it.
///
/// Opening leads the menu because it is what a left-click already does; the
/// triage below it is the part the row could not otherwise reach. Delete sits
/// under a divider on its own, away from the action next to it in the list.
public extension View {
    func threadContextMenu(
        message: TrayMessage,
        onOpen: @escaping () -> Void,
        onAction: @escaping (TrayThreadAction) -> Void
    ) -> some View {
        contextMenu {
            Button {
                onOpen()
            } label: {
                Label("Open in Magimail", systemImage: "arrow.up.forward.app")
            }

            Divider()

            Button {
                onAction(.archive)
            } label: {
                Label("Archive", systemImage: "archivebox")
            }

            // One item rather than both, showing whichever changes the row.
            // Gmail's own control works the same way: it renders mark as read
            // and mark as unread and lays out only the one the selection calls
            // for. The row's weight already says which state it is in, so the
            // menu offering the other one reads as the way to swap it.
            if message.isUnread {
                Button {
                    onAction(.markRead)
                } label: {
                    Label("Mark as Read", systemImage: "envelope.open")
                }
            } else {
                Button {
                    onAction(.markUnread)
                } label: {
                    Label("Mark as Unread", systemImage: "envelope.badge")
                }
            }

            Divider()

            // No confirmation, unlike Magical's event delete: this is Gmail's
            // Delete, which moves a thread to Bin and leaves it recoverable.
            Button(role: .destructive) {
                onAction(.trash)
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }
}
