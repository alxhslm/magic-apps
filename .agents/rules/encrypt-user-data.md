---
paths:
  - 'packages/core/src/secret-file.ts'
  - 'apps/**/electron-builder.json'
  - 'apps/**/src/*-store.ts'
  - 'apps/**/src/widget-cache.ts'
---

Encrypt user data at rest wherever it is practical. Read
[`sessions-and-security.md`](../../docs/shared/sessions-and-security.md) before adding or changing a
file the app writes back.

- **Cookies are encrypted.** The `enableCookieEncryption` fuse stays on in `electron-builder.json`, so
  Chromium seals session cookies with a macOS Keychain key. A test asserts it; do not remove the fuse
  or the test.
- **Local user data goes through `secret-file.ts`,** which is AES-256-GCM under a keychain key, with a
  `MAGBOX` header and the file's basename as additional authenticated data. Do not add a new account,
  settings or cache file as plain JSON.
- **Always encrypt on write, and never read a failed decrypt as plaintext.** The policy for an
  unreadable file is in the `sessions-security` rule.
