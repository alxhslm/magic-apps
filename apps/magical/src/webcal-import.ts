import type { WebContentsView } from 'electron';
import { DOM_DRIVE_PREAMBLE } from '@magimail/core';
import { createLogger, redactUrl } from '@magimail/core/logger';
import { CALENDAR_BASE_URL } from './constants.js';
import { uiString } from './strings.js';

const log = createLogger('WebcalImport');

/**
 * webcal-import.ts
 *
 * Subscribes a Google Calendar account to a webcal / iCal feed through Google's
 * own "From URL" settings pane (`/settings/addbyurl`).
 *
 * Unlike `.ics` file imports, which require Chrome DevTools Protocol to attach
 * local files to a restricted `<input type="file">`, subscribing to a feed uses a
 * standard text input field. Plain JavaScript can set the value, dispatch input
 * events, and click "Add calendar" directly in a hidden WebContentsView without
 * debugger attachment or interrupting the user's active view.
 */

/** Where the Add by URL pane lives in Google Calendar. */
export const ADDBYURL_PANE_URL = `${CALENDAR_BASE_URL}/calendar/u/0/r/settings/addbyurl`;

const PANE_TIMEOUT_MS = 20_000;
const RESULT_TIMEOUT_MS = 30_000;

export type WebcalSubscriptionOutcome =
  | { kind: 'subscribed' }
  | { kind: 'rejected'; reason?: string }
  | { kind: 'unconfirmed'; reason: string };

/** Matches Google Calendar's snackbars and error notices when adding a calendar from URL. */
export function parseWebcalResult(text: string): WebcalSubscriptionOutcome {
  const trimmed = text.trim();
  if (/(calendar added|settings saved|calendar created|imported)/i.test(trimmed)) {
    return { kind: 'subscribed' };
  }

  if (
    /(could not fetch|failed|invalid|error|unable to|not a valid|failed to add|could not access)/i.test(
      trimmed,
    )
  ) {
    return { kind: 'rejected', reason: trimmed };
  }

  return { kind: 'unconfirmed', reason: trimmed };
}

function evaluate<T>(view: WebContentsView, expression: string): Promise<T> {
  return view.webContents.executeJavaScript(expression, true) as Promise<T>;
}

async function waitInPage<T>(
  view: WebContentsView,
  predicate: string,
  timeoutMs: number,
  label: string,
): Promise<T | null> {
  try {
    const found = await evaluate<T | false>(
      view,
      `${DOM_DRIVE_PREAMBLE}
       (async () => (await waitUntil(() => (${predicate}), {
         timeoutMs: ${timeoutMs},
         label: ${JSON.stringify(label)},
       })) || false)()`,
    );
    return found === false ? null : found;
  } catch {
    return null;
  }
}

/** Waits for the pane to have rendered its URL field and Add calendar button. */
async function waitForPane(view: WebContentsView): Promise<boolean> {
  const found = await waitInPage<boolean>(
    view,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        /Add calendar/i.test((b.textContent || '').trim()),
      );
      const container = btn?.closest('c-wiz') || document;
      const input = Array.from(container.querySelectorAll('input')).find(
        (i) => i.type !== 'hidden' && i.type !== 'checkbox' && i.type !== 'radio' && i.name !== 'q',
      );
      return Boolean(input && btn);
    })()`,
    PANE_TIMEOUT_MS,
    'webcal-pane',
  );
  return found === true;
}

/**
 * Puts the feed URL into the input field and dispatches change events.
 */
export async function populateFeedUrl(view: WebContentsView, feedUrl: string): Promise<boolean> {
  return (
    (await evaluate<boolean>(
      view,
      `(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          /Add calendar/i.test((b.textContent || '').trim()),
        );
        const container = btn?.closest('c-wiz') || document;
        const input = Array.from(container.querySelectorAll('input')).find(
          (i) => i.type !== 'hidden' && i.type !== 'checkbox' && i.type !== 'radio' && i.name !== 'q',
        );
        if (!input) return false;
        input.focus();
        if (${JSON.stringify(feedUrl)}) {
          input.value = ${JSON.stringify(feedUrl)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        }
        return true;
      })()`,
    ).catch(() => false)) === true
  );
}

/**
 * Navigates a view to the From URL pane with the feed URL already in its input.
 */
export async function prepareWebcalPane(view: WebContentsView, feedUrl: string): Promise<boolean> {
  await view.webContents.loadURL(ADDBYURL_PANE_URL);
  if (!(await waitForPane(view))) {
    log.warn('From URL pane never rendered its input field');
    return false;
  }
  return populateFeedUrl(view, feedUrl);
}

/**
 * Subscribes to a feed through a view already sitting on the From URL pane.
 */
export async function runWebcalSubscription(
  view: WebContentsView,
  feedUrl: string,
): Promise<WebcalSubscriptionOutcome> {
  if (!(await prepareWebcalPane(view, feedUrl))) {
    return { kind: 'unconfirmed', reason: uiString('dialog.webcal.reason.paneRejected') };
  }

  const clicked = await evaluate<boolean>(
    view,
    `(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const button = buttons.find((b) => /Add calendar/i.test((b.textContent || '').trim()));
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`,
  ).catch(() => false);

  if (!clicked) {
    return { kind: 'unconfirmed', reason: uiString('dialog.webcal.reason.buttonUnavailable') };
  }

  const resultText = await waitInPage<string>(
    view,
    `(() => {
      const textEls = Array.from(
        document.querySelectorAll(
          '[aria-live], div[id*="help-text"], [role="status"], [role="alert"], [data-mdc-dialog-action], .Y5186b, .b0t70b',
        ),
      );
      for (const el of textEls) {
        const text = (el.textContent || '').trim();
        if (
          text &&
          /(calendar added|settings saved|calendar created|imported|could not fetch|failed|invalid|error|unable to|not a valid|could not access)/i.test(
            text,
          )
        ) {
          return text;
        }
      }
      const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
      if (dialog) {
        const text = (dialog.textContent || '').trim();
        if (text) return text;
      }
      return false;
    })()`,
    RESULT_TIMEOUT_MS,
    'webcal-result',
  );

  if (!resultText) {
    return { kind: 'unconfirmed', reason: uiString('dialog.webcal.reason.noReport') };
  }

  const outcome = parseWebcalResult(resultText);
  log.info(`Webcal subscription finished: ${outcome.kind} for ${redactUrl(feedUrl)}`);
  return outcome;
}
