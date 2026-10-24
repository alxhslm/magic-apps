# Wire format canary

The decoder pins Protocol Buffer field numbers rather than searching for them, which makes a schema
rotation fail loudly instead of returning a wrong answer silently. The canary makes that failure noticed
before a user sees it.

## Canary

A static fixture in unit tests only tests against historical snapshots. To confirm the decoder
remains up to date, `tools/wire-canary.mjs` runs against a live Google Calendar session over CDP (`--debug-port=9223`)
in demo mode (`--demo`) using a dedicated test account.

It queries the calendar sync feed inside the authenticated page context and validates:

1. **HTTP status**: exactly `200 OK` (distinguishing HTTP 401 / session expiry from schema drift).
2. **XSSI guard**: the response body starts with `)]}'\n\n` or `)]}'`.
3. **Action token**: index `0.0` is `'prefetcheventrangeaction.perr'`.
4. **Sync token**: index `0.2.0` is a non-empty string.
5. **Calendars and event tuples**: index `0.2.1` holds at least one calendar array; event tuple
   index `[0]` is a non-empty alphanumeric event id; `[5]` is a string (summary) or `null`; `[35]`
   and `[36]` parse into valid Unix timestamps (`epochMs > 1.6e12`); and
   `parsePrefetchEventRangeResponse()` completes with no unhandled exception.
6. **Schema drift diff**: asserts pinned positional indices remain stable and flags unexpected shifts.

## Privacy & Ephemerality

Because the sync feed returns calendar entries, the canary operates under strict isolation:

- **In-memory only**: Payloads are evaluated in memory and immediately discarded.
- **Zero caching / persistence**: No raw responses or parsed event records are written to disk.
- **Redacted reporting**: Event summaries, descriptions, attendee emails, and video links are never logged.
- **Test account isolation**: Must run against a test profile (`--demo`), never personal mailboxes.

See [`.agents/skills/running-the-wire-canary/SKILL.md`](../../.agents/skills/running-the-wire-canary/SKILL.md)
for step-by-step operational instructions.
