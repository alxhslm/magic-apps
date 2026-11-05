/**
 * Reads the signed-in address off Google's account chip, which is what decides the Chromium
 * profile for a link.
 *
 * The `aria-label` reads `Google Account: Name (someone@example.com)`. The address stays in
 * parentheses whatever the interface language, so that is what this looks for. Empty string when
 * nobody is signed in.
 */
export const ACCOUNT_EMAIL_SCRIPT = `(() => {
  for (const element of document.querySelectorAll('[aria-label]')) {
    const match = /\\(([^()\\s]+@[^()\\s]+)\\)/.exec(element.getAttribute('aria-label') || '');
    if (match) return match[1];
  }
  return '';
})()`;

/**
 * Whether a string looks like an address, checked before anything reaches `accounts.json`. The
 * page's content is Google's, so the answer is input rather than fact.
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
 * Reads an account's address off the page it is signed in to. `null` means the page never showed
 * one, whether it is signed out, still loading or not a Google page.
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
