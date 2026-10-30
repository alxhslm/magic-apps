import type { NotificationCategory, AtomMessage } from '../atom-poller.js';
import type { TrayMessageItem } from '../menubar-manager.js';
import type { TriageAction } from '../thread-actions/types.js';

export type { TriageAction, NotificationCategory, TrayMessageItem, AtomMessage };

/**
 * Detailed breakdown of unread mail for an account, filtered by user notification preferences.
 */
export interface UnreadBreakdown {
  /** Effective aggregate unread count for badge and menu bar display. */
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
}

/**
 * Record of a locally initiated triage action awaiting server confirmation.
 */
export interface TriagedRecord {
  /** Epoch timestamp when the action was dispatched. */
  triagedAt: number;
  /** Triage action performed. */
  action: TriageAction;
  /** Category of the message before triage. */
  category: NotificationCategory;
  /**
   * True once a feed entry for this message has been seen during the grace window.
   * A later absence then proves the server applied the write; absence alone does not,
   * because a backlog feed only lists its first twenty entries.
   */
  seenInFeed?: boolean;
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

  /**
   * Retrieves the most recent messages for the menu bar popover and widgets.
   * Prefers enriched cache data, falling back to Atom feed entries.
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
