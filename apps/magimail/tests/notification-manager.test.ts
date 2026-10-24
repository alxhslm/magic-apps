import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  dispatchNotifications,
  setNotificationClickHandler,
  setNotificationActionHandler,
  handleNotificationEvent,
} from '../src/notification-manager.js';
import { sendToHelper } from '../src/swift-helper.js';
import { setFocusFilter } from '../src/focus-filter-manager.js';
import { type AtomMessage } from '../src/atom-poller.js';

vi.mock('../src/swift-helper.js', () => ({
  sendToHelper: vi.fn(),
  isHelperRunning: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/settings-store.js', () => ({
  loadSettings: vi.fn().mockReturnValue({
    notifications: {
      primary: 'loud',
      updates: 'silent',
    },
  }),
}));

describe('NotificationManager Focus Filter Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFocusFilter(null);
  });

  const sampleMessages: AtomMessage[] = [
    {
      id: 'msg_1',
      threadId: 'thread_1',
      title: 'Subject',
      summary: 'Snippet',
      link: 'https://mail.google.com',
      modified: '2026-09-06T12:00:00Z',
      issued: '2026-09-06T12:00:00Z',
      from: 'Test <test@example.com>',
      fromEmail: 'test@example.com',
      subject: 'Subject',
      snippet: 'Snippet',
    },
  ];

  it('dispatches notifications when no focus filter is active', () => {
    dispatchNotifications('account_work', sampleMessages);
    expect(sendToHelper).toHaveBeenCalledTimes(1);
    expect(sendToHelper).toHaveBeenCalledWith(
      'notify.dispatch',
      expect.objectContaining({
        accountId: 'account_work',
        messages: expect.arrayContaining([expect.objectContaining({ id: 'msg_1' })]),
      }),
    );
  });

  it('hands every banner to the helper, which owns Focus silencing', () => {
    // Suppression lives in `MagimailHelper` (NotificationController.dispatch), as it does in
    // Magical: one decision point, reading focus-filter.json directly. The main process holds
    // a copy for the surfaces it owns (dock badge, menu bar, widgets, switcher) but never
    // drops a banner with it. See `docs/magimail/focus-filters.md`.
    setFocusFilter({
      activeAccountIds: ['account_work'],
      disableExcludedAccounts: false,
    });

    dispatchNotifications('account_personal', sampleMessages);

    expect(sendToHelper).toHaveBeenCalledWith(
      'notify.dispatch',
      expect.objectContaining({ accountId: 'account_personal' }),
    );
  });

  it('forwards the resolved category so the helper can pick the right level', () => {
    dispatchNotifications('account_work', [{ ...sampleMessages[0], category: 'promotions' }]);
    expect(sendToHelper).toHaveBeenCalledWith(
      'notify.dispatch',
      expect.objectContaining({
        messages: [expect.objectContaining({ id: 'msg_1', category: 'promotions' })],
      }),
    );
  });

  it('defaults an untagged message to primary rather than dropping it', () => {
    // No category means the sub-feeds could not classify it — the helper must
    // still be told something, or `settings[category]` finds no row at all.
    dispatchNotifications('account_work', sampleMessages);
    expect(sendToHelper).toHaveBeenCalledWith(
      'notify.dispatch',
      expect.objectContaining({
        messages: [expect.objectContaining({ category: 'primary' })],
      }),
    );
  });

  it('handles notification click and action events', () => {
    const onClick = vi.fn();
    const onAction = vi.fn();
    setNotificationClickHandler(onClick);
    setNotificationActionHandler(onAction);

    handleNotificationEvent('notify.click', { accountId: 'acc1', messageId: 'msg1' });
    expect(onClick).toHaveBeenCalledWith({ accountId: 'acc1', messageId: 'msg1', action: 'open' });

    handleNotificationEvent('notify.action', {
      accountId: 'acc1',
      messageId: 'msg1',
      action: 'archive',
    });
    expect(onAction).toHaveBeenCalledWith({
      accountId: 'acc1',
      messageId: 'msg1',
      action: 'archive',
    });
  });

  it('forwards every action the helper can send, including trash', () => {
    const onAction = vi.fn();
    setNotificationActionHandler(onAction);

    // The identifiers NotificationController registers on magimail.message.
    for (const action of ['archive', 'markRead', 'trash']) {
      onAction.mockClear();
      handleNotificationEvent('notify.action', {
        accountId: 'acc1',
        messageId: 'thread_1',
        action,
      });
      expect(onAction).toHaveBeenCalledWith({
        accountId: 'acc1',
        messageId: 'thread_1',
        action,
      });
    }
  });
});
