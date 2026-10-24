import { dialog, type BaseWindow } from 'electron';
import { createLogger } from '@magimail/core/logger';
import { isHelperAvailable, sendToHelper } from './swift-helper.js';
import { loadSettings, saveSetting } from './settings-store.js';
import { uiString } from './strings.js';

const log = createLogger('DefaultClient');

/**
 * default-client.ts
 *
 * Asks once whether Magical should be the app macOS opens calendar files with.
 *
 * The claim itself belongs to the Swift helper, not here. Magimail sets its own default
 * with `app.setAsDefaultProtocolClient('mailto')` because `mailto:` is a URL scheme and
 * Electron can claim schemes; a `.ics` file is a content type, which Electron cannot
 * reach at all. See `DefaultHandler.swift`.
 *
 * macOS has no single "default calendar app" to set. It tracks one handler per type, so
 * this asks about `.ics` alone — the only thing Magical can open today. A prompt that
 * claimed everything calendar-shaped would take `webcal:` links Magical cannot yet service.
 */

interface HandlerRow {
  target: string;
  label: string;
  /** Display name of the app that opens this type today. */
  handler: string;
  isMagical: boolean;
}

interface HandlerReport {
  /** False outside an app bundle, as under `pnpm dev`. */
  canClaim: boolean;
  handlers: HandlerRow[];
}

async function queryHandlers(): Promise<HandlerReport | null> {
  if (!isHelperAvailable()) return null;
  try {
    const report = (await sendToHelper('defaults.query')) as HandlerReport | undefined;
    return report?.handlers ? report : null;
  } catch (error) {
    log.warn('Could not read the current file handlers:', error);
    return null;
  }
}

/** Names Magical as the handler for one type. Returns whether it took. */
export async function claimDefault(target: string): Promise<boolean> {
  if (!isHelperAvailable()) return false;
  try {
    const result = (await sendToHelper('defaults.claim', { target })) as { ok?: boolean };
    log.info(`Claiming ${target}: ${result?.ok ? 'ok' : 'refused'}`);
    return result?.ok === true;
  } catch (error) {
    log.warn(`Could not claim ${target}:`, error);
    return false;
  }
}

/**
 * Claims the type and reports what happened, for the menu item.
 *
 * Always answers, unlike the launch prompt: the user chose this deliberately, so silence
 * would read as a broken menu item. That includes the case where Magical already holds
 * the type, which is the answer they were looking for. Mirrors Magimail's
 * `promptSetAsDefault`.
 */
export async function promptSetAsDefault(parentWindow: BaseWindow | null): Promise<void> {
  const parent = parentWindow && !parentWindow.isDestroyed() ? parentWindow : null;
  const say = (type: 'info' | 'warning', message: string, detail: string) =>
    parent
      ? dialog.showMessageBox(parent, {
          type,
          message,
          detail,
          title: uiString('dialog.defaultCalendar.title'),
        })
      : dialog.showMessageBox({
          type,
          message,
          detail,
          title: uiString('dialog.defaultCalendar.title'),
        });

  const report = await queryHandlers();
  const ics = report?.handlers.find((h) => h.target === 'ics');

  if (!report || !ics) {
    await say(
      'warning',
      uiString('dialog.defaultCalendar.couldNotRead.message'),
      uiString('dialog.defaultCalendar.couldNotRead.detail'),
    );
    return;
  }

  if (!report.canClaim) {
    await say(
      'warning',
      uiString('dialog.defaultCalendar.devBuild.message'),
      uiString('dialog.defaultCalendar.devBuild.detail'),
    );
    return;
  }

  if (ics.isMagical) {
    await say(
      'info',
      uiString('dialog.defaultCalendar.alreadyDefault.message'),
      uiString('dialog.defaultCalendar.alreadyDefault.detail'),
    );
    return;
  }

  const claimed = await claimDefault('ics');
  await say(
    claimed ? 'info' : 'warning',
    claimed
      ? uiString('dialog.defaultCalendar.claimed.message')
      : uiString('dialog.defaultCalendar.refused.message'),
    claimed
      ? uiString('dialog.defaultCalendar.claimed.detail')
      : uiString('dialog.defaultCalendar.refused.detail'),
  );
}

/**
 * Offers to make Magical the handler for `.ics`, once.
 *
 * Asked at launch rather than the first time a file is opened: by then the user has
 * already had to find Magical in Open With, which is the friction this removes.
 *
 * Three answers rather than two. "Not Now" leaves the question open for next launch;
 * "Don't Ask Again" closes it for good, and is the reason this cannot be a plain confirm.
 */
export async function offerToBecomeDefault(parentWindow: BaseWindow | null): Promise<void> {
  if (!loadSettings().askAboutDefaultCalendarApp) return;

  const report = await queryHandlers();
  if (!report?.canClaim) return;

  const ics = report.handlers.find((h) => h.target === 'ics');
  if (!ics || ics.isMagical) return;

  const parent = parentWindow && !parentWindow.isDestroyed() ? parentWindow : null;
  const options = {
    type: 'question' as const,
    buttons: [
      uiString('dialog.defaultCalendar.useMagical'),
      uiString('dialog.defaultCalendar.notNow'),
      uiString('dialog.defaultCalendar.dontAskAgain'),
    ],
    defaultId: 0,
    cancelId: 1,
    title: uiString('dialog.defaultCalendar.title'),
    message: uiString('dialog.defaultCalendar.question'),
    detail: ics.handler
      ? uiString('dialog.defaultCalendar.explanationHandler', { handler: ics.handler })
      : uiString('dialog.defaultCalendar.explanationNoHandler'),
  };

  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);

  if (response === 0) await claimDefault('ics');
  else if (response === 2) saveSetting('askAboutDefaultCalendarApp', false);
}
