import { BrowserWindow } from 'electron';
import { DOM_DRIVE_PREAMBLE } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';
import { domAction } from './dom-labels.js';

const log = createLogger('Compose');

export interface ComposeFields {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
}

/**
 * Polls the compose window until the key Gmail input elements (To, Subject, Body)
 * are present and ready in the DOM.
 */
export async function waitForComposeElements(
  win: BrowserWindow,
  timeoutMs = 15000,
): Promise<boolean> {
  // Fields are resolved through the app's action map, whose entries are strong
  // hooks (`div[name="to"] input`, `input[name="subjectbox"]`,
  // `div[role="textbox"]`) rather than the English labels that used to lead. A
  // label would be a fallback for a control with no hook; these have one.
  const deadline = Date.now() + timeoutMs;
  while (!win.isDestroyed()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    try {
      return await win.webContents.executeJavaScript(`
        ${DOM_DRIVE_PREAMBLE}
        (async () => Boolean(await waitUntil(() => {
          const toInput = findAction(document, ${JSON.stringify(domAction('composeTo'))}).el;
          const subject = findAction(document, ${JSON.stringify(domAction('composeSubject'))}).el;
          const body = findAction(document, ${JSON.stringify(domAction('composeBody'))}).el;
          return Boolean(toInput && subject && body);
        }, { timeoutMs: ${remaining}, label: 'compose-fields' })))()
      `);
    } catch {
      // The window may still be navigating or running its initial scripts, which
      // rejects the call rather than answering it. Wait for the navigation to finish
      // rather than guessing a delay, then retry while budget remains.
      if (win.isDestroyed()) return false;
      await new Promise<void>((resolve) => {
        const wc = win.webContents;
        const done = () => {
          clearTimeout(timer);
          wc.removeListener('did-stop-loading', done);
          resolve();
        };
        // A navigation in flight is what tore the context down. If none is, retry at
        // once; the timer is the backstop so a rejection for another reason cannot
        // spin the loop.
        const timer = setTimeout(done, Math.max(0, Math.min(deadline - Date.now(), 1000)));
        if (wc.isLoading()) wc.once('did-stop-loading', done);
        else done();
      });
    }
  }
  return false;
}

/**
 * Populates Gmail compose fields (to, cc, bcc, subject, body) cleanly via
 * DOM element selection and standard DOM APIs without simulated keypresses.
 */
export async function populateComposeFields(
  win: BrowserWindow,
  fields: ComposeFields,
): Promise<boolean> {
  if (win.isDestroyed()) return false;

  const hasAnyField =
    Boolean(fields.to) ||
    Boolean(fields.cc) ||
    Boolean(fields.bcc) ||
    Boolean(fields.subject) ||
    Boolean(fields.body);

  if (!hasAnyField) return true;

  const ready = await waitForComposeElements(win);
  if (!ready || win.isDestroyed()) {
    log.warn('Timeout waiting for compose DOM elements');
    return false;
  }

  const result = await win.webContents.executeJavaScript(`
    ${DOM_DRIVE_PREAMBLE}
    (() => {
      const fields = ${JSON.stringify(fields)};
      const actions = ${JSON.stringify({
        composeTo: domAction('composeTo'),
        composeCc: domAction('composeCc'),
        composeBcc: domAction('composeBcc'),
        composeSubject: domAction('composeSubject'),
        composeBody: domAction('composeBody'),
        addCc: domAction('addCc'),
        addBcc: domAction('addBcc'),
      })};
      const res = { to: false, cc: false, bcc: false, subject: false, body: false };

      function insertRecipients(input, emails) {
        if (!input || !emails) return false;
        input.focus();

        // 1. Try standard W3C ClipboardEvent paste (native handler in PeopleKit)
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', emails);
          const pasteEvt = new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true
          });
          input.dispatchEvent(pasteEvt);
        } catch (e) {
          log.warn('Paste dispatch error:', e);
        }

        // 2. Direct input + blur fallback if paste was not captured
        if (!input.value && !resolveOrdered(['[data-hovercard-id]', '[email]'])) {
          input.value = emails;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.blur();
        }

        return true;
      }

      function revealField(action) {
        const found = findAction(document, action);
        if (found.el) {
          found.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
      }

      // 1. TO
      if (fields.to) {
        res.to = insertRecipients(findAction(document, actions.composeTo).el, fields.to);
      }

      // 2. CC
      if (fields.cc) {
        // The Cc row is hidden until its reveal control is clicked; that control
        // carries no hook, so the map reaches it by its localised label.
        revealField(actions.addCc);
        res.cc = insertRecipients(findAction(document, actions.composeCc).el, fields.cc);
      }

      // 3. BCC
      if (fields.bcc) {
        revealField(actions.addBcc);
        res.bcc = insertRecipients(findAction(document, actions.composeBcc).el, fields.bcc);
      }

      // 4. SUBJECT
      if (fields.subject) {
        const subjectInput = findAction(document, actions.composeSubject).el;
        if (subjectInput) {
          subjectInput.focus();
          subjectInput.value = fields.subject;
          subjectInput.dispatchEvent(new Event('input', { bubbles: true }));
          subjectInput.dispatchEvent(new Event('change', { bubbles: true }));
          res.subject = true;
        }
      }

      // 5. BODY
      if (fields.body) {
        const editor = findAction(document, actions.composeBody).el;
        if (editor) {
          editor.focus();
          // Use document.execCommand('insertText') for contenteditable
          const ok = document.execCommand('insertText', false, fields.body);
          if (!ok) {
            editor.innerText = fields.body;
            editor.dispatchEvent(new Event('input', { bubbles: true }));
          }
          res.body = true;
        }
      }

      return res;
    })()
  `);

  log.info('Field population result:', result);
  return true;
}

/**
 * Puts the caret in the To field. Gmail does this itself, but only for a window
 * that is focused — the quick compose hotkey opens one that is not.
 */
export async function focusToField(win: BrowserWindow, timeoutMs = 15000): Promise<boolean> {
  const ready = await waitForComposeElements(win, timeoutMs);
  if (!ready || win.isDestroyed()) return false;

  try {
    win.webContents.focus();
    return await win.webContents.executeJavaScript(`
      ${DOM_DRIVE_PREAMBLE}
      (() => {
        const toInput = findAction(document, ${JSON.stringify(domAction('composeTo'))}).el;
        if (!toInput) return false;
        toInput.focus();
        return document.activeElement === toInput;
      })()
    `);
  } catch {
    return false;
  }
}
