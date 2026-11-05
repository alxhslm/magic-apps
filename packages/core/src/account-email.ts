/**
 * Reads the signed-in address off Google's own account chip.
 *
 * The address is the one thing the page knows about an account that the app does not, and it
 * is what decides which Chromium profile a link belongs in. Google renders it inside the
 * chip's `aria-label` as `Google Account: Name (someone@example.com)`. The address sits in
 * parentheses whatever the interface language is, so this looks for that rather than for the
 * sentence around it, which is translated.
 *
 * Empty string when nobody is signed in, which is the state of a brand new account.
 */
export const ACCOUNT_EMAIL_SCRIPT = `(() => {
  for (const element of document.querySelectorAll('[aria-label]')) {
    const match = /\\(([^()\\s]+@[^()\\s]+)\\)/.exec(element.getAttribute('aria-label') || '');
    if (match) return match[1];
  }
  return '';
})()`;

/**
 * Whether a string looks like an address, checked before anything reaches `accounts.json`.
 *
 * The snippet runs in a page whose content Google controls, so what comes back is treated as
 * input rather than as fact: a display name with an `@` in it, or a half-filled chip, would
 * otherwise be stored as the account's identity.
 */
export function isAccountEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // One `@`, something either side, and a dot in the domain. Matches what Google signs an
  // account in with, not the full grammar, which no real address needs here.
  return /^[^\s@()]+@[^\s@()]+\.[^\s@()]+$/.test(value.trim());
}
