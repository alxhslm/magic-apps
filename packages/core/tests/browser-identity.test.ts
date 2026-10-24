import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  chromeBrands,
  chromeFullVersionBrands,
  serialiseBrands,
  applyMainWorldIdentity,
} from '../src/browser-identity.js';
import {
  CHROMIUM_VERSION_FALLBACK,
  CHROME_FULL_VERSION,
  CHROME_USER_AGENT,
  CHROME_MAJOR_VERSION,
} from '../src/constants.js';

const require = createRequire(import.meta.url);

/**
 * The app derives its version at runtime, so nothing there needs keeping in sync.
 * The fallback these unit tests run under is the one hand-written version left,
 * and this is what fails when it falls behind the installed Electron.
 */
describe('Chromium version', () => {
  it('fallback matches the Chromium the installed Electron ships', () => {
    const electronBinary = require('electron') as string;
    const bundled = execFileSync(electronBinary, ['-p', 'process.versions.chrome'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
    }).trim();

    expect(bundled).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(CHROMIUM_VERSION_FALLBACK).toBe(bundled);
  });

  it('states the same major in the User-Agent as the version it derived', () => {
    expect(CHROME_USER_AGENT).toContain(`Chrome/${CHROME_MAJOR_VERSION}.0.0.0`);
  });
});

describe('brand lists', () => {
  it('claims Google Chrome as well as Chromium, at the running version', () => {
    const brands = chromeBrands();
    expect(brands).toContainEqual({ brand: 'Chromium', version: CHROME_MAJOR_VERSION });
    expect(brands).toContainEqual({ brand: 'Google Chrome', version: CHROME_MAJOR_VERSION });
  });

  it('states four-part versions in the full list and majors in the short one', () => {
    expect(chromeFullVersionBrands()).toContainEqual({
      brand: 'Google Chrome',
      version: CHROME_FULL_VERSION,
    });
    expect(chromeBrands().every((b) => !b.version.includes('.'))).toBe(true);
  });

  it('agrees between the two lists on which brands exist and in what order', () => {
    // Headers carry one list and the page's `userAgentData` the other, so a
    // divergence here is one Google can see.
    expect(chromeFullVersionBrands().map((b) => b.brand)).toEqual(
      chromeBrands().map((b) => b.brand),
    );
  });

  it('carries a GREASE entry, so nothing reads the list positionally', () => {
    expect(chromeBrands().length).toBe(3);
    expect(chromeBrands()[0].brand).not.toMatch(/Chrom/);
  });

  it('serialises to the structured-header form the hints use', () => {
    expect(serialiseBrands([{ brand: 'Chromium', version: '152' }])).toBe('"Chromium";v="152"');
    expect(serialiseBrands(chromeBrands())).toContain(
      `"Google Chrome";v="${CHROME_MAJOR_VERSION}"`,
    );
  });
});

describe('applyMainWorldIdentity', () => {
  it('is serialisable — it closes over nothing outside its arguments', () => {
    // executeInMainWorld ships the source to the page, so a module-level
    // reference would be undefined by the time it runs.
    const source = applyMainWorldIdentity.toString();
    expect(source).not.toMatch(/\bCHROME_(FULL|MAJOR)_VERSION\b|\bGOOGLE_CHROME_BRAND\b/);
    expect(source).not.toMatch(/\bimport\b|\brequire\(/);
  });
});
