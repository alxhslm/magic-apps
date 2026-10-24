#!/usr/bin/env node
/**
 * calendar-truth.mjs
 *
 * Fetches what Google's Calendar API says is on the account, to diff against a replay of the wire.
 * This is the other half of `.agents/skills/replaying-the-calendar-wire/SKILL.md`: the capture is
 * what the app reads, this is what Google says should be there, and the diff is the disagreement.
 *
 * The output is the account's own data, so write it under /tmp and keep it there.
 *
 * Usage:
 *   node tools/calendar-truth.mjs --credentials-dir ~/.google_workspace_mcp/credentials \
 *     --emails me@example.com,other@example.com \
 *     --from 2026-10-02T00:00:00Z --to 2026-12-12T23:59:59Z --out /tmp/corpus/truth.json
 *
 * Each account needs an authorized-user file, `<email>.json`, holding `client_id`, `client_secret`
 * and `refresh_token` — what the Google Workspace MCP writes. Only `globalThis.fetch` is used, so
 * there is nothing to install.
 *
 * The window must be the one the replay is scored over, character for character. `timeMin` is a
 * time, not a day, so `now - 9d` cuts off the first morning of the range and turns every event in
 * it into a disagreement; see the skill.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
let credentialsDir = null;
let emails = [];
let timeMin = null;
let timeMax = null;
let out = null;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--credentials-dir') credentialsDir = argv[++i];
  else if (arg === '--emails')
    emails = argv[++i]
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
  else if (arg === '--from') timeMin = argv[++i];
  else if (arg === '--to') timeMax = argv[++i];
  else if (arg === '--out') out = argv[++i];
  else if (arg === '--help' || arg === '-h') {
    console.log(
      'usage: node tools/calendar-truth.mjs --credentials-dir <dir> --emails a@b,c@d --from <ISO> --to <ISO> --out <file>',
    );
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }
}

if (!credentialsDir || emails.length === 0 || !timeMin || !timeMax || !out) {
  console.error('--credentials-dir, --emails, --from, --to and --out are all required');
  process.exit(1);
}

/** A short-lived access token from the stored refresh token. */
async function accessToken(credentials) {
  const response = await globalThis.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new globalThis.URLSearchParams({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: credentials.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) throw new Error(`token refresh failed: ${response.status}`);
  return (await response.json()).access_token;
}

/** A page of a Calendar API list endpoint, following `nextPageToken` to the end. */
async function listAll(url, token) {
  const items = [];
  let pageToken = null;
  do {
    const page = new globalThis.URL(url);
    if (pageToken) page.searchParams.set('pageToken', pageToken);
    const response = await globalThis.fetch(page, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const body = await response.json();
    items.push(...(body.items ?? []));
    pageToken = body.nextPageToken ?? null;
  } while (pageToken);
  return items;
}

const truth = {};
for (const email of emails) {
  let credentials;
  try {
    credentials = JSON.parse(
      readFileSync(join(credentialsDir.replace(/^~/, homedir()), `${email}.json`), 'utf8'),
    );
  } catch {
    console.warn(`no credentials for ${email}`);
    continue;
  }

  const token = await accessToken(credentials);
  const calendarIds = (
    await listAll(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250',
      token,
    )
  ).map((calendar) => calendar.id);

  // One entry per calendar holding the event, which is what the API returns and what the replay's
  // uid-first matching expects.
  const items = [];
  for (const calendarId of calendarIds) {
    try {
      const events = await listAll(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events` +
          `?singleEvents=true&maxResults=2500&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`,
        token,
      );
      for (const event of events) items.push({ ...event, _calendar: calendarId });
    } catch (err) {
      // A calendar the token cannot read is not fatal to the rest.
      console.warn(`warn ${email} ${calendarId}: ${err.message}`);
    }
  }

  truth[email] = items;
  console.log(`${email}: ${items.length} entries across ${calendarIds.length} calendars`);
}

writeFileSync(out, JSON.stringify(truth));
console.log(`wrote ${out}`);
