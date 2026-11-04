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
    'toolbar.invite.noTitle': uiString('toolbar.invite.noTitle'),
    'toolbar.navigation': uiString('toolbar.navigation'),
    'toolbar.newTask': uiString('toolbar.newTask'),
    'toolbar.newEvent': uiString('toolbar.newEvent'),
    'toolbar.invitations': uiString('toolbar.invitations'),
    'toolbar.invitations.empty': uiString('toolbar.invitations.empty'),
    'toolbar.invitations.markAllRead': uiString('toolbar.invitations.markAllRead'),
    'toolbar.invitations.tooltip.none': uiString('toolbar.invitations.tooltip.none'),
    'toolbar.invitations.tooltip.noneUnread': uiString('toolbar.invitations.tooltip.noneUnread'),
    'toolbar.invitations.tooltip.one': uiString('toolbar.invitations.tooltip.one'),
    // Left as a template: the count is only known on the native side, which fills
    // it in when it draws the tooltip.
    'toolbar.invitations.tooltip.many': uiStringTemplate('toolbar.invitations.tooltip.many'),
    'toolbar.invite.accept': uiString('toolbar.invite.accept'),
    'toolbar.invite.maybe': uiString('toolbar.invite.maybe'),
    'toolbar.invite.decline': uiString('toolbar.invite.decline'),
    'toolbar.invite.markRead': uiString('toolbar.invite.markRead'),
    'toolbar.invite.openInCalendar': uiString('toolbar.invite.openInCalendar'),
    'toolbar.nav.previous': uiString('toolbar.nav.previous'),
    'toolbar.nav.today': uiString('toolbar.nav.today'),
    'toolbar.nav.today.toolTip': uiString('toolbar.nav.today.toolTip'),
    'toolbar.nav.next': uiString('toolbar.nav.next'),
    'toolbar.toggleSidebar': uiString('toolbar.toggleSidebar'),
  };
}
