import { sharedToolbarLabels } from '@magimail/core';
import { uiString, uiStringTemplate } from './strings.js';

/**
 * The toolbar's user-visible strings, keyed by the catalogue key the native side
 * looks up.
 *
 * The in-process AppKit toolbar is a dylib loaded into Electron, not a bundle, so
 * there is nowhere for a String Catalog to live and nothing for Foundation to
 * localise from. The app already authors and validates these strings, so it
 * pushes the resolved text over the addon's JSON bridge before the toolbar is
 * built. See `docs/shared/native-ui.md#localised-labels`.
 *
 * Every key here is named by the catalogue and by the Swift that renders it, so
 * a missing one is a compile-time gap in one of the two rather than a silent
 * English fallback.
 */
export function toolbarLabels(): Record<string, string> {
  return {
    // The shared keys — Search, Sign in required and the account switcher's
    // tooltips — are read by `SuiteNative` for both toolbars.
    ...sharedToolbarLabels(uiString, uiStringTemplate),
    'toolbar.newMessage': uiString('toolbar.newMessage'),
    'toolbar.archive': uiString('toolbar.archive'),
    'toolbar.delete': uiString('toolbar.delete'),
    'toolbar.toggleRead': uiString('toolbar.toggleRead'),
    'toolbar.manage': uiString('toolbar.manage'),
    'toolbar.reply': uiString('toolbar.reply'),
    'toolbar.replyAll': uiString('toolbar.replyAll'),
    'toolbar.forward': uiString('toolbar.forward'),
    'toolbar.print': uiString('toolbar.print'),
    'toolbar.print.toolTip': uiString('toolbar.print.toolTip'),
    'toolbar.print.menuPrint': uiString('toolbar.print.menuPrint'),
    'toolbar.print.menuExport': uiString('toolbar.print.menuExport'),
    'toolbar.share': uiString('toolbar.share'),
    'toolbar.share.toolTip': uiString('toolbar.share.toolTip'),
  };
}
