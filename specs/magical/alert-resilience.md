# Alert resilience

The persisted event cache keeps alerts firing from stale data through an outage, and the health a
source reports is already rendered in the menu bar popover, the toolbar switcher and Settings rows;
[`notifications.md`'s Restart during an outage](../../docs/magical/notifications.md#restart-during-an-outage)
and [`notifications.md`'s Source health](../../docs/magical/notifications.md#source-health)
own them. What is not built is the notification.

## Telling the user when alerts stop

The poller has to read all three surfaces, and the user whose alerts have stopped is by definition not
looking, because nothing has appeared to make them. A notification when a source crosses into stale
is the one thing that reaches them, saying alerts are no longer firing at all. The helper posts the
banner
([`notifications.md`'s The helper posts the banner](../../docs/shared/notifications.md#helper-posts-the-banner));
what is unbuilt here is the trigger and its content.

- **Name the account, and offer to open it.** A signed-out account is the case worth getting right:
  it is both the most likely failure and the only one the user can fix.
- **Fire on the transition, not on the state.** A source that stays signed out for a week produces
  one notification, not one per poll. This is the rule `InviteWatcher` already follows
  ([`notifications.md`'s Invite watcher](../../docs/magical/notifications.md#invite-watcher)).
