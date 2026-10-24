import AppKit
import SwiftUI

public extension View {
    func eventContextMenu(
        event: TrayEvent,
        onSelect: @escaping () -> Void,
        onJoinCall: ((String) -> Void)? = nil,
        onRsvp: ((String) -> Void)? = nil,
        onDelete: ((TrayEvent) -> Void)? = nil,
        onComplete: ((TrayEvent, Bool) -> Void)? = nil
    ) -> some View {
        contextMenu {
            Button {
                onSelect()
            } label: {
                Label("Open in Magical", systemImage: "arrow.up.forward.app")
            }

            // Completing is what a task is for, so it sits first, where Google's own task
            // panel puts it. Unconfirmed, unlike the delete below: the same item reopens
            // a task that is already ticked off.
            if event.isTask, let onComplete {
                Button {
                    onComplete(event, !event.isCompleted)
                } label: {
                    Label(
                        event.isCompleted ? "Mark Incomplete" : "Mark Complete",
                        systemImage: event.isCompleted ? "arrow.uturn.backward.circle" : "checkmark.circle"
                    )
                }
            }

            if let conferenceUrl = event.conferenceUrl, let onJoinCall {
                Button {
                    onJoinCall(conferenceUrl)
                } label: {
                    Label("Join Meeting", systemImage: "video")
                }
            }

            // Not offered on a task, which has no link that opens it. The `eid` in a task's
            // own `webUrl` lands on the task's day with nothing open, and the `ttb_` form the
            // grid chip carries is answered with an HTTP 500. Both measured.
            if !event.isTask, let webUrl = event.webUrl, !webUrl.isEmpty {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(webUrl, forType: .string)
                } label: {
                    Label("Copy Event Link", systemImage: "doc.on.doc")
                }
            }

            if event.isInvitation, let onRsvp {
                Divider()

                Menu {
                    rsvpItem("Yes", reply: RsvpReply.yes, isAnswer: event.myResponseStatus == 3, onRsvp: onRsvp)
                    rsvpItem("Maybe", reply: RsvpReply.maybe, isAnswer: event.isTentative, onRsvp: onRsvp)
                    rsvpItem("No", reply: RsvpReply.no, isAnswer: event.myResponseStatus == 1, onRsvp: onRsvp)
                } label: {
                    Label("RSVP", systemImage: "envelope")
                }
            }

            if let onDelete {
                Divider()

                Button(role: .destructive) {
                    confirmAndDelete(event: event, onDelete: onDelete)
                } label: {
                    Label(event.isTask ? "Delete Task" : "Delete Event", systemImage: "trash")
                }
            }
        }
    }
}

/// One answer in the RSVP submenu. The answer already on the event carries a checkmark, which
/// is how a Mac menu says which of a set of choices is in force.
private func rsvpItem(
    _ title: LocalizedStringKey,
    reply: String,
    isAnswer: Bool,
    onRsvp: @escaping (String) -> Void
) -> some View {
    Button {
        onRsvp(reply)
    } label: {
        if isAnswer {
            Label(title, systemImage: "checkmark")
        } else {
            Text(title)
        }
    }
}

private func confirmAndDelete(event: TrayEvent, onDelete: @escaping (TrayEvent) -> Void) {
    let alert = NSAlert()
    alert.messageText = String(localized: "Delete “\(event.summary)”?")
    alert.informativeText = event.isTask
        ? String(localized: "Are you sure you want to delete this task from Google Tasks?")
        : String(localized: "Are you sure you want to delete this event from Google Calendar?")
    alert.alertStyle = .warning
    let deleteBtn = alert.addButton(withTitle: String(localized: "Delete"))
    deleteBtn.hasDestructiveAction = true
    alert.addButton(withTitle: String(localized: "Cancel"))
    NSApp.activate(ignoringOtherApps: true)
    if alert.runModal() == .alertFirstButtonReturn {
        onDelete(event)
    }
}
