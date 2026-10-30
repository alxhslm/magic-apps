import type { WebContentsView } from 'electron';
import { DOM_DRIVE_PREAMBLE, type DomClickResult } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';
import { DOM_ACTION_MAP } from '../dom-labels.js';
import type { ThreadActionDriver, TriageAction } from './types.js';

const log = createLogger('DomActionDriver');
const THREAD_TOOLBAR_ACTIONS = new Set<string>(['archive', 'trash', 'markRead', 'markUnread']);

export interface DomThreadActionHost {
  /**
   * Wakes the account's view for the action and hands back the release that puts it
   * back to sleep. Undefined when the account is unknown or Gmail never became ready.
   */
  wake: (accountId: string) => Promise<{ view: WebContentsView; release: () => void } | undefined>;
  /** A press the view refused, to retry once the editor is free. */
  onActionHeld?: (accountId: string, threadId: string, action: TriageAction) => void;
}

export class DomThreadActionDriver implements ThreadActionDriver {
  constructor(private readonly host: DomThreadActionHost) {}

  /**
   * Drives the account's own view, waking it first.
   *
   * Waking lives here so the direct write is tried before a renderer is built. The view
   * argument is ignored.
   */
  public async perform(
    _view: WebContentsView | undefined,
    accountId: string,
    threadId: string,
    action: TriageAction,
  ): Promise<boolean> {
    const woken = await this.host.wake(accountId);
    if (!woken) return false;
    const { view, release } = woken;

    try {
      return await this.performInView(view, accountId, threadId, action);
    } finally {
      release();
    }
  }

  private async performInView(
    view: WebContentsView,
    accountId: string,
    threadId: string,
    action: TriageAction,
  ): Promise<boolean> {
    // 1. Avoid navigating if already showing this thread
    if (await this.isShowingThread(view, threadId)) {
      if (action === 'markRead') return true;
      return await this.clickThreadControl(view, action);
    }

    // 2. Route view to thread
    const routed = await this.routeToThread(view, threadId);
    if (!routed) {
      log.info(`Held ${action} on thread until view is free`);
      this.host.onActionHeld?.(accountId, threadId, action);
      await this.restorePreviousRoute(view, threadId);
      return false;
    }

    // 3. Mark read is accomplished simply by routing to the thread
    if (action !== 'markRead') {
      await this.clickThreadControl(view, action);
    }

    // 4. Restore previous route
    await this.restorePreviousRoute(view, threadId);
    return true;
  }

  private isThreadUrl(url: string): boolean {
    if (!url) return false;
    try {
      const urlObj = new URL(url);
      if (urlObj.searchParams.has('th') || urlObj.searchParams.has('permthid')) return true;
      const viewParam = urlObj.searchParams.get('view');
      if (viewParam === 'cv' || viewParam === 'pt') return true;

      const hash = urlObj.hash;
      if (!hash) return false;
      const cleanHash = hash.replace(/^#/, '').split('?')[0];

      if (/^thread-[fa]:[a-zA-Z0-9_-]+$/i.test(cleanHash)) return true;
      if (!cleanHash.includes('/')) return false;

      if (
        /^(?:inbox|all|sent|starred|snoozed|trash|spam|drafts|imp|chats|section_default)\/(?!p\d+$)[a-zA-Z0-9_-]{5,}$/i.test(
          cleanHash,
        )
      ) {
        return true;
      }
      if (/^category[~/][^/]+\/(?!p\d+$)[a-zA-Z0-9_-]{5,}$/i.test(cleanHash)) {
        return true;
      }
      const parts = cleanHash.split('/');
      const prefix = parts[0].toLowerCase();
      if (prefix === 'label' || prefix === 'search' || prefix === 'advanced-search') {
        const lastPart = parts[parts.length - 1];
        if (parts.length >= 3 && !/^p\d+$/i.test(lastPart)) {
          if (
            /^[0-9a-fA-F]{12,}$/i.test(lastPart) ||
            /^FMfcg/i.test(lastPart) ||
            lastPart.length >= 10
          ) {
            return true;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  private async isShowingThread(view: WebContentsView, id: string): Promise<boolean> {
    const wc = view.webContents;
    if (wc.isDestroyed()) return false;
    const url = wc.getURL();
    if (url.includes(id)) return true;
    if (!this.isThreadUrl(url)) return false;

    try {
      return await wc.executeJavaScript(`
        Boolean(document.querySelector(
          '[data-legacy-thread-id=' + ${JSON.stringify(JSON.stringify(id))} + '],' +
          '[data-legacy-message-id=' + ${JSON.stringify(JSON.stringify(id))} + ']'
        ))
      `);
    } catch {
      return false;
    }
  }

  private async routeToThread(view: WebContentsView, threadId: string): Promise<boolean> {
    const wc = view.webContents;
    const beforeTitle = wc.getTitle();

    try {
      const routed = await wc.executeJavaScript(`
        (() => {
          if (location.hash.startsWith('#settings')) return false;
          if (document.querySelector('[role="dialog"], [role="alertdialog"]') !== null) return false;
          const active = document.activeElement;
          if (active && (
            active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.isContentEditable ||
            active.getAttribute('role') === 'textbox'
          )) {
            return false;
          }
          const textboxes = document.querySelectorAll('div[role="textbox"][contenteditable="true"]');
          for (const box of textboxes) {
            if ((box.textContent || '').trim().length > 0) return false;
          }

          window.__magimailPrevHash = location.hash;
          location.hash = '#inbox/' + ${JSON.stringify(threadId)};
          return true;
        })();
      `);
      if (routed === false) return false;
    } catch {
      return false;
    }

    const deadline = Date.now() + 5000;
    let baseline = beforeTitle;
    while (!wc.isDestroyed()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;

      const moved = await wc
        .executeJavaScript(
          `
        ${DOM_DRIVE_PREAMBLE}
        (async () => {
          const there = await waitUntil(() => document.title !== ${JSON.stringify(baseline)}, {
            timeoutMs: ${remaining},
            label: 'thread-route',
          });
          return there ? document.title : false;
        })()
      `,
        )
        .catch(() => false);

      if (moved === false || wc.isDestroyed()) return false;
      if (this.isThreadUrl(wc.getURL())) {
        await wc
          .executeJavaScript(
            `
          ${DOM_DRIVE_PREAMBLE}
          waitUntil(() => true, { quietMs: 250, timeoutMs: 5000, label: 'thread-settle' })
        `,
          )
          .catch(() => {});
        return true;
      }
      baseline = typeof moved === 'string' ? moved : baseline;
    }
    return false;
  }

  private async clickThreadControl(view: WebContentsView, action: TriageAction): Promise<boolean> {
    const domActionName = action;
    if (!THREAD_TOOLBAR_ACTIONS.has(domActionName)) return false;
    const actionEntry = DOM_ACTION_MAP.actions[domActionName];
    if (!actionEntry) return false;

    let result: DomClickResult | boolean | undefined;
    try {
      result = await view.webContents.executeJavaScript(`
        (async () => {
          ${DOM_DRIVE_PREAMBLE}

          const LIVE = '[role="alert"], [aria-live="polite"], [aria-live="assertive"], [role="status"]';
          const announcement = () =>
            Array.from(document.querySelectorAll(LIVE)).map((el) => el.textContent || '').join('\\u0000');

          const before = announcement();

          const found = await waitUntil(() => {
            const hit = findAction(document, ${JSON.stringify(actionEntry)});
            return hit.el ? hit : null;
          }, { quietMs: 0, timeoutMs: 5000, label: 'thread-control' });
          if (!found) {
            return { ok: false, reason: 'no_element', selector: null, elapsedMs: 0 };
          }

          return await clickAndConfirm(
            found.el,
            (target) => {
              const spoke = announcement() !== before;
              const btnGone = !target || !document.body.contains(target) || target.offsetParent === null;
              return spoke || btnGone;
            },
            { timeoutMs: 5000, quietMs: 250, label: ${JSON.stringify(action)}, selector: found.matchedBy }
          );
        })()
      `);
    } catch (err) {
      log.error(`Could not drive the ${action} control in the open thread:`, err);
      return false;
    }

    const isOk =
      typeof result === 'object' && result !== null
        ? Boolean(result.ok)
        : result !== undefined
          ? Boolean(result)
          : true;

    if (!isOk) {
      log.warn(`Gmail never confirmed ${action}; restoring route anyway`);
      return false;
    }

    log.info(`Confirmed ${action} control in open thread`);
    return true;
  }

  private async restorePreviousRoute(
    view: WebContentsView,
    targetThreadId?: string,
  ): Promise<void> {
    const target = JSON.stringify(targetThreadId ?? null);
    try {
      await view.webContents.executeJavaScript(`
        (() => {
          const prev = window.__magimailPrevHash;
          delete window.__magimailPrevHash;

          const target = ${target};
          if (target) {
            const onTarget =
              location.hash.includes(target) ||
              document.querySelector(
                '[data-legacy-thread-id=' + JSON.stringify(target) + '],' +
                '[data-legacy-message-id=' + JSON.stringify(target) + ']'
              ) !== null;
            if (!onTarget) return;
          }

          if (prev && prev !== location.hash) location.hash = prev;
        })();
      `);
    } catch {
      // Ignore if view destroyed
    }
  }
}
