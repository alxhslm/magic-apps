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

export interface ReadAccountEmailOptions {
  /** Runs the snippet in the page and resolves with whatever it returned. */
  read: () => Promise<unknown>;
  /** False once the page has gone, which stops the retries rather than aiming at nothing. */
  isAlive?: () => boolean;
  /**
   * How many looks before giving up until the next page load.
   *
   * A settled document is not a painted one: Google's chrome arrives after
   * `did-stop-loading`, so the chip is often missing on the first look and present a moment
   * later. Four over six seconds covers a slow first paint without leaving a timer behind.
   */
  attempts?: number;
  delayMs?: number;
  /** The wait, injectable so a test does not spend the delay. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Reads an account's address off the page it is signed in to.
 *
 * Resolves with `null` when the page never shows one, which is the honest answer for a page
 * that is not signed in, is still loading, or is not a Google page at all. Callers keep the
 * address; this only knows how to find it.
 */
export async function readAccountEmail(options: ReadAccountEmailOptions): Promise<string | null> {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 1500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.isAlive && !options.isAlive()) return null;

    // The page throws when it navigates mid-script, which is not a reason to stop looking:
    // it is one lost attempt, and the next look happens on the new document.
    const value = await options.read().catch(() => undefined);
    if (isAccountEmail(value)) return value.trim();

    if (attempt < attempts - 1) await sleep(delayMs);
  }

  return null;
}
