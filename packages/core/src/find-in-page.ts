import {
  BaseWindow,
  WebContentsView,
  type WebContents,
  type Result as FoundInPageResult,
  type Event as ElectronEvent,
  type Input as ElectronInput,
} from 'electron';
import { TOOLBAR_HEIGHT } from './constants.js';
import type { UiTranslator } from './ui-strings.js';

/**
 * The catalogue keys the Find in Page view renders, so an app can assert they exist.
 */
export const FIND_IN_PAGE_KEYS = [
  'find.placeholder',
  'find.previous',
  'find.next',
  'find.close',
  'find.counter',
] as const;

export interface FindInPageOptions {
  width?: number;
  height?: number;
  topOffset?: number;
  rightOffset?: number;
}

interface FindBridgeMessage {
  type: 'query' | 'next' | 'prev' | 'close' | 'focus' | 'blur';
  query?: string;
}

const DEFAULT_WIDTH = 330;
const DEFAULT_HEIGHT = 44;
const DEFAULT_TOP_OFFSET = TOOLBAR_HEIGHT + 6;
const DEFAULT_RIGHT_OFFSET = 16;

/**
 * Generates self-contained HTML/CSS/JS for the floating Find in Page view.
 */
export function getFindInPageHtml(t: UiTranslator): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root {
    --bg: rgba(246, 246, 246, 0.86);
    --border: rgba(0, 0, 0, 0.12);
    --text: #1d1d1f;
    --text-muted: rgba(60, 60, 67, 0.6);
    --btn-hover: rgba(0, 0, 0, 0.07);
    --btn-active: rgba(0, 0, 0, 0.14);
    --stepper-bg: rgba(0, 0, 0, 0.04);
    --stepper-border: rgba(0, 0, 0, 0.08);
    --divider: rgba(60, 60, 67, 0.16);
    --shadow: 0 10px 24px -2px rgba(0, 0, 0, 0.16), 0 2px 6px rgba(0, 0, 0, 0.08);
    --focus-ring: rgba(0, 122, 255, 0.4);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: rgba(42, 42, 44, 0.86);
      --border: rgba(255, 255, 255, 0.14);
      --text: #f5f5f7;
      --text-muted: rgba(235, 235, 245, 0.6);
      --btn-hover: rgba(255, 255, 255, 0.12);
      --btn-active: rgba(255, 255, 255, 0.22);
      --stepper-bg: rgba(255, 255, 255, 0.06);
      --stepper-border: rgba(255, 255, 255, 0.1);
      --divider: rgba(235, 235, 245, 0.16);
      --shadow: 0 12px 30px -2px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3);
      --focus-ring: rgba(10, 132, 255, 0.5);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: transparent;
    user-select: none;
    -webkit-user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", "Helvetica Neue", sans-serif;
  }
  body {
    display: flex;
    align-items: center;
    padding: 4px 6px;
  }
  .bar {
    display: flex;
    align-items: center;
    width: 100%;
    height: 34px;
    background: var(--bg);
    backdrop-filter: blur(28px) saturate(190%);
    -webkit-backdrop-filter: blur(28px) saturate(190%);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow);
    padding: 0 5px 0 9px;
    gap: 6px;
    transition: border-color 0.12s ease, box-shadow 0.12s ease;
  }
  .bar:focus-within {
    border-color: var(--focus-ring);
    box-shadow: var(--shadow), 0 0 0 1.5px var(--focus-ring);
  }
  .search-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    letter-spacing: -0.1px;
    line-height: 1.4;
    outline: none;
    padding: 0;
    user-select: text;
    -webkit-user-select: text;
  }
  input::placeholder {
    color: var(--text-muted);
    opacity: 0.9;
  }
  .counter {
    font-size: 11px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    white-space: nowrap;
    padding: 0 2px;
    user-select: none;
  }
  .divider {
    width: 1px;
    height: 16px;
    background: var(--divider);
    flex-shrink: 0;
  }
  .steppers {
    display: flex;
    align-items: center;
    background: var(--stepper-bg);
    border: 1px solid var(--stepper-border);
    border-radius: 5px;
    padding: 1px;
    flex-shrink: 0;
  }
  .btn-stepper {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 19px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    cursor: pointer;
    outline: none;
    padding: 0;
    transition: background 0.08s ease;
  }
  .btn-stepper:hover {
    background: var(--btn-hover);
  }
  .btn-stepper:active {
    background: var(--btn-active);
  }
  .btn-stepper svg {
    width: 10px;
    height: 10px;
  }
  .btn-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    outline: none;
    padding: 0;
    flex-shrink: 0;
    transition: background 0.08s ease, color 0.08s ease;
  }
  .btn-close:hover {
    background: var(--btn-hover);
    color: var(--text);
  }
  .btn-close:active {
    background: var(--btn-active);
  }
  .btn-close svg {
    width: 9px;
    height: 9px;
  }
</style>
</head>
<body>
  <div class="bar">
    <div class="search-icon">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="6.5" cy="6.5" r="4.75" />
        <path d="M10 10l4.5 4.5" />
      </svg>
    </div>
    <input type="text" id="find-input" placeholder="${t('find.placeholder')}" spellcheck="false" autocomplete="off" />
    <span class="counter" id="find-counter"></span>
    <div class="divider"></div>
    <div class="steppers">
      <button id="btn-prev" class="btn-stepper" title="${t('find.previous')}">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2.5 7.5L6 4L9.5 7.5" />
        </svg>
      </button>
      <button id="btn-next" class="btn-stepper" title="${t('find.next')}">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2.5 4.5L6 8L9.5 4.5" />
        </svg>
      </button>
    </div>
    <button id="btn-close" class="btn-close" title="${t('find.close')}">
      <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5" />
      </svg>
    </button>
  </div>
  <script>
    const input = document.getElementById('find-input');
    const counter = document.getElementById('find-counter');
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    const btnClose = document.getElementById('btn-close');
    const counterFormat = ${JSON.stringify(t('find.counter'))};
    function __formatCounter(current, total) {
      return counterFormat.replace('{current}', String(current)).replace('{total}', String(total));
    }

    function post(type, payload = {}) {
      try {
        document.title = JSON.stringify({ type, ...payload, t: Date.now() + Math.random() });
      } catch (err) {}
    }

    window.__setMatches = function(activeOrdinal, matches, queryEmpty) {
      if (queryEmpty || !input.value) {
        counter.textContent = '';
      } else {
        counter.textContent = __formatCounter(matches === 0 ? 0 : activeOrdinal, matches);
      }
    };

    window.__focusInput = function() {
      input.focus();
      input.select();
    };

    input.addEventListener('focus', () => {
      post('focus');
    });

    input.addEventListener('blur', () => {
      post('blur');
    });

    document.addEventListener('mousedown', (e) => {
      if (
        e.target !== btnPrev &&
        e.target !== btnNext &&
        e.target !== btnClose &&
        !btnPrev.contains(e.target) &&
        !btnNext.contains(e.target) &&
        !btnClose.contains(e.target)
      ) {
        input.focus();
      }
    });

    input.addEventListener('input', () => {
      post('query', { query: input.value });
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        post(e.shiftKey ? 'prev' : 'next');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        post('close');
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        post(e.shiftKey ? 'prev' : 'next');
      }
    });

    btnPrev.addEventListener('click', (e) => {
      e.preventDefault();
      post('prev');
    });
    btnNext.addEventListener('click', (e) => {
      e.preventDefault();
      post('next');
    });
    btnClose.addEventListener('click', (e) => {
      e.preventDefault();
      post('close');
    });
  </script>
</body>
</html>`;
}

/**
 * Controller managing the floating native Find in Page bar.
 */
export class FindInPageController {
  private window: BaseWindow;
  private getTargetWebContents: () => WebContents | null | undefined;
  private view: WebContentsView | null = null;
  private visible = false;
  private inputFocused = false;
  private currentQuery = '';
  private boundResize: () => void;
  private currentTarget: WebContents | null = null;
  private boundFoundInPage: (event: unknown, result?: unknown) => void;
  private boundBeforeInput: (event: ElectronEvent, input: ElectronInput) => void;
  private options: Required<FindInPageOptions>;
  private t: UiTranslator;

  constructor(
    window: BaseWindow,
    getTargetWebContents: () => WebContents | null | undefined,
    t: UiTranslator,
    options?: FindInPageOptions,
  ) {
    this.window = window;
    this.getTargetWebContents = getTargetWebContents;
    this.t = t;
    this.options = {
      width: options?.width ?? DEFAULT_WIDTH,
      height: options?.height ?? DEFAULT_HEIGHT,
      topOffset: options?.topOffset ?? DEFAULT_TOP_OFFSET,
      rightOffset: options?.rightOffset ?? DEFAULT_RIGHT_OFFSET,
    };

    this.boundResize = () => {
      if (this.visible) {
        this.updatePosition();
      }
    };
    this.window.on('resize', this.boundResize);

    this.boundFoundInPage = (event: unknown, result?: unknown) => {
      this.handleFoundInPage((result ?? event) as FoundInPageResult);
    };

    this.boundBeforeInput = (event: ElectronEvent, input: ElectronInput) => {
      if (!this.visible) return;

      if (this.inputFocused) {
        event.preventDefault();
        this.focusInput();
        return;
      }

      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        this.hide();
      }
    };
  }

  public isVisible(): boolean {
    return this.visible;
  }

  public show(): void {
    const target = this.getTargetWebContents();
    this.attachToTarget(target ?? null);

    this.inputFocused = true;

    if (this.visible) {
      this.focusInput();
      return;
    }

    if (!this.view) {
      this.createView();
    }

    this.visible = true;
    if (!this.window.contentView.children.includes(this.view!)) {
      this.window.contentView.addChildView(this.view!);
    }
    this.updatePosition();

    this.focusInput();
  }

  public hide(): void {
    if (!this.visible && !this.view) return;

    this.visible = false;
    this.inputFocused = false;
    if (this.view && this.window.contentView.children.includes(this.view)) {
      this.window.contentView.removeChildView(this.view);
    }

    // Stop searching and clear selection in target
    if (this.currentTarget && !this.currentTarget.isDestroyed()) {
      try {
        this.currentTarget.stopFindInPage('clearSelection');
        this.currentTarget.focus();
      } catch {
        // Ignore if target destroyed
      }
    }
  }

  public toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  public findNext(): void {
    if (!this.visible) {
      this.show();
      return;
    }
    if (!this.currentQuery) return;
    const target = this.getTargetWebContents();
    if (target && !target.isDestroyed()) {
      target.findInPage(this.currentQuery, { forward: true, findNext: true });
    }
  }

  public findPrevious(): void {
    if (!this.visible) {
      this.show();
      return;
    }
    if (!this.currentQuery) return;
    const target = this.getTargetWebContents();
    if (target && !target.isDestroyed()) {
      target.findInPage(this.currentQuery, { forward: false, findNext: true });
    }
  }

  /**
   * Called when active account changes.
   */
  public updateTarget(newTarget?: WebContents | null): void {
    const target = newTarget ?? this.getTargetWebContents() ?? null;
    this.attachToTarget(target);
    if (this.visible && this.currentQuery && target && !target.isDestroyed()) {
      target.findInPage(this.currentQuery, { forward: true });
    }
  }

  public updatePosition(): void {
    if (!this.view || this.window.isDestroyed()) return;
    const bounds = this.window.getContentBounds();
    const x = Math.max(0, bounds.width - this.options.width - this.options.rightOffset);
    const y = this.options.topOffset;

    this.view.setBounds({
      x,
      y,
      width: this.options.width,
      height: this.options.height,
    });
  }

  public destroy(): void {
    this.hide();
    this.window.removeListener('resize', this.boundResize);
    if (this.currentTarget && !this.currentTarget.isDestroyed()) {
      this.currentTarget.removeListener('found-in-page', this.boundFoundInPage);
      this.currentTarget.removeListener('before-input-event', this.boundBeforeInput);
    }
    if (this.view) {
      if (!this.view.webContents.isDestroyed()) {
        this.view.webContents.close();
      }
      this.view = null;
    }
  }

  private createView(): void {
    this.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.view.setBackgroundColor('rgba(0, 0, 0, 0)');

    this.view.webContents.on('page-title-updated', (event, title) => {
      event.preventDefault();
      try {
        const data = JSON.parse(title) as FindBridgeMessage;
        if (!data || !data.type) return;

        switch (data.type) {
          case 'query':
            this.handleQuery(data.query || '');
            break;
          case 'next':
            this.findNext();
            break;
          case 'prev':
            this.findPrevious();
            break;
          case 'close':
            this.hide();
            break;
          case 'focus':
            this.inputFocused = true;
            break;
          case 'blur':
            this.inputFocused = false;
            break;
        }
      } catch {
        // Not a JSON message or unrelated title change
      }
    });

    this.view.webContents.once('dom-ready', () => {
      if (this.visible) {
        this.focusInput();
      }
    });

    const html = getFindInPageHtml(this.t);
    this.view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }

  private focusInput(): void {
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.focus();
      this.view.webContents
        .executeJavaScript('window.__focusInput && window.__focusInput()')
        .catch(() => {});
    }
  }

  private attachToTarget(newTarget: WebContents | null): void {
    if (this.currentTarget === newTarget) return;

    if (this.currentTarget && !this.currentTarget.isDestroyed()) {
      this.currentTarget.removeListener('found-in-page', this.boundFoundInPage);
      this.currentTarget.removeListener('before-input-event', this.boundBeforeInput);
      if (this.visible) {
        try {
          this.currentTarget.stopFindInPage('clearSelection');
        } catch {
          // Ignore
        }
      }
    }

    this.currentTarget = newTarget;

    if (this.currentTarget && !this.currentTarget.isDestroyed()) {
      this.currentTarget.on('found-in-page', this.boundFoundInPage);
      this.currentTarget.on('before-input-event', this.boundBeforeInput);
    }
  }

  private handleQuery(query: string): void {
    this.currentQuery = query;
    const target = this.getTargetWebContents();

    if (!query) {
      if (target && !target.isDestroyed()) {
        try {
          target.stopFindInPage('clearSelection');
        } catch {
          // Ignore
        }
      }
      this.updateMatchDisplay(0, 0, true);
      return;
    }

    if (target && !target.isDestroyed()) {
      target.findInPage(query, { forward: true });
    }
  }

  private handleFoundInPage(result: FoundInPageResult): void {
    if (!result) return;
    this.updateMatchDisplay(result.activeMatchOrdinal, result.matches, !this.currentQuery);
  }

  private updateMatchDisplay(activeOrdinal: number, matches: number, queryEmpty: boolean): void {
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents
        .executeJavaScript(
          `window.__setMatches && window.__setMatches(${activeOrdinal}, ${matches}, ${queryEmpty})`,
        )
        .catch(() => {});
    }
  }
}
