/**
 * Turns a link for one app's web interface into the other app's deep link.
 *
 * A calendar link in an email belongs in Magical, and a Gmail link in an event belongs in
 * Magimail: both are already running, both show the same Google data, and the browser is the
 * only place the link is guaranteed to be the wrong one. Nothing here guesses at which account
 * a link belongs to; the app on the other side opens its active account, which is the account
 * whose link you were looking at.
 */

export interface CrossAppLink {
  /** The app that should open this, as a deep-link scheme. */
  scheme: 'magimail' | 'magical';
  /** The URL to hand to macOS, which routes it to that app. */
  deepLink: string;
}

/** Bundle identifiers, so the caller can check the other app is installed before offering it. */
export const APP_BUNDLE_IDS = {
  magimail: 'com.alexhaslam.magimail',
  magical: 'com.alexhaslam.magical',
} as const;

/**
 * A Gmail or Google Calendar web address, as the deep link that opens it in our own app.
 *
 * Returns null for everything else, including the app's own internal navigation: a link that
 * stays inside one app never reaches the router at all, and a link to something else is the
 * browser's business.
 */
export function crossAppLink(rawUrl: string): CrossAppLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase();
  if (host === 'mail.google.com' || host === 'gmail.com' || host === 'www.gmail.com') {
    return { scheme: 'magimail', deepLink: gmailDeepLink(url) };
  }
  if (host === 'calendar.google.com') {
    return { scheme: 'magical', deepLink: calendarDeepLink(url) };
  }
  if (
    (host === 'www.google.com' || host === 'google.com') &&
    url.pathname.startsWith('/calendar/')
  ) {
    return { scheme: 'magical', deepLink: calendarDeepLink(url) };
  }
  if (host === 'tasks.google.com') {
    return { scheme: 'magical', deepLink: 'magical://tasks' };
  }
  return null;
}

/** Gmail's folder views, as the deep links Magimail answers. */
const GMAIL_VIEW_ROUTES: Record<string, string> = {
  sent: 'sent',
  drafts: 'drafts',
  starred: 'starred',
  snoozed: 'snoozed',
  spam: 'spam',
  trash: 'trash',
  all: 'all',
  imp: 'important',
};

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getParam(params: URLSearchParams, ...keys: string[]): string | null {
  for (const key of keys) {
    const direct = params.get(key);
    if (direct !== null) return direct;
  }
  for (const [k, v] of params.entries()) {
    if (keys.some((target) => target.toLowerCase() === k.toLowerCase())) {
      return v;
    }
  }
  return null;
}

/**
 * Gmail addresses its views in the fragment: `#inbox/<thread>`, `#search/<query>`, `#sent`.
 *
 * The `u/<n>` segment is the account's position in the browser's own sign-in list, which has
 * nothing to do with our account ids, so it is dropped rather than misread as one.
 */
function gmailDeepLink(url: URL): string {
  // `?view=cm&to=…&su=…&body=…` is the compose link Gmail hands out.
  if (url.searchParams.get('view') === 'cm') {
    const fields = new URLSearchParams();
    for (const key of ['to', 'cc', 'bcc', 'su', 'subject', 'body']) {
      const value = url.searchParams.get(key);
      if (value) fields.set(key, value);
    }
    const query = fields.toString();
    return `magimail://compose${query ? `?${query}` : ''}`;
  }

  if (url.searchParams.get('extsrc') === 'mailto') {
    const rawTarget = url.searchParams.get('url');
    if (rawTarget) {
      try {
        const mailto = new URL(rawTarget);
        if (mailto.protocol === 'mailto:') {
          const fields = new URLSearchParams();
          const pathTo = mailto.pathname ? safeDecode(mailto.pathname).trim() : '';
          const queryTo = getParam(mailto.searchParams, 'to')?.trim() ?? '';
          const to = [pathTo, queryTo].filter(Boolean).join(',');
          if (to) fields.set('to', to);
          for (const key of ['subject', 'body', 'cc', 'bcc'] as const) {
            const value =
              key === 'subject'
                ? (getParam(mailto.searchParams, 'subject', 'su') ??
                  getParam(url.searchParams, 'subject', 'su'))
                : (getParam(mailto.searchParams, key) ?? getParam(url.searchParams, key));
            if (value) fields.set(key, value);
          }
          const query = fields.toString();
          return `magimail://compose${query ? `?${query}` : ''}`;
        }
      } catch {
        // Fall through to bare compose
      }
    }
    return 'magimail://compose';
  }

  const rawFragment = url.hash.replace(/^#/, '');
  const [fragment, fragmentQuery] = rawFragment.split('?');
  const hashParams = new URLSearchParams(fragmentQuery ?? '');
  const [view, ...rest] = fragment.split('/');

  const getQueryParam = (key: string): string | null =>
    url.searchParams.get(key) || hashParams.get(key);

  if (view === 'search') {
    const query = rest.join('/');
    return query
      ? `magimail://search?q=${encodeURIComponent(safeDecode(query))}`
      : 'magimail://inbox';
  }

  // A thread can sit under any mailbox, and under a label after the label's own segments.
  // `#all/FMfcgz…`, `#sent/FMfcgz…` and `#label/Work/FMfcgz…` all name one message.
  const threadId = view === 'label' || view === 'category' ? rest[rest.length - 1] : rest[0];
  if (threadId && isGmailThreadId(threadId)) {
    return `magimail://thread/${encodeURIComponent(threadId)}`;
  }

  const th = getQueryParam('th');
  if (th && isGmailThreadId(th)) {
    return `magimail://thread/${encodeURIComponent(th)}`;
  }
  const permthid = getQueryParam('permthid');
  if (permthid && isGmailThreadId(permthid)) {
    return `magimail://thread/${encodeURIComponent(permthid)}`;
  }

  const route = GMAIL_VIEW_ROUTES[view];
  if (route) {
    return `magimail://${route}`;
  }

  if ((view === 'label' || view === 'category') && rest.length > 0) {
    return `magimail://${view}/${rest.join('/')}`;
  }

  const searchQuery = getQueryParam('q');
  const hasNoHashView = !fragment || fragment === 'inbox' || view === 'inbox';
  if (searchQuery && hasNoHashView) {
    return `magimail://search?q=${encodeURIComponent(searchQuery)}`;
  }

  const isCalendarSource = url.searchParams.get('extsrc') === 'cal' || url.searchParams.has('plid');
  if (isCalendarSource) {
    return `magimail://navigate?url=${encodeURIComponent(url.toString())}`;
  }

  const hasNoViewOrFolder = !fragment || fragment === 'inbox' || view === 'inbox';
  if (hasNoViewOrFolder && url.searchParams.size === 0 && hashParams.size === 0) {
    return 'magimail://inbox';
  }

  return `magimail://navigate?url=${encodeURIComponent(url.toString())}`;
}

/**
 * Calendar addresses carry the date in the path and the event in the `eid` parameter.
 *
 * `at` is midnight on the day shown: the other app reveals the event, which is a moment, or
 * opens the day, which is a date, and midnight is the date without inventing a time.
 */
function calendarDeepLink(url: URL): string {
  // Google's add-to-calendar form. Keep the fields it understands and let Magical open its
  // own event editor with them, rather than rebuilding an editor or dropping the event.
  if (url.searchParams.get('action') === 'TEMPLATE') {
    const fields = new URLSearchParams({ action: 'TEMPLATE' });
    for (const key of ['text', 'dates', 'details', 'location', 'ctz', 'trp', 'crm']) {
      const value = url.searchParams.get(key);
      if (value) fields.set(key, value);
    }
    return `magical://quick-add?${fields.toString()}`;
  }

  const query = url.searchParams.get('q');
  if (/\/search(?:\/|$)/.test(url.pathname)) {
    return query ? `magical://search?q=${encodeURIComponent(query)}` : 'magical://search';
  }
  if (query) {
    return `magical://search?q=${encodeURIComponent(query)}`;
  }

  if (/\/r\/tasks(?:\/|$)/.test(url.pathname)) {
    return 'magical://tasks';
  }

  const eid = url.searchParams.get('eid');
  if (eid) {
    let action = 'reveal';
    if (url.searchParams.get('action') === 'RESPOND') {
      const rst = url.searchParams.get('rst');
      if (rst === '1') {
        action = 'yes';
      } else if (rst === '2') {
        action = 'no';
      } else if (rst === '3') {
        action = 'maybe';
      }
    }
    return `magical://event?eid=${encodeURIComponent(eid)}&action=${action}`;
  }

  const eventEditMatch = /\/eventedit\/(?:copy\/)?([^/?#]+)/.exec(url.pathname);
  if (eventEditMatch) {
    return `magical://event?eid=${encodeURIComponent(eventEditMatch[1])}&action=reveal`;
  }

  const day = dayFromPath(url.pathname);
  if (day) {
    return `magical://date?at=${encodeURIComponent(`${day}T00:00:00.000Z`)}`;
  }

  const path = url.pathname.replace(/\/+$/, '');
  const isRootCalendarPath =
    !path || /^\/calendar(?:\/u\/\d+)?(?:\/r)?$/.test(path) || path === '/calendar/render';

  if (isRootCalendarPath && url.searchParams.size === 0) {
    return 'magical://open';
  }

  return `magical://navigate?url=${encodeURIComponent(url.toString())}`;
}

/** Gmail's opaque thread ids, plus the legacy hex form (64-bit int, typically 10-16 hex chars). */
export function isGmailThreadId(value: string): boolean {
  return /^(?:FMfcgz|KtbxL)[A-Za-z0-9]+$/.test(value) || /^[0-9a-f]{10,16}$/i.test(value);
}

/** `/calendar/u/0/r/day/2026/11/5` and its `week`, `month` and `year` siblings. */
function dayFromPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  const yearIndex = parts.findIndex((part) => /^\d{4}$/.test(part));

  if (yearIndex === -1 || parts.length < yearIndex + 2) return null;

  const year = parts[yearIndex];
  const month = parts[yearIndex + 1];
  const day = parts[yearIndex + 2] ?? '1';
  if (!/^\d{1,2}$/.test(month) || !/^\d{1,2}$/.test(day)) return null;

  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
