import type { NotificationCategory, AtomMessage } from '../atom-poller.js';
import type { TrayMessageItem } from '../menubar-manager.js';
import type { TriageAction } from '../thread-actions/types.js';

export type { TriageAction, NotificationCategory, TrayMessageItem, AtomMessage };

export type MailboxPollStatus = 'ok' | 'auth_required' | 'restricted' | 'network_error';

/**
 * A poll result in mailbox terms, so callers above the source do not import Atom.
 */
export interface MailboxPollEvent {
  accountId: string;
  status: MailboxPollStatus;
  categoryCounts?: Map<NotificationCategory, number>;
  newMessages: AtomMessage[];
  newArrivalCount: number;
  arrivalsIncomplete: boolean;
}

/**
 * Detailed breakdown of unread mail for an account, filtered by user notification preferences.
 */
export interface UnreadBreakdown {
  /** Everything unread, in every category. Not filtered by the notification settings. */
  total: number;
  /** Unread count per Gmail category tab. */
  byCategory: Map<NotificationCategory, number>;
  /**
   * True when server backlog exceeds the feed's entry window (> 20),
   * or when feed entries could not be fully resolved.
   */
  arrivalsIncomplete: boolean;
  /** Raw unadjusted <fullcount> reported by Atom root feed (if known). */
  rawFullCount: number | null;
  /** Number of known unique items currently tracked in the ledger. */
  activeCount: number;
  /** True once the ledger has any source observation or pending local action. */
  hasState: boolean;
}

/**
 * Internal ledger representation of a tracked unread message.
 */
export interface UnreadLedgerItem {
  /** Atom message ID (decimal string or 16-hex depending on source). */
  id: string;
  /** Thread ID used for deep links (#inbox/<threadId>). */
  threadId: string;
  /** Resolved category tab. */
  category: NotificationCategory;
  /** Whether the message is currently unread. */
  unread: boolean;
  /** Timestamp when the message was first observed (epoch ms). */
  observedAt: number;
  /** Timestamp of the message from Google (epoch ms), if available. */
  timestampMs?: number;
  /** Subject line. */
  subject?: string;
  /** Sender string ('Name <email>' or 'email'). */
  from?: string;
  /** Snippet preview. */
  snippet?: string;
  /** Source observation time that last set this row's state (epoch ms). */
  sourceAsOf?: number;
  /** A local triage intent the cache has not confirmed yet. */
  localIntent?: 'read' | 'unread' | 'removed';
  /** When that intent was dispatched or confirmed (epoch ms). */
  localIntentAt?: number;
}

/**
 * Record of a locally initiated triage action awaiting server confirmation.
 */
export interface TriagedRecord {
  /** Epoch timestamp when the action was dispatched. */
  triagedAt: number;
  /** When the driver confirmed the action, if it has. */
  acceptedAt?: number;
  /** Triage action performed. */
  action: TriageAction;
  /** Category of the message before triage. */
  category: NotificationCategory;
  /** Whether the row was unread before the optimistic change. */
  previousUnread?: boolean;
  /** The row's source watermark before the optimistic change. */
  previousSourceAsOf?: number;
  /** False when the row was already read, so the action must not move the count. */
  countsInTotal?: boolean;
}

/**
 * Event fired when an account's mailbox state (unread counts or message list) changes.
 */
export interface MailboxChangeEvent {
  accountId: string;
  unread: UnreadBreakdown;
  recentMessages: TrayMessageItem[];
  delta: {
    addedMessageIds: string[];
    removedMessageIds: string[];
    countChanged: boolean;
  };
}

/**
 * Clean contract between AccountsManager/main.ts and a mailbox provider.
 */
export interface MailboxSource {
  readonly accountId: string;

  /**
   * Returns the current unread count breakdown. Synchronous and 0ms.
   */
  getUnreadCounts(): UnreadBreakdown;
  /** The unread total filtered by the given categories. */
  getUnreadCountFor(categories: ReadonlySet<NotificationCategory>): number;

  /**
   * The ledger's recent rows, read and unread, for the menu bar popover and widgets.
   * Cache and Atom feed the ledger; callers never read either source directly.
   */
  getRecentMessages(limit?: number): Promise<TrayMessageItem[]>;

  /**
   * Triages a thread via direct sync mutation.
   * Immediately updates local ledger state (0ms UI latency) and dispatches POST /sync/.
   */
  triageThread(threadId: string, action: TriageAction): Promise<boolean>;

  /**
   * Forces an immediate reconciliation cycle (triggers Atom poll + cache check).
   */
  refresh(): Promise<void>;

  /** The renderer noticed a mailbox change; refresh cache and poll. */
  handleMailboxChangeHint(): Promise<void>;

  /** Changes the configured poll intervals. */
  setPollIntervals(acSeconds: number, batterySeconds: number): void;

  /** Asks for a poll now, without waiting for the next interval. */
  requestImmediatePoll(): void;

  /** Stops the source without clearing its persisted seen state. */
  stop(): void;

  /** Stops and clears persisted state for an account that is being removed. */
  forget(): void;

  /** The window woke or was unhidden. */
  handleWindowWakeOrUnhide(): Promise<void>;

  /** Tells the poller which categories the page is currently showing. */
  setFocusAndMissingCategories(isFocused: boolean, missing: NotificationCategory[]): void;

  /**
   * Updates user notification category settings ('all' | 'primary' | 'off').
   */
  updateNotificationSettings(settings: Record<string, string>): void;

  /**
   * Subscribes to mailbox change events.
   * Returns an unsubscribe function.
   */
  onChanged(callback: (event: MailboxChangeEvent) => void): () => void;

  /**
   * Releases poller timers, listeners, and resources.
   */
  destroy(): void;
}
