---
title: Privacy & Security Guide
description: Direct Google authentication, encrypted local storage, macOS system permissions, and managing your account security.
---

Magimail and Magical are designed with a strict local-first security architecture. Your email and calendar data belong entirely to you and Google. Magic Apps operates with zero intermediary servers, zero cloud synchronisation relays, and zero telemetry tracking.

---

## Google Authentication & Passwords

### Direct Google Sign-In

When adding an account in Magimail or Magical:

- Authentication occurs directly on Google's official sign-in page (`accounts.google.com`).
- **You never enter your Google password into Magic Apps**. The app cannot read, intercept, or log your credentials.
- All Google security features work natively, including 2-Step Verification (2FA), Google Authenticator prompts, Titan Security Keys and Passkeys.

### Managing & Revoking Access

Because authentication runs directly with Google:

- You can view and manage all active sessions at any time via your [Google Account Security Dashboard](https://myaccount.google.com/security).
- If your Mac is lost or stolen, you can remotely sign out or revoke access from any browser by signing in to Google and terminating the session.

---

## Local Storage & On-Disk Encryption

All data stored by Magic Apps remains strictly on your local Mac:

- **Storage Locations**:
  - Magimail: `~/Library/Application Support/Magimail`
  - Magical: `~/Library/Application Support/Magical`
  - Shared Widget Containers: `~/Library/Group Containers/group.com.alexhaslam.magimail` and `~/Library/Group Containers/group.com.alexhaslam.magical`
- **Encrypted Credentials**: Session cookies and sign-in tokens are encrypted at rest with AES-256-GCM, using keys held in the macOS Keychain. Those keys are locked to your macOS user account, so another user or another program cannot read them.
- **FileVault Protection**: When macOS FileVault is enabled, all offline email caches and calendar databases benefit from full-disk XTS-AES-128 encryption while your Mac is locked or powered off.

---

## Multi-Account Session Isolation

Each account you add to Magimail or Magical runs in its own session, kept apart from the others:

- **Nothing Shared**: Work, personal and client accounts keep separate cookies, caches and local databases.
- An email or calendar session in one account cannot read, inspect, or share data with another account.
- Removing an account in **Settings → Accounts** wipes everything that account stored on this Mac, at once. The [Settings Reference](/help/magimail/settings/#accounts) covers the tab.

---

## Managing macOS System Permissions

Magimail and Magical request only the minimal system permissions required to deliver native desktop features. You can review and adjust these permissions at any time in **System Settings → Privacy & Security**:

| Permission        | Why It Is Used                                                                                                                                                           | How to Manage                                                |
| :---------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------- |
| **Notifications** | Required to display meeting countdown banners, RSVP notifications, and new email alerts.                                                                                 | **System Settings → Notifications → Magimail / Magical**     |
| **Focus Filters** | Allows macOS to inform the app when a specific Focus (Work, Personal, Sleep) is activated so only relevant accounts appear. Focus state is processed entirely on-device. | **System Settings → Focus → [Select Focus] → Focus Filters** |
| **Automation**    | Optional. Only requested if you execute AppleScript or Apple Shortcuts automation targeting the app.                                                                     | **System Settings → Privacy & Security → Automation**        |

---

## Network Security & Telemetry

- **Direct Endpoints Only**: All network connections connect directly to Google's official production domains (`mail.google.com`, `calendar.google.com`, `clients6.google.com`) over TLS 1.3 encryption.
- **Zero Intermediary Relays**: There are no proxy servers, mirror databases, or analytics endpoints operated by Magic Apps.
- **Zero Tracking**: Neither app includes tracking pixels, third-party analytics SDKs, advertising beacons, or background usage reporting.

---

## Complete Data Purge

If you ever decide to remove Magic Apps from your computer, you can execute a complete, irrevocable data wipe:

1. Open Magimail or Magical.
2. Select **[App Name] → Remove All App Data and Quit…** from the menu bar.
3. Confirm the prompt. The app erases every account's stored session, its Keychain items, offline caches and preferences from your Mac, then quits.
4. For step-by-step instructions, see the [Uninstalling & Data Removal Guide](/help/general/uninstall/).
