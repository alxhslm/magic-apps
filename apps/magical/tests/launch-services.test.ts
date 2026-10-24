import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const addonPath = path.resolve(__dirname, '../native/build/Release/magical_addon.node');

// The addon is built by `pnpm --filter magical build:native`, which a test run does not do.
// Skipping keeps a fresh clone green; the answers below are asserted wherever it has been
// built, which is every machine that can run the app.
const built = process.platform === 'darwin' && fs.existsSync(addonPath);

// Loaded inside each test, never in the body of the describe: a skipped describe still
// runs its callback to register what it would have tested, so a require out here breaks
// the run everywhere the addon has not been built.
function addon(): { hasApplicationForUrl: (url: string) => boolean } {
  return createRequire(import.meta.url)(addonPath);
}

describe.skipIf(!built)('magical addon: what LaunchServices answers', () => {
  it('finds a handler for a scheme every Mac has', () => {
    expect(addon().hasApplicationForUrl('https://example.com')).toBe(true);
  });

  it('finds none for a scheme no application can claim', () => {
    expect(addon().hasApplicationForUrl('magicalnotinstalled://join/1')).toBe(false);
  });

  it('answers a string that is not a URL rather than asking LaunchServices', () => {
    expect(addon().hasApplicationForUrl('not a url')).toBe(false);
  });
});
