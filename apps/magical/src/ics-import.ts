import type { WebContentsView } from 'electron';
import { DOM_DRIVE_PREAMBLE, viewIsAlive } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';
import { CALENDAR_BASE_URL } from './constants.js';
import { uiString } from './strings.js';

const log = createLogger('IcsImport');

/**
 * ics-import.ts
 *
 * Puts an `.ics` file through Google Calendar's own Import pane.
 *
 * Google parses the file; Magical only works the controls. That is the point of the
 * design: every `VEVENT`, `RRULE` and `VTIMEZONE` in the file is understood by the code
 * that already understands them, and Magical never has to hold an opinion about the
 * iCalendar spec. The alternative — posting a reconstructed event to a session endpoint
 * — was rejected in `docs/magical/ics-import.md#import-pane`; Google exposes no such endpoint,
 * so it would mean a second reverse-engineered wire whose failure mode is a silently
 * dropped event.
 *
 * The file reaches the page's `<input type="file">` over CDP's `DOM.setFileInputFiles`,
 * which is the only way in: a file input's value cannot be assigned from script, by
 * design, and Magical is not going to drive a native file picker on the user's behalf.
 */

/** Where the Import pane lives. `u/0` because each partition is signed into one account. */
export const IMPORT_PANE_URL = `${CALENDAR_BASE_URL}/calendar/u/0/r/settings/export`;

/**
 * Google's own file field, addressed by its form name.
 *
 * `name="filename"` is the form's contract with Google's server rather than a rendering
 * detail, so it outlives the minified class and `jsname` attributes beside it.
 */
const FILE_INPUT_SELECTOR = 'input[type="file"][name="filename"]';

/** How long to wait for the pane, and then for Google's verdict on the file. */
const PANE_TIMEOUT_MS = 20_000;
const RESULT_TIMEOUT_MS = 30_000;

export type IcsImportOutcome =
  | { kind: 'imported'; imported: number; total: number }
  /** Google answered, and the answer was a refusal. `message` is its own wording. */
  | { kind: 'rejected'; imported: number; total: number; message?: string }
  /**
   * The pane never gave an answer we could read.
   *
   * Distinct from `rejected` because it is not a verdict on the file — it means the page
   * changed shape under us. The caller shows the pane rather than reporting a failure,
   * so a changed page costs a click rather than the feature.
   */
  | { kind: 'unconfirmed'; reason: string };

/** Google's wording, e.g. `Imported 1 out of 1 event.` or a count of 0 with a reason. */
const RESULT_PATTERN = /Imported\s+(\d+)\s+out of\s+(\d+)\s+events?\./i;

/**
 * Reads the confirmation dialog Google puts up when an import finishes.
 *
 * Exported for its own test: it is the one piece of this that can be checked without a
 * live page, and it is the piece that decides whether the user is told success or
 * failure.
 */
export function parseImportResult(dialogText: string): IcsImportOutcome | null {
  const match = RESULT_PATTERN.exec(dialogText);
  if (!match) return null;

  const imported = Number(match[1]);
  const total = Number(match[2]);
  if (imported > 0) return { kind: 'imported', imported, total };

  // Whatever Google wrote after the count is its reason; the OK button's own label is
  // not part of it.
  const message = dialogText
    .replace(RESULT_PATTERN, '')
    .replace(/\bOK\b\s*$/, '')
    .trim();
  return { kind: 'rejected', imported, total, message: message || undefined };
}

function evaluate<T>(view: WebContentsView, expression: string): Promise<T> {
  return view.webContents.executeJavaScript(expression, true) as Promise<T>;
}

/**
 * Waits inside the pane until `predicate` yields a value, and resolves to it.
 *
 * The expression runs in the page, so the Import pane is watched as it changes rather
 * than sampled from here every 250 ms. `predicate` must yield something that survives
 * the trip back — a boolean or a string — since a DOM node does not serialise.
 */
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

/**
 * Puts the file into the Import pane's file input.
 *
 * Returns whether Google reacted — the Import button starts disabled and is enabled by
 * the page's own `change` handler, so an enabled button is proof the file was accepted
 * into the form rather than merely written to the element.
 */
export async function attachFileToPane(view: WebContentsView, filePath: string): Promise<boolean> {
  const debug = view.webContents.debugger;
  if (!debug.isAttached()) debug.attach('1.3');

  await debug.sendCommand('DOM.enable');
  await debug.sendCommand('Runtime.enable');

  const handle = (await debug.sendCommand('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(FILE_INPUT_SELECTOR)})`,
  })) as { result?: { objectId?: string } };

  const objectId = handle.result?.objectId;
  if (!objectId) return false;

  await debug.sendCommand('DOM.setFileInputFiles', { files: [filePath], objectId });

  return (
    (await waitInPage<boolean>(
      view,
      `(() => {
        const input = document.querySelector(${JSON.stringify(FILE_INPUT_SELECTOR)});
        if (!input || input.files.length === 0) return false;
        const button = Array.from(document.querySelectorAll('button'))
          .find((b) => (b.textContent || '').trim() === 'Import');
        return Boolean(button) && !button.disabled;
      })()`,
      5_000,
      'ics-file-accepted',
    )) === true
  );
}

/** Waits for the pane to have rendered its file field. */
async function waitForPane(view: WebContentsView): Promise<boolean> {
  const found = await waitInPage<boolean>(
    view,
    `document.querySelector(${JSON.stringify(FILE_INPUT_SELECTOR)}) !== null`,
    PANE_TIMEOUT_MS,
    'ics-pane',
  );
  return found === true;
}

/**
 * Navigates a view to the Import pane with the file already in its input.
 *
 * Stops short of importing. Used on its own for the fallback, where the point is to hand
 * the user a pane that needs one click, and as the first half of `runImport`.
 */
export async function preparePane(view: WebContentsView, filePath: string): Promise<boolean> {
  await view.webContents.loadURL(IMPORT_PANE_URL);
  if (!(await waitForPane(view))) {
    log.warn('Import pane never rendered its file field');
    return false;
  }
  return attachFileToPane(view, filePath);
}

/**
 * Imports one file through a view already sitting on the Import pane.
 *
 * Dismisses Google's confirmation on the way out. The view is reused across imports when
 * it is the account's own, and leaving a modal open over it would block everything the
 * user does there next.
 */
export async function runImport(
  view: WebContentsView,
  filePath: string,
): Promise<IcsImportOutcome> {
  if (!(await preparePane(view, filePath))) {
    return { kind: 'unconfirmed', reason: uiString('dialog.ics.reason.paneRejected') };
  }

  const clicked = await evaluate<boolean>(
    view,
    `(() => {
      const button = Array.from(document.querySelectorAll('button'))
        .find((b) => (b.textContent || '').trim() === 'Import');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`,
  ).catch(() => false);

  if (!clicked) {
    return { kind: 'unconfirmed', reason: uiString('dialog.ics.reason.buttonUnavailable') };
  }

  const dialogText = await waitInPage<string>(
    view,
    `(() => {
      const dialog = document.querySelector('[role="dialog"],[role="alertdialog"]');
      const text = dialog && (dialog.textContent || '').trim();
      return text && /Imported/i.test(text) ? text : false;
    })()`,
    RESULT_TIMEOUT_MS,
    'ics-result',
  );

  if (!dialogText) return { kind: 'unconfirmed', reason: uiString('dialog.ics.reason.noReport') };

  await dismissDialog(view);

  const outcome = parseImportResult(dialogText);
  if (!outcome) {
    return { kind: 'unconfirmed', reason: uiString('dialog.ics.reason.unreadable') };
  }

  log.info(`Import finished: ${outcome.kind}`);
  return outcome;
}

async function dismissDialog(view: WebContentsView): Promise<void> {
  await evaluate<boolean>(
    view,
    `(() => {
      const dialog = document.querySelector('[role="dialog"],[role="alertdialog"]');
      const ok = dialog && Array.from(dialog.querySelectorAll('button'))
        .find((b) => (b.textContent || '').trim() === 'OK');
      if (!ok) return false;
      ok.click();
      return true;
    })()`,
  ).catch(() => false);
}

/** Releases the debugger this module attached, so the view is left as it was found. */
export function releaseDebugger(view: WebContentsView): void {
  try {
    if (viewIsAlive(view) && view.webContents.debugger.isAttached()) {
      view.webContents.debugger.detach();
    }
  } catch {
    // A view torn down mid-import has nothing left to detach from.
  }
}
