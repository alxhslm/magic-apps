#!/usr/bin/env node
/**
 * Writes the stylesheet Magimail injects into Gmail out to a file, so it can be
 * edited live against a running app via `--css-override=<path>`.
 *
 * The composition here mirrors `AccountsManager.buildFullCss`. It reads from
 * `packages/core/dist`, so run `pnpm --filter @magimail/core build` first if
 * `packages/core/src/css.ts` has changed.
 *
 *   node scripts/dump-gmail-css.mjs --dark -o /tmp/gmail.css
 *   node scripts/dump-gmail-css.mjs --light --ads --sidebar
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(here, '../dist/css.js');

if (!fs.existsSync(cssPath)) {
  console.error(`Built CSS module not found at ${cssPath}`);
  console.error('Run: pnpm --filter magimail build');
  process.exit(1);
}

const core = await import(cssPath);
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

const outIndex = argv.findIndex((a) => a === '-o' || a === '--out');
const out = outIndex !== -1 ? argv[outIndex + 1] : null;

if (has('--dark') && has('--light')) {
  console.error('Pass one of --dark or --light, not both');
  process.exit(1);
}

const parts = [core.getGmailCustomCss()];
parts.push(has('--light') ? core.getGmailLightModeCss() : core.getGmailDarkModeCss());
if (has('--ads')) parts.push(core.getHideAdsCss());
if (has('--sidebar')) parts.push(core.getHideSidebarCss());
const css = parts.join('\n');

if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, css);
  console.error(`Wrote ${css.length} bytes to ${path.resolve(out)}`);
} else {
  process.stdout.write(css);
}
