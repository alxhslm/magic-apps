# Marketing Site

Static marketing site for Magic Apps (`magimail` and `magical`).

Built with [Astro](https://astro.build/). Produces a clean static build into `_site/` with zero client-side JavaScript runtime.

## Commands

```sh
pnpm --filter @magimail/website run dev     # Local dev server with live reload
pnpm --filter @magimail/website run build   # Build production assets into _site/
pnpm run site                               # Shortcut from the repository root
```

## Directory Structure

```
website/
├── astro.config.mjs        Astro configuration, Starlight integration, and asset copy
├── src/
│   ├── pages/
│   │   ├── index.astro     Project overview landing page
│   │   ├── magimail.astro  Magimail product page
│   │   ├── magical.astro   Magical product page
│   │   ├── privacy.astro   Privacy policy
│   │   ├── subscribed.astro Registration confirmation page
│   │   └── 404.astro       Not found page
│   ├── content/
│   │   └── docs/help/      User help pages (Starlight markdown)
│   │       ├── magimail/   Magimail setup, accounts, shortcuts, widgets
│   │       ├── magical/    Magical setup, accounts, shortcuts, menu bar
│   │       └── general/    Privacy, deep link automation, and troubleshooting guides
│   ├── content.config.ts   Content collection config (Starlight docsLoader)
│   ├── layouts/
│   │   └── BaseLayout.astro HTML shell, metadata, and common layout
│   ├── components/
│   │   ├── Nav.astro       Sticky top navigation with GitHub icon link
│   │   ├── Footer.astro    Three-column footer with project and legal links
│   │   └── Notify.astro    Waitlist email signup block
│   ├── data/
│   │   └── site.json       Brand metadata, requirements, and URLs
│   └── assets/
│       ├── site.css        Main stylesheet
│       ├── docs.css        Starlight help theme overrides
│       └── *.svg, *.webp   App icons, vector marks, and feature screenshots
└── _site/                  Static build output (gitignored)
```

The waitlist block in `components/Notify.astro` is an EmailOctopus form embed.
EmailOctopus retired its plain-HTML list form endpoint, so sign-ups go through a form
created in its dashboard instead. `emailOctopusFormId` in `data/site.json` names that
form, and the form's own success redirect points at `/subscribed.html`. Restyle or
replace the form at EmailOctopus → Forms; the component only carries its id.

## Design Principles

- **No Developer Jargon**: Copy is written for Mac users, not engineers. Describe behavior naturally (e.g. "a proper Mac app", "checks for new mail" rather than "poll interval" or AppKit class names).
- **Native Typography**: System fonts only (`-apple-system` and `ui-monospace`). Fast loading, zero web font requests, and renders natively on macOS.
- **Unified Magic Theme**: A dark, focused stage using deep indigo, gold accents, and the shared star mark (`Mac + Google = Magic`).
- **Honest Feature Claims**: The site only highlights features that have shipped on `main`. Never advertise unbuilt or planned roadmap items.

## Screenshot Guidelines

Marketing screenshots (`shot-*.webp`) should showcase the product's native macOS features clearly:

- **Showcase Core Features**:
  - Main window with native AppKit toolbar and multi-account tabs.
  - Native menu bar popover and dynamic unread counter.
  - Rich interactive macOS notifications (actions, category badges).
  - Desktop widgets (Small, Medium, and Large layouts).
  - Instant Light and Dark appearance switching.
- **Privacy First**: Always use demo accounts with fictional correspondence (`example.com` domains). Never capture real personal mailboxes or settings panes containing personal email addresses.
- **Clean Assets**: Capture on Retina displays, crop cleanly, and save as optimized WebP images.
