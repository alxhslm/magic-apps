import type { WebContentsView } from 'electron';

export type TriageAction = 'archive' | 'trash' | 'markRead' | 'markUnread';

/** How a triage action ended. `failed` is what sends the action to a window. */
export type ThreadActionOutcome = 'ok' | 'failed';

/**
 * Acts on one named thread for one account.
 *
 * The view may be `undefined`: a sleeping account has none, and the direct write does
 * not need one. Only the DOM fallback and the refresh press read it.
 */
export interface ThreadActionDriver {
  perform(
    view: WebContentsView | undefined,
    accountId: string,
    threadId: string,
    action: TriageAction,
  ): Promise<boolean>;
}
