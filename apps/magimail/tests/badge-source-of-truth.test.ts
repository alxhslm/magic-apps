import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Regression guard — the dock badge must count only true inbox mail.
 *
 * That property is not enforced by arithmetic anywhere in this codebase; it is
 * a property of the data source. `GMAIL_ATOM_FEED_URL` is Gmail's unread-inbox
 * feed, so drafts never appear in it and archived mail drops out of it. The
 * badge is therefore correct by construction — but only for as long as the
 * Atom poller remains the *sole* writer.
 *
 * Previously it was not. A MutationObserver in the preload parsed
 * `document.title` with /\((\d+)\+?\)/ and shipped the result to the main
 * process, so navigating to Drafts turned "Drafts (5)" into a badge of 5.
 *
 * The preload observes `document.title` again, but in a strictly weaker role:
 * it reports *that* the mailbox moved, never *what* the count is. The main
 * process answers a hint by re-polling the Atom feed, so the feed still decides
 * every number. The line these assertions defend is therefore not "the renderer
 * is silent" but "the renderer carries no count" — a hint is allowed, a value
 * is not. Ship a number across that boundary and you re-introduce the bug.
 */
const REPO_ROOT = path.resolve(__dirname, '../../..');
const read = (relPath: string) => readFileSync(path.join(REPO_ROOT, relPath), 'utf8');

/** Prose may discuss unread counts; only executable code is held to the rule. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('dock badge source of truth', () => {
  it('the preload never parses a count out of the title', () => {
    const preload = stripComments(read('apps/magimail/src/preload.ts'));
    expect(preload).not.toMatch(/parseUnreadCountFromTitle/);
    expect(preload).not.toMatch(/document\.title[\s\S]*?[0-9]/);
    expect(preload).not.toMatch(/document\.title[\s\S]*?\\d/);
  });

  it('the preload scopes navigation count parsing strictly to inbox and categories', () => {
    const preload = stripComments(read('apps/magimail/src/preload.ts'));
    expect(preload).toContain('div[role="navigation"]');
    expect(preload).toMatch(/a\[href\*="#inbox"/);
    // Never queries drafts, sent, starred, or trash for unread badges
    expect(preload).not.toMatch(/#drafts/);
    expect(preload).not.toMatch(/#sent/);
    expect(preload).not.toMatch(/#starred/);
    expect(preload).not.toMatch(/#trash/);
  });

  it('the preload emits structured DOM_UNREAD_UPDATE and bare change hint', () => {
    const preload = stripComments(read('apps/magimail/src/preload.ts'));
    expect(preload).toMatch(/ipcRenderer\.send\(IPC_CHANNELS\.DOM_UNREAD_UPDATE,\s*report\)/);
    expect(preload).toMatch(/ipcRenderer\.send\(IPC_CHANNELS\.MAILBOX_CHANGE_HINT\)/);
  });

  it('defines the required IPC channels for DOM unread updates and missing categories', () => {
    const constants = read('apps/magimail/src/constants.ts');
    expect(constants).toContain('DOM_UNREAD_UPDATE');
    expect(constants).toContain('UPDATE_MISSING_CATEGORIES');
  });

  it('the unread count retains the Gmail Atom feed as background and snippet authority', () => {
    expect(read('apps/magimail/src/constants.ts')).toMatch(
      /GMAIL_ATOM_FEED_URL = 'https:\/\/mail\.google\.com\/mail\/feed\/atom'/,
    );
  });
});
