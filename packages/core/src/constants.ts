// The browser identity Google sees, derived from the Chromium actually shipping.
// What gets scored is disagreement — a header, a JS property and an engine naming
// three different browsers — so nothing here may be pinned by hand.
//
// `process.versions.chrome` is available in the main process and in preloads
// alike. The fallback only applies where there is no Electron `process` — unit
// tests — so it never reaches Google, and `browser-identity.test.ts` fails when
// it falls behind the bundled Electron.
export const CHROMIUM_VERSION_FALLBACK = '152.0.7977.167';

export const CHROME_FULL_VERSION: string =
  (typeof process !== 'undefined' && process.versions && process.versions.chrome) ||
  CHROMIUM_VERSION_FALLBACK;

export const CHROME_MAJOR_VERSION: string = CHROME_FULL_VERSION.split('.')[0];

// Chrome's UA reduction freezes the platform at 10_15_7 and the version at
// <major>.0.0.0 — this is what a real Chrome sends, not a truncation of ours.
export const CHROME_USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR_VERSION}.0.0.0 Safari/537.36`;

export const DEFAULT_CLEAN_USER_AGENT = CHROME_USER_AGENT;

export const GOOGLE_CHROME_BRAND = 'Google Chrome';

export const TOOLBAR_HEIGHT = 52;

/** The marketing website for the Magic Apps suite. */
export const WEBSITE_URL = 'https://macmagic.app';

/** User documentation and guides for Magic Apps. */
export const HELP_URL = 'https://macmagic.app/help';
export const MAGIMAIL_HELP_URL = 'https://macmagic.app/help/magimail/getting-started';
export const MAGICAL_HELP_URL = 'https://macmagic.app/help/magical/getting-started';

/** Where both apps send bug reports, feedback and the curious. */
export const GITHUB_REPOSITORY_URL = 'https://github.com/alxhslm/magic-apps';
export const GITHUB_NEW_ISSUE_URL = `${GITHUB_REPOSITORY_URL}/issues/new`;
export const SUPPORT_EMAIL = 'support@macmagic.app';

export const DEFAULT_TRAFFIC_LIGHT_POSITION = { x: 18, y: 19 } as const;
export const COMPOSE_TRAFFIC_LIGHT_POSITION = { x: 14, y: 12 } as const;
