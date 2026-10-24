# Security Policy

Magic Apps wraps Google Calendar and Gmail in a native macOS shell. It holds the user's
Google sessions, so a flaw in that shell can expose the account behind it. Reports are
welcome and are read by the maintainer.

## Reporting a vulnerability

**Do not open a public issue for a security problem.** A public report tells everyone
about the flaw before there is a fix.

Use GitHub's private vulnerability reporting:

1. Open the [Security tab](https://github.com/alxhslm/magic-apps/security).
2. Choose **Report a vulnerability**.
3. Describe the problem in the private advisory.

The advisory stays visible only to the maintainer until it is published. If private
reporting is unavailable, open a minimal issue asking for a private channel, without
naming the flaw, and a maintainer will follow up.

## What to include

- **What the flaw is**, and the impact you believe it has.
- **How to reproduce it**, on which macOS version and which app (Magimail or Magical).
- **The version or commit** you tested.
- Any logs, from **Help → Reveal Log…**, with secrets removed.

## Scope

In scope:

- Session handling: the per-account Chromium partitions, the `SAPISIDHASH` signing, the
  cookie jar, and the login flow.
- Credential storage: `secret-file.ts`, the Keychain-backed AES-256-GCM seal, and the
  `accounts.json` and settings files.
- IPC between the Electron main process, the Swift helper and the C++ N-API addon, and
  the URLs and distributed notifications that reach it.
- The Share, WidgetKit and App Intents extensions and the App Group container.
- Anything that reaches user data from another process, another account, or a website
  the user did not open.

Out of scope:

- Flaws in Google's own services. Report those to Google.
- Anything that needs an attacker who already has the unlocked machine, the user's
  password or the ability to run code as the user.
- The public browser API key and the team ID in the App Group identifiers. Neither is a
  secret; see [`docs/magical/google-tasks.md`](docs/magical/google-tasks.md) and
  [`docs/shared/building-and-signing.md`](docs/shared/building-and-signing.md).

## Supported versions

Only `main` is supported. A fix ships as a commit to `main`.

## Disclosure

A confirmed report is fixed privately, then published as a GitHub security advisory once
the fix is on `main`. Credit is given unless you ask otherwise.
