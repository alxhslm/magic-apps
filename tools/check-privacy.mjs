#!/usr/bin/env node
/**
 * A privacy gate for the tree, the staged diff and the commit message.
 *
 * Debugging against a live Google account makes the real client name, series id, address
 * or office the most recognisable strings in front of you, and it is easy to lift them
 * straight into a test, a doc or a commit message. This is the mechanical check that stops
 * that, rather than relying on anyone remembering.
 *
 * Two sources of truth:
 *
 * - `.sensitive-terms`, one term per line, case-insensitive, `#` comments. It is
 *   **gitignored on purpose**: committing the list would publish the very names it
 *   protects. Keep the local copy current.
 * - A generic sweep for email addresses whose domain is not a known test or Google
 *   synthetic domain, which catches an address the denylist does not name yet.
 *
 * Usage:
 *   node tools/check-privacy.mjs --staged          # files staged for commit
 *   node tools/check-privacy.mjs --message <path>  # a commit message file
 *   node tools/check-privacy.mjs --all             # every tracked file
 */
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Domains that are obviously synthetic, so an address on one is not a leak. */
export const ALLOWED_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'example',
  'test',
  'invalid',
  'localhost',
  'work.com',
  'google.com',
  'group.calendar.google.com',
  'group.v.calendar.google.com',
  'import.calendar.google.com',
  'tasks.google.com',
  'birthdays.google.com',
  'calendar.google.com',
]);

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export function loadDenylist(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.toLowerCase());
}

function looksBinary(text) {
  return text.includes('\u0000');
}

/**
 * Everything wrong with one blob of text.
 *
 * `emails` is off for a file because fixtures invent addresses that look real
 * (`alice@gmail.com`), so a domain allowlist cannot tell a synthetic one from a leaked one;
 * the denylist guards the tree. A commit message has no fixtures in it, so the sweep is
 * safe there and catches an address the denylist does not name yet.
 */
export function inspectText(name, text, denyTerms, { emails = false } = {}) {
  const findings = [];
  const haystack = text.toLowerCase();
  for (const term of denyTerms) {
    if (haystack.includes(term)) findings.push(`${name}: sensitive term "${term}"`);
  }
  const b64Tokens = text.match(/[A-Za-z0-9+/]{8,}={0,2}/g) ?? [];
  for (const token of b64Tokens) {
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      if (decoded && /^[\x20-\x7E]+$/.test(decoded)) {
        const decodedLower = decoded.toLowerCase();
        for (const term of denyTerms) {
          if (decodedLower.includes(term)) {
            findings.push(`${name}: sensitive term "${term}" in base64 token`);
          }
        }
        for (const email of decoded.match(EMAIL) ?? []) {
          const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
          if (!ALLOWED_DOMAINS.has(domain)) {
            findings.push(`${name}: non-test email "${email}" in base64 token`);
          }
        }
      }
    } catch {
      // Ignore invalid base64 or decode errors
    }
  }
  if (emails) {
    for (const email of text.match(EMAIL) ?? []) {
      const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
      if (!ALLOWED_DOMAINS.has(domain)) findings.push(`${name}: non-test email "${email}"`);
    }
  }
  return findings;
}

function root() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function stagedFiles() {
  return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function readStaged(repo, file) {
  try {
    return execFileSync('git', ['show', `:${file}`], { encoding: 'utf8' });
  } catch {
    return readFileSync(path.join(repo, file), 'utf8');
  }
}

function main() {
  const repo = root();
  const denyTerms = loadDenylist(path.join(repo, '.sensitive-terms'));
  const mode = process.argv[2];
  let findings = [];

  if (mode === '--message') {
    const file = process.argv[3];
    findings = inspectText(
      path.basename(file ?? 'commit message'),
      readFileSync(file, 'utf8'),
      denyTerms,
      { emails: true },
    );
  } else if (mode === '--staged') {
    for (const file of stagedFiles()) {
      const text = readStaged(repo, file);
      if (!looksBinary(text)) findings.push(...inspectText(file, text, denyTerms));
    }
  } else if (mode === '--all') {
    for (const file of trackedFiles()) {
      let text;
      try {
        text = readFileSync(path.join(repo, file), 'utf8');
      } catch {
        continue;
      }
      if (!looksBinary(text)) findings.push(...inspectText(file, text, denyTerms));
    }
  } else {
    console.error('usage: check-privacy.mjs --staged | --message <file> | --all');
    process.exit(2);
  }

  if (findings.length > 0) {
    console.error('\n[privacy] refusing to continue:');
    for (const finding of findings.slice(0, 50)) console.error(`  ${finding}`);
    if (findings.length > 50) console.error(`  … and ${findings.length - 50} more`);
    console.error(
      '\nReplace the real identifier with a synthetic one. Add a name to .sensitive-terms\n' +
        '(gitignored) if the denylist is missing it. See .agents/rules/privacy.md.\n',
    );
    process.exit(1);
  }

  console.error('[privacy] clean');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
