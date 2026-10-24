---
paths:
  - 'packages/core/src/session.ts'
  - 'packages/core/src/secret-file.ts'
  - 'apps/magimail/src/account-store.ts'
  - 'apps/magimail/src/accounts-manager.ts'
  - 'apps/magical/src/accounts.ts'
  - 'apps/magical/src/accounts-manager.ts'
  - 'apps/**/src/settings*.ts'
  - 'apps/magical/src/calendar-identity.ts'
---

Read [`sessions-and-security.md`](../../docs/shared/sessions-and-security.md) before changing any of
this.

- **Never propose OAuth.** Accounts authenticate with session cookies; OAuth needs a Google
  verification process this project does not have.
- **Fetch through the account's session.** `ses.fetch` carries the partition's cookies; `net.fetch`
  and the global `fetch` do not.
- **Secret files fail closed.** On a decrypt failure `settings.json` is left alone for the session;
  every other sealed file is discarded and rebuilt. Getting this wrong destroys user settings.
