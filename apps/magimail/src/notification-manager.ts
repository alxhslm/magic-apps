import { loadSettings } from './settings-store.js';
import { type AtomMessage } from './atom-poller.js';
import { sendToHelper, isHelperRunning } from './swift-helper.js';
import { createLogger } from '@magimail/core/logger';
import { uiString } from './strings.js';

const log = createLogger('Notifications');

export interface NotificationAction {
  accountId: string;
  messageId: string;
  action?: 'archive' | 'trash' | 'markRead' | 'open';
}

export type NotificationClickCallback = (action: NotificationAction) => void;
export type NotificationActionCallback = (action: NotificationAction) => void;

let onClickCallback: NotificationClickCallback | null = null;
let onActionCallback: NotificationActionCallback | null = null;

export function setNotificationClickHandler(callback: NotificationClickCallback): void {
  onClickCallback = callback;
}

export function setNotificationActionHandler(callback: NotificationActionCallback): void {
  onActionCallback = callback;
}

/**
 * Process new messages from a poll result and dispatch native notifications
 * via the Swift helper process using UNUserNotificationCenter.
 */
export function dispatchNotifications(accountId: string, newMessages: AtomMessage[]): void {
  // "No new-mail banners" is the likeliest report this app gets, and both ways
  // of dropping one looked identical to no mail having arrived.
  if (!isHelperRunning()) {
    log.warn(`Helper unavailable; no banner for ${newMessages.length} message(s) on ${accountId}`);
    return;
  }
  if (newMessages.length === 0) return;

  const settings = loadSettings();

  // Senders, subjects and snippets are mail content and stay out of the log.
  // How many banners were asked for, and for which account, is the diagnosis.
  log.info(`Posting ${newMessages.length} banner(s) for ${accountId}`);

  // Focus silencing is the helper's job, at the moment it would post; the main process holds
  // the filter only for the surfaces it owns. See `docs/magimail/focus-filters.md`.
  sendToHelper('notify.dispatch', {
    accountId,
    messages: newMessages.map((msg) => ({
      id: msg.id,
      threadId: msg.threadId,
      from: msg.from,
      subject: msg.subject || uiString('notification.noSubject'),
      snippet: msg.snippet,
      // Unclassifiable messages go out as `primary` rather than unset, so the
      // helper always has a row of the settings matrix to look up.
      category: msg.category ?? 'primary',
    })),
    notifications: settings.notifications,
  });
}

/**
 * Handle notification events from the Swift helper.
 * Called from the main helper event handler.
 */
export function handleNotificationEvent(method: string, params: Record<string, unknown>): boolean {
  if (method === 'notify.click') {
    const accountId = params.accountId as string;
    const messageId = params.messageId as string;
    // Logged on arrival, not only on the action that follows: a click the helper
    // never sends and one that arrives but opens nothing look identical otherwise.
    log.info(`Received notify.click: account=${accountId} message=${messageId}`);
    onClickCallback?.({
      accountId,
      messageId,
      action: 'open',
    });
    return true;
  }

  if (method === 'notify.action') {
    const accountId = params.accountId as string;
    const messageId = params.messageId as string;
    const action = params.action as 'archive' | 'trash' | 'markRead';

    log.info(`Received notify.action: account=${accountId} message=${messageId} action=${action}`);
    onActionCallback?.({
      accountId,
      messageId,
      action,
    });
    return true;
  }

  return false;
}
