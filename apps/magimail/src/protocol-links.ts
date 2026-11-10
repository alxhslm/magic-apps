/**
 * protocol-links.ts
 *
 * The one thing `magimail://` launch links are read for before the window exists:
 * the account they name, so a cold launch builds its first view for the account the
 * link targets. See `docs/shared/deep-links.md`.
 */

export const MAGIMAIL_PROTOCOL = 'magimail';

/**
 * The account a `magimail://` link names, if any.
 *
 * Every route (`thread`, `inbox`, `search`, `compose`, `share`) carries an
 * optional `account`. A link without one, or one that is not `magimail:`,
 * leaves the choice to the caller — a `mailto:` names no account at all.
 */
export function accountIdFromLink(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== `${MAGIMAIL_PROTOCOL}:`) return undefined;
    return url.searchParams.get('account') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a target URL points to a Gmail route that Magimail is built to render
 * inside an account's WebContentsView.
 *
 * Prevents `magimail://navigate?url=...` from loading arbitrary third-party URLs in
 * an authenticated session partition.
 */
export function isAllowedGmailNavigationUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'mail.google.com' || host === 'gmail.com' || host === 'www.gmail.com';
  } catch {
    return false;
  }
}
