---
title: Diagnostics and Troubleshooting
description: Collecting diagnostic bundles, reviewing application logs, and resolving issues.
---

When encountering unexpected behaviour, Magimail and Magical provide built-in tools to inspect and resolve problems.

## Collecting Diagnostics

Both apps include an automated diagnostics tool that collects system and application state:

1. In the menu bar, open the **Help** menu.
2. Select **Collect Diagnostics…**. It is also in **Settings → Advanced** of either app: [Magimail](/help/magimail/settings/#advanced) or [Magical](/help/magical/settings/#advanced).
3. The app generates a sanitised diagnostics report and displays an action dialogue with four options:
   - **Reveal in Finder**: Locates the redacted `.zip` bundle on your Mac so you can inspect its contents.
   - **Copy System Info**: Copies your macOS version, chip architecture, app build number, and sync state to the clipboard.
   - **Report on GitHub…**: Opens the GitHub issues page with system information pre-filled.
   - **Email to Support…**: Prepares an email draft addressed to support with the diagnostic bundle attached.
4. **Privacy Protection**: All email addresses, colleague names, subjects, snippets, calendar event summaries, and authentication tokens are automatically scrubbed and redacted before the archive is written.

## Revealing Logs

To inspect raw application logs directly:

1. Select **Help → Reveal Logs in Finder**.
2. Finder opens to the app's log folder (`~/Library/Logs/Magimail` or `~/Library/Logs/Magical`).
3. Logs are rotated periodically into archives to preserve disk space.

## Resetting an Account Session

If an account gets into an invalid authentication state (for instance, after an enterprise password reset or Google token expiration):

1. Open **Settings → Accounts** ([Magimail](/help/magimail/settings/#accounts) or [Magical](/help/magical/settings/#accounts)).
2. Select the affected account.
3. Click **Reset Session…** to clear that account's stored sign-in and connect to Google again, leaving your other accounts alone.

## GitHub Community & Support

To check for known issues or request improvements:

1. Open **Help → GitHub Repository**.
2. Browse active discussions or submit an issue report.
