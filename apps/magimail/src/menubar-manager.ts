import { type AccountConfig, RetryScheduler } from '@magimail/core';
import { loadSettings } from './settings-store.js';
import { sendToHelper, isHelperRunning } from './swift-helper.js';
import { createLogger } from '@magimail/core/logger';
import { asThreadAction, TRIAGE_ACTIONS, type ThreadAction } from './accounts-manager.js';
import type { TriageAction } from './thread-actions/types.js';
import type { VerificationCodeItem } from './mailbox/types.js';
import { uiString } from './strings.js';

const log = createLogger('MenuBar');

let trayCreated = false;
let cachedVerificationCode: VerificationCodeItem | null = null;
let cachedTrayData: {
  accounts: AccountConfig[];
  totalUnread: number;
  isOffline?: boolean;
  isRestricted?: boolean;
} = {
  accounts: [],
  totalUnread: 0,
  isOffline: false,
  isRestricted: false,
};
const retryScheduler = new RetryScheduler({ maxRetries: 1, delayMs: 1000 });

export function createTray(): void {
  if (trayCreated) return;
  trayCreated = true;
  retryScheduler.reset();

  if (isHelperRunning()) {
    sendToHelper('tray.create');
  } else {
    // Every later update returns early too, so the status item stays absent
    // rather than empty; without this the only symptom is an empty menu bar.
    log.warn('The helper is not running; the status item cannot be shown');
  }
}

function sendTrayUpdate(
  accounts: AccountConfig[],
  totalUnread: number,
  options?: { isOffline?: boolean; isRestricted?: boolean },
  isRetry = false,
): void {
  if (!isRetry) {
    retryScheduler.resetAttempts();
  }
  retryScheduler.cancel();

  const settings = loadSettings();
  const promise = sendToHelper('tray.update', {
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      color: a.color,
      unreadCount: a.unreadCount,
      email: a.email || '',
      needsAuth: Boolean(a.needsAuth),
    })),
    totalUnread,
    showCount: settings.menuBarShowCount,
    showDots: settings.menuBarShowDots,
    showUnreadOnly: settings.menuBarUnreadOnly,
    menuBarVerificationCodes: settings.menuBarVerificationCodes,
    verificationCodeDurationMinutes: settings.verificationCodeDurationMinutes,
    verificationCode:
      settings.menuBarVerificationCodes && cachedVerificationCode
        ? {
            code: cachedVerificationCode.code,
            service: cachedVerificationCode.service,
            subject: cachedVerificationCode.subject,
            from: cachedVerificationCode.from,
            messageId: cachedVerificationCode.messageId,
            threadId: cachedVerificationCode.threadId,
            accountId: cachedVerificationCode.accountId,
            receivedAt: cachedVerificationCode.receivedAt,
          }
        : null,
    isOffline: options?.isOffline ?? cachedTrayData.isOffline ?? false,
    isRestricted: options?.isRestricted ?? cachedTrayData.isRestricted ?? false,
  });

  void Promise.resolve(promise).then((result) => {
    if (result === null) {
      retryScheduler.schedule(() => {
        if (trayCreated) {
          sendTrayUpdate(
            cachedTrayData.accounts,
            cachedTrayData.totalUnread,
            {
              isOffline: cachedTrayData.isOffline,
              isRestricted: cachedTrayData.isRestricted,
            },
            true,
          );
        }
      });
    } else {
      retryScheduler.resetAttempts();
    }
  });
}

export function updateTrayData(
  accounts: AccountConfig[],
  totalUnread: number,
  options?: { isOffline?: boolean; isRestricted?: boolean },
): void {
  const isOffline = options?.isOffline ?? cachedTrayData.isOffline ?? false;
  const isRestricted = options?.isRestricted ?? cachedTrayData.isRestricted ?? false;
  cachedTrayData = { accounts, totalUnread, isOffline, isRestricted };

  if (trayCreated && isHelperRunning()) {
    sendTrayUpdate(accounts, totalUnread, { isOffline, isRestricted });
  }
}

export function updateVerificationCode(code: VerificationCodeItem | null): void {
  cachedVerificationCode = code;
  if (trayCreated && isHelperRunning()) {
    sendToHelper(
      'tray.verificationCode',
      code
        ? {
            code: code.code,
            service: code.service,
            subject: code.subject,
            from: code.from,
            messageId: code.messageId,
            threadId: code.threadId,
            accountId: code.accountId,
            receivedAt: code.receivedAt,
          }
        : {},
    );
  }
}

/**
 * Put the status item back after the helper process is replaced.
 *
 * A replacement helper has no `NSStatusItem`, while `trayCreated` here still
 * says one exists — so `createTray()` would early-return and every `tray.update`
 * address something absent. The cached counts go with it, so the new item shows
 * real numbers rather than waiting for the next poll.
 */
export function restoreTray(): void {
  if (!trayCreated || !isHelperRunning()) return;
  retryScheduler.reset();

  sendToHelper('tray.create');
  sendTrayUpdate(cachedTrayData.accounts, cachedTrayData.totalUnread, {
    isRestricted: cachedTrayData.isRestricted,
  });
  if (cachedVerificationCode) {
    updateVerificationCode(cachedVerificationCode);
  }
}

export function getTrayData(): {
  accounts: AccountConfig[];
  totalUnread: number;
  isRestricted?: boolean;
} {
  return cachedTrayData;
}

export function getPopoverWindow(): null {
  // No longer an Electron window — popover is native Swift
  return null;
}

export function isTrayCreated(): boolean {
  return trayCreated;
}

export function destroyTray(): void {
  if (!trayCreated) return;
  trayCreated = false;
  retryScheduler.reset();

  if (isHelperRunning()) {
    sendToHelper('tray.destroy');
  }
}

/**
 * How many recent messages the popover is offered.
 *
 * More than the feed's current unread, because the list includes threads since
 * read; `TrayModel.retentionLimit` on the Swift side decides how many are drawn.
 */
export const RECENT_TRAY_MESSAGES = 20;

export interface TrayMessageItem {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  modified?: string | Date;
  category?: string;
  /**
   * Whether the feed still lists the message, i.e. it is unread. Omitted means
   * unread, so an older caller that only ever sent the feed's entries is
   * unchanged.
   */
  unread?: boolean;
}

export function buildTrayMessagesPayload(
  accountId: string,
  messages: TrayMessageItem[],
): { accountId: string; messages: unknown[] } {
  return {
    accountId,
    messages: messages.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      from: m.from,
      subject: m.subject || uiString('notification.noSubject'),
      snippet: m.snippet,
      internalDate: m.modified ? String(new Date(m.modified).getTime()) : '',
      category: m.category ?? 'primary',
      labelIds: m.unread === false ? [] : ['UNREAD'],
    })),
  };
}

export function pushTrayMessages(accountId: string, messages: TrayMessageItem[]): void {
  sendToHelper('tray.messages', buildTrayMessagesPayload(accountId, messages));
}

export interface TrayEventHandlerDeps {
  getMainWindow: () => { show: () => void; focus: () => void } | null;
  getAccountsManager: () => {
    switchAccount: (id: string) => void;
    triggerMailAction: (
      action:
        | 'archive'
        | 'trash'
        | 'markRead'
        | 'markUnread'
        | 'compose'
        | 'reply'
        | 'replyAll'
        | 'forward',
      accountId?: string,
    ) => void | Promise<unknown>;
    performThreadAction: (
      accountId: string,
      threadId: string,
      action: ThreadAction,
    ) => Promise<unknown>;
    openInAccount?: (accountId: string | undefined, url: string) => void;
  } | null;
  composeWithoutAccount?: () => Promise<void>;
  /**
   * Builds the main window when an entry point arrives with none, so there is a manager to
   * act through. The account is named so the view that loads is the one the action is about.
   */
  ensureWindow?: (accountId?: string, options?: { show?: boolean }) => void;
  /**
   * Runs a triage action across the window boundary.
   *
   * Triage builds no window of its own accord: the direct write is tried first, and only one it
   * cannot do builds one in the background. `ensureWindow` is for everything that asks to look
   * at something, which triage does not.
   */
  routeThreadAction?: (
    accountId: string,
    threadId: string,
    action: TriageAction,
  ) => Promise<unknown>;
  requestImmediatePoll?: (accountId: string) => void;
  pollAllNow?: () => Promise<unknown>;
  sendMessages?: (accountId: string) => void | Promise<void>;
  openSettings?: () => void;
  quitApp?: () => void;
}

export type MenuBarEventHandlerDeps = TrayEventHandlerDeps;

/**
 * Handles incoming events sent by the Swift helper process to the main process.
 */
export function handleTrayEvent(
  method: string,
  params: Record<string, unknown>,
  deps: TrayEventHandlerDeps,
): boolean {
  switch (method) {
    case 'tray.compose': {
      const accountId = params.accountId as string | undefined;
      // Composing asks to look at something, so the window is raised — and it has to exist
      // before there is a view to compose in.
      deps.ensureWindow?.(accountId, { show: true });
      const win = deps.getMainWindow();
      if (win) {
        win.show();
        win.focus();
      }
      const accountsManager = deps.getAccountsManager();
      if (accountId) {
        accountsManager?.switchAccount(accountId);
        accountsManager?.triggerMailAction('compose', accountId);
      } else {
        void deps.composeWithoutAccount?.();
      }
      return true;
    }

    case 'tray.showAccount': {
      const accountId = params.accountId as string;
      deps.ensureWindow?.(accountId, { show: true });
      const win = deps.getMainWindow();
      if (win) {
        win.show();
        win.focus();
      }
      if (accountId) {
        deps.getAccountsManager()?.switchAccount(accountId);
      }
      return true;
    }

    case 'tray.showThread': {
      const accountId = params.accountId as string;
      const threadId = params.threadId as string;
      deps.ensureWindow?.(accountId, { show: true });
      const accountsManager = deps.getAccountsManager();
      if (accountId && threadId && accountsManager) {
        void accountsManager.performThreadAction(accountId, threadId, 'open');
      }
      return true;
    }

    case 'tray.threadAction': {
      const accountId = params.accountId as string;
      const threadId = params.threadId as string;
      const action = asThreadAction(params.action, TRIAGE_ACTIONS);
      // Triage, so no window is built for it: the direct write lands without one, and only a
      // write that cannot land builds a background window. `open` is a different event.
      if (accountId && threadId && action) {
        void deps.routeThreadAction?.(accountId, threadId, action as TriageAction).then(() => {
          deps.requestImmediatePoll?.(accountId);
        });
      }
      return true;
    }

    case 'tray.search':
      {
        const query = (params.query as string) ?? '';
        const accountId = params.accountId as string | undefined;
        // A search asks to look at something, so the window is raised — and it has to exist
        // to have a view to load the results into.
        deps.ensureWindow?.(accountId, { show: true });
        const win = deps.getMainWindow();
        if (win) {
          win.show();
          win.focus();
        }
        const accountsManager = deps.getAccountsManager();
        // One call so the account is switched and woken before the search loads:
        // a search naming no account runs where the filter already points, and that
        // account may be suspended while the window is hidden.
        if (query) {
          accountsManager?.openInAccount?.(
            accountId,
            `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`,
          );
        }
      }
      return true;

    case 'tray.quit': {
      deps.quitApp?.();
      return true;
    }

    case 'tray.getMessages': {
      deps.sendMessages?.(params.accountId as string);
      return true;
    }

    // The helper asks for the window rather than opening it. The settings live
    // here, and a helper restarted since the last `settings.show` would draw the
    // built-in defaults; the answer is a `settings.show` with the state attached.
    case 'tray.openSettings': {
      deps.openSettings?.();
      return true;
    }

    case 'tray.popoverOpened': {
      deps.requestImmediatePoll?.('');
      return true;
    }

    case 'tray.refresh': {
      void deps.pollAllNow?.();
      return true;
    }

    default:
      return false;
  }
}

export const handleMenuBarEvent = handleTrayEvent;
