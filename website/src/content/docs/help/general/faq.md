---
title: Frequently Asked Questions
description: Questions about pricing, privacy, tech stack, and why Magic Apps is built for macOS.
---

Common questions about Magimail and Magical.

---

## Pricing & Sustainability

### Why did you make this app?

I wanted a proper Mac experience for Google Workspace. While I appreciate the polish of native apps like Mimestream and Fantastical, there are many proprietary features of Google Workspace that third-party API clients don't fully support. I got tired of constantly switching back and forth between dedicated apps and browser tabs.

### Is Magimail / Magical free?

**Yes, completely free while in public alpha and beta.**

The core source code is open source under the MPL-2.0 licence; it will always remain open to audit and compile yourself. As we approach 1.0, I will decide on a sustainable model to cover ongoing maintenance and Apple developer fees. The goal is to keep the software maintained; I dislike expensive subscriptions as much as you do.

### Will the source code stay open?

**Yes.** The source code for Magic Apps will always remain open source under the MPL-2.0 licence. You will always be able to clone, audit, and compile the apps yourself at no cost.

### Can I support development today?

If you would like to help cover developer tooling and Apple certificate fees, you can [sponsor on GitHub](https://github.com/sponsors/alxhslm). During the alpha, bug reports and code contributions on GitHub are just as valuable.

---

## Security & Privacy

### Can you read my emails or see my Google passwords?

**Never.** Magic Apps operates on a zero-server architecture:

- All network traffic flows directly between your Mac and Google's official servers.
- There are no intermediate proxy servers, no telemetry trackers, and no middleman backends.
- Authentication occurs directly on Google's official sign-in page (`accounts.google.com`).
- The entire codebase is public on GitHub; you can inspect the code to verify how network requests and sessions work.

### How does account isolation work?

Each added Google account runs inside its own distinct Chromium session partition, similar to browser profiles. Cookies, local storage, and caches are completely sandboxed. No information can ever leak between your work Workspace account and personal Gmail accounts.

---

## Tech Stack & Architecture

### Why does Magic Apps use Electron instead of WKWebView or native Swift?

The decision to use Electron over Apple's `WKWebView` (which uses WebKit) was driven by three technical requirements:

1. **Offline Support:** Google's offline mode only supports Chromium-based browsers (which Electron is built on). It is not supported in Safari or WebKit.
2. **Extension Compatibility:** A Chromium base provides a technical foundation to support productivity extensions (such as password managers and scheduling tools) in the future.
3. **Session Partitioning:** Electron provides fine-grained control over multi-session cookie jars, enabling multi-account management without leaking state.

### Isn't Electron bloated and memory-heavy?

Gmail and Google Calendar are enormous single-page applications. Rendering a full modern Gmail inbox with thousands of DOM nodes naturally consumes 400 MB to 600 MB of RAM whether it runs in Chrome, Safari, or Electron.

The baseline memory overhead of the Electron runtime itself is around 150 MB to 200 MB; a modest fraction of what Gmail itself uses. In addition, inactive account partitions are suspended to reduce memory usage when not in use, while background notifications for new emails and events continue to work.

### Why use Magic Apps instead of a pinned Chrome or Safari tab?

Magic Apps' major advantage is proper multi-account support. This is cleaner than juggling multiple Chrome windows or browser profiles.

In addition, both apps integrate deeply with macOS: unread badges, custom dock menus, and system notification banners. You can also peek at upcoming calendar events or quick-compose emails straight from the macOS menu bar, and filter accounts using macOS Focus modes (e.g. muting personal Gmail during work hours).

### Why not use Apple Mail or third-party IMAP clients?

IMAP clients simulate Gmail using basic folders, which breaks labels, priority inbox, category tabs, snooze, scheduled send, undo send, and Google Workspace add-ons.

Even native clients like Mimestream that use the official Gmail API are restricted to what the API supports. For example, native Gmail snooze, server-side filters, and third-party Workspace add-ons are missing or limited.

### What happens if Google changes its web interface?

Because Magic Apps connects directly to Google's web frontends, Google will occasionally tweak selectors or layout styles. Because the project is open source and built with an automated CI/CD pipeline, fixes can be pushed and verified quickly via GitHub releases. Community contributions and issue reports are always appreciated.

### Can I install Magic Apps with Homebrew?

**Yes.** Both apps are available via our official Homebrew tap:

```sh
brew install --cask alxhslm/tap/magimail
brew install --cask alxhslm/tap/magical
```
