export const GMAIL_BASE_URL = 'https://mail.google.com';
export const GMAIL_INBOX_URL = 'https://mail.google.com/mail/u/0/#inbox';
export const GMAIL_LOGIN_URL =
  'https://accounts.google.com/ServiceLogin?service=mail&continue=https://mail.google.com/mail/';
export const GMAIL_COMPOSE_URL = 'https://mail.google.com/mail/u/0/?view=cm&fs=1&tf=1';
export const GMAIL_COMPOSE_POPOUT_URL = 'https://mail.google.com/mail/u/0/popout';
export const GMAIL_ATOM_FEED_URL = 'https://mail.google.com/mail/feed/atom';
export const GMAIL_HELP_URL = 'https://support.google.com/mail';

export const DEFAULT_PARTITION = 'persist:magimail_personal';

export const IPC_CHANNELS = {
  GET_APP_VERSION: 'magimail:get-app-version',
  SWITCH_ACCOUNT: 'magimail:switch-account',
  GET_ACCOUNTS: 'magimail:get-accounts',
  ACTION_NEW_MESSAGE: 'magimail:action-new-message',
  ACTION_ARCHIVE: 'magimail:action-archive',
  ACTION_TRASH: 'magimail:action-trash',
  ACTION_TOGGLE_READ: 'magimail:action-toggle-read',
  ACTION_REPLY: 'magimail:action-reply',
  ACTION_REPLY_ALL: 'magimail:action-reply-all',
  ACTION_FORWARD: 'magimail:action-forward',
  ACTION_SEARCH: 'magimail:action-search',
  PERFORM_SEARCH: 'magimail:perform-search',
  THEME_GET_STATE: 'magimail:theme-get-state',
  SETTINGS_GET: 'magimail:settings-get',
  SETTINGS_SET: 'magimail:settings-set',
  ACCOUNTS_GET_CONFIG: 'magimail:accounts-get-config',
  ACCOUNTS_ADD: 'magimail:accounts-add',
  ACCOUNTS_REMOVE: 'magimail:accounts-remove',
  ACCOUNTS_UPDATE_CONFIG: 'magimail:accounts-update-config',
  CONTENT_HEIGHT_CHANGED: 'magimail:content-height-changed',
  MAILBOX_CHANGE_HINT: 'magimail:mailbox-change-hint',
  DOM_UNREAD_UPDATE: 'magimail:dom-unread-update',
  UPDATE_MISSING_CATEGORIES: 'magimail:update-missing-categories',
  FOCUS_FILTER_GET: 'magimail:focus-filter-get',
  FOCUS_FILTER_SET: 'magimail:focus-filter-set',
  NETWORK_STATUS_CHANGED: 'magimail:network-status-changed',
} as const;

export type NotificationCategory = 'primary' | 'updates' | 'promotions' | 'social' | 'forums';

export interface DomCategoryCounts {
  inbox?: number;
  primary?: number;
  updates?: number;
  promotions?: number;
  social?: number;
  forums?: number;
}

export interface DomUnreadReport {
  timestamp: number;
  lastUserInteractionAt?: number;
  counts: DomCategoryCounts;
  presentCategories: ('inbox' | NotificationCategory)[];
  hasCategoriesSection?: boolean;
  isLoaded?: boolean;
}
