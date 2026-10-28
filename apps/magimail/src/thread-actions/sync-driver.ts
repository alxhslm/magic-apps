import type { WebContentsView } from 'electron';
import { session } from 'electron';
import { createLogger } from '@magimail/core/logger';
import { DOM_ACTION_MAP } from '../dom-labels.js';
import { gmailSyncStateFor, headerNames } from '../gmail-sync-state.js';
import type { ThreadActionDriver, TriageAction } from './types.js';

const log = createLogger('SyncActionDriver');

/** Gmail's internal sync mutation endpoint, at the account slot Gmail itself used. */
export function syncEndpoint(accountIndex: string): string {
  return `https://mail.google.com/sync/u/${accountIndex}/i/s?hl=en-GB&c=1&rt=r&pt=ji`;
}

/** The toolbar refresh control, shared with the DOM driver's action map. */
const REFRESH_CONTROL_SELECTOR = DOM_ACTION_MAP.actions.refresh?.selectors?.[0] ?? 'div[act="20"]';

/**
 * One triage action's mutation, as the `/sync/` wire protocol names it.
 *
 * The label slots are `[add, remove, refs]`. The side a spec goes on is what the spec
 * does, not its command code, so archive's removal of `^i` sits in the remove slot.
 */
const SYNC_MUTATIONS: Record<
  TriageAction,
  { command: number; add: string[] | null; remove: string[] | null }
> = {
  archive: { command: 1414, add: null, remove: ['^i'] },
  trash: { command: 1413, add: ['^k'], remove: null },
  markUnread: { command: 1413, add: ['^u'], remove: null },
  markRead: { command: 1414, add: null, remove: ['^u', '^us'] },
};

/**
 * Converts a thread identifier (legacy hex from the Atom feed, decimal string,
 * or full thread reference) into the internal `thread-f:...` and `msg-f:...` references
 * expected by Gmail's `/sync/` wire protocol.
 */
export function toThreadReference(threadId: string): { threadRef: string; msgRef: string } | null {
  const clean = (threadId || '').trim();
  if (!clean) return null;

  // 1. 16-character hexadecimal ID from the Atom feed (e.g. "1a00000000000002")
  if (/^[0-9a-f]{16}$/i.test(clean)) {
    try {
      const dec = BigInt('0x' + clean).toString();
      return { threadRef: `thread-f:${dec}`, msgRef: `msg-f:${dec}` };
    } catch {
      return null;
    }
  }

  // 2. Direct decimal thread ID string
  if (/^\d{15,20}$/.test(clean)) {
    return { threadRef: `thread-f:${clean}`, msgRef: `msg-f:${clean}` };
  }

  // 3. Already a formatted thread reference (e.g. "thread-f:1873497444986126338")
  if (/^thread-[a-z]:\d+$/i.test(clean)) {
    const colonIdx = clean.indexOf(':');
    const typeChar = clean.charAt(7);
    const numPart = clean.slice(colonIdx + 1);
    return { threadRef: clean, msgRef: `msg-${typeChar}:${numPart}` };
  }

  return null;
}

/**
 * Builds the `/sync/` mutation body for one action on one message.
 *
 * Built apart from the post so the wire shape is tested without a partition.
 */
export function buildSyncPayload(
  action: TriageAction,
  threadRef: string,
  msgRef: string,
): unknown[] | null {
  const mutation = SYNC_MUTATIONS[action];
  if (!mutation) return null;

  const labelSpecs = [mutation.add, mutation.remove, [msgRef]];
  return [
    null,
    [[[mutation.command, [threadRef, [null, null, null, null, null, null, labelSpecs]]]]],
    [3, 7808095, null, null, [30, 0], null, 1],
    [Date.now(), 1, Date.now() + 100, 0, 635],
    2,
  ];
}

/**
 * Presses Gmail's toolbar refresh control so the open list re-renders.
 *
 * Gmail acts on `mousedown`, so a bare `click()` refreshes nothing, and the press
 * prefers a drawn control over a hidden 0x0 one. The leave events and blur take off the
 * hover class and focus the sequence leaves behind.
 */
export const CLICK_REFRESH_CONTROL = `
const clickRefresh = () => {
  try {
    const selector = ${JSON.stringify(REFRESH_CONTROL_SELECTOR)};
    const controls = Array.from(document.querySelectorAll(selector));
    if (controls.length === 0) return false;

    const isDrawn = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const button = controls.find(isDrawn) || controls[0];

    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    button.click();
    button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: true }));
    button.blur?.();

    return true;
  } catch {
    return false;
  }
};
`;

/**
 * Presses Gmail's toolbar refresh control in an open WebContents.
 */
export async function pressRefreshControl(wc: Electron.WebContents | undefined): Promise<boolean> {
  if (!wc || wc.isDestroyed()) return false;
  try {
    const refreshed = await wc.executeJavaScript(
      `(() => {\n${CLICK_REFRESH_CONTROL}\nreturn clickRefresh();\n})()`,
    );
    return Boolean(refreshed);
  } catch (err) {
    log.warn(`Could not press the refresh control: ${err}`);
    return false;
  }
}

export interface SyncThreadActionDriverOptions {
  /** The account's partition, where its captured `/sync/` headers live. */
  getAccountContext: (accountId: string) => { partition: string } | undefined;
  /**
   * The account's live view, if it has one. Never builds one.
   *
   * A direct write changes the server without telling Gmail's client, so an open list
   * is pressed to re-render.
   */
  existingView?: (accountId: string) => WebContentsView | undefined;
  /** Test seam: a main-process fetch without a live partition. */
  fetchImpl?: (partition: string, url: string, init: RequestInit) => Promise<Response>;
}

/**
 * Direct triage writes over Google's internal `POST /sync/u/<n>/i/s`.
 *
 * The partition's cookies authenticate the request and the headers captured from the
 * page are replayed, so the write needs no page. A false return sends the action to the
 * DOM driver instead.
 */
export class SyncThreadActionDriver implements ThreadActionDriver {
  constructor(private readonly options: SyncThreadActionDriverOptions) {}

  public async perform(
    _view: WebContentsView | undefined,
    accountId: string,
    threadId: string,
    action: TriageAction,
  ): Promise<boolean> {
    const refs = toThreadReference(threadId);
    if (!refs) {
      log.warn(`Cannot resolve thread reference for action ${action}`);
      return false;
    }

    const payload = buildSyncPayload(action, refs.threadRef, refs.msgRef);
    if (!payload) {
      log.warn(`Unsupported triage action ${action}`);
      return false;
    }

    const account = this.options.getAccountContext(accountId);
    if (!account) {
      log.info(`No account context for ${accountId}; ${action} cannot go direct`);
      return false;
    }

    const captured = gmailSyncStateFor(account.partition);
    if (!captured) {
      log.info(`No captured /sync/ headers for ${account.partition}; ${action} cannot go direct`);
      return false;
    }

    // Content-Type and X-Google-BTD belong to the mutation; the rest are the page's own
    // headers, including the XSRF token.
    const headers = {
      ...captured.headers,
      'Content-Type': 'application/json',
      'X-Google-BTD': '1',
    };

    try {
      const response = await this.fetch(account.partition, syncEndpoint(captured.accountIndex), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        cache: 'no-store',
      });
      const text = await response.text();

      if (!response.ok) {
        log.warn(
          `Direct ${action} refused: HTTP ${response.status} (headers [${headerNames(headers)}])`,
        );
        return false;
      }
      if (text.startsWith('["er"')) {
        log.warn(`Direct ${action} answered an "er" envelope despite HTTP 200`);
        return false;
      }

      log.info(`Direct ${action} accepted: HTTP ${response.status}`);
      await this.pressRefresh(accountId, action);
      return true;
    } catch (err) {
      log.warn(`Direct ${action} threw: ${err}`);
      return false;
    }
  }

  private fetch(partition: string, url: string, init: RequestInit): Promise<Response> {
    if (this.options.fetchImpl) return this.options.fetchImpl(partition, url, init);
    return session.fromPartition(partition).fetch(url, init);
  }

  /**
   * Presses Gmail's refresh control in a view that is already open.
   *
   * Skipped when the account has no view: the write has landed, and the next sync
   * picks it up.
   */
  private async pressRefresh(accountId: string, action: TriageAction): Promise<void> {
    const wc = this.options.existingView?.(accountId)?.webContents;
    if (!wc || wc.isDestroyed()) return;

    const refreshed = await pressRefreshControl(wc);
    if (refreshed === false) {
      log.warn(`Direct ${action} left the Gmail list unrefreshed: no refresh control was drawn`);
    }
  }
}
