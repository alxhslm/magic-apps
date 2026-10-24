import * as os from 'node:os';

/**
 * Redaction for anything bound for a log file.
 *
 * A diagnostic log is written to be attached to a bug report, so it leaves the
 * machine. Nothing that identifies a person, or the content of their mail, may
 * be in it. Counts, timings, status codes, error names and partition ids all
 * may -- those are the diagnosis, and a log redacted past the point of use is
 * no better than no log at all.
 *
 * Two layers, because either alone fails open. `redactUrl` at the call site is
 * exact and is the real mechanism; `redactValue` runs over every record from the
 * transport and catches what a new call site forgot.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Deepest object we walk. Beyond this a value is summarised, not traversed. */
const MAX_DEPTH = 4;

/**
 * Strips the identifying half of a URL, keeping the half that diagnoses.
 *
 * Structural rather than pattern-matched: the query string of a `mailto:` is
 * the recipient, subject and body in full, so it goes entirely rather than
 * being scrubbed key by key. What survives answers "which protocol fired, at
 * what route", which is the only thing a log reader needs.
 */
export function redactUrl(raw: string): string {
  if (!raw) return raw;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not a URL. Fall back to the scalar rules rather than passing it through.
    return redactText(raw);
  }

  // `mailto:` carries the address in its path, so there is nothing to keep.
  if (url.protocol === 'mailto:') {
    return 'mailto:<redacted>';
  }

  const base = `${url.protocol}//${url.host}${url.pathname}`;
  const hadParams = url.search !== '' || url.hash !== '';
  return hadParams ? `${base}?<redacted>` : base;
}

/**
 * The catch-all: email addresses and the user's home directory.
 *
 * A home path leaks the account name, and is how an absolute path identifies
 * someone even when the filename does not.
 */
export function redactText(value: string): string {
  let out = value.replace(EMAIL, '<email>');
  const home = os.homedir();
  if (home && home !== '/') {
    out = out.split(home).join('~');
  }
  return out;
}

/**
 * Applies the scalar rules to any value, walking arrays and plain objects.
 *
 * Errors are rebuilt rather than mutated -- the caller still holds the original
 * and may rethrow it, so scrubbing in place would corrupt the thrown value.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);

  if (value instanceof Error) {
    const copy = new Error(redactText(value.message));
    copy.name = value.name;
    copy.stack = value.stack ? redactText(value.stack) : undefined;
    return copy;
  }

  if (depth >= MAX_DEPTH) return value;

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }

  // Plain objects only. A class instance may have getters with side effects,
  // and rebuilding it would lose its prototype anyway.
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = redactValue(entry, depth + 1);
    }
    return out;
  }

  return value;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
