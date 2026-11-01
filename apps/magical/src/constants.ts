import { TOOLBAR_HEIGHT } from '@magimail/core';

/** Google Calendar endpoints and the window metrics the layout is built from. */

export const CALENDAR_BASE_URL = 'https://calendar.google.com';
export const CALENDAR_APP_URL = 'https://calendar.google.com/calendar/r';
export const CALENDAR_HELP_URL = 'https://support.google.com/calendar';
export const CALENDAR_LOGIN_URL =
  'https://accounts.google.com/ServiceLogin?service=cl&continue=https://calendar.google.com/calendar/r';

/** Origins that stay inside the app; everything else is handed to the browser. */
export const INTERNAL_ORIGINS = [
  'https://calendar.google.com',
  'https://accounts.google.com',
  'https://myaccount.google.com',
] as const;

export const DEFAULT_PARTITION = 'persist:magical_personal';

/**
 * Vertical inset reserved above the calendar view for the native NSToolbar.
 */
export const TITLEBAR_HEIGHT = TOOLBAR_HEIGHT;

/**
 * How a view tells the main process what calendars its account has.
 *
 * The account is not named on the message: the main process knows which view sent it,
 * and a renderer naming its own account could name somebody else's.
 */
export const CALENDAR_LIST_CHANNEL = 'magical:calendar-list';

/**
 * How a view tells the main process that its timeframe or anchor date changed.
 */
export const GCAL_VIEW_MODE_CHANNEL = 'magical:gcal-view-mode';
