import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  validateUiStringsMap,
  DIAGNOSTICS_DIALOG_KEYS,
  PRERELEASE_EXPIRY_KEYS,
  OFFLINE_PAGE_KEYS,
  FIND_IN_PAGE_KEYS,
  SHARED_TOOLBAR_LABEL_KEYS,
  SHARED_TOOLBAR_TEMPLATE_KEYS,
} from '@magimail/core';
import { UI_STRINGS, uiString, setUiLocale } from '../src/strings.js';

const SRC_DIR = path.resolve(__dirname, '../src');

/** Keys core asks the catalogue for, which no line of app source names directly. */
const CORE_KEYS: readonly string[] = [
  ...DIAGNOSTICS_DIALOG_KEYS,
  ...PRERELEASE_EXPIRY_KEYS,
  ...OFFLINE_PAGE_KEYS,
  ...FIND_IN_PAGE_KEYS,
  ...SHARED_TOOLBAR_LABEL_KEYS,
  ...SHARED_TOOLBAR_TEMPLATE_KEYS,
];

function sourceFiles(): string[] {
  const files = fs.readdirSync(SRC_DIR, { recursive: true }) as string[];
  return files.filter((file) => file.endsWith('.ts'));
}

/** Every `uiString('key')` call site in the app's source, plus core's keys. */
function referencedKeys(): string[] {
  const keys = new Set<string>(CORE_KEYS);
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    for (const match of source.matchAll(/uiString(?:Template)?\(\s*'([^']+)'/g)) keys.add(match[1]);
  }
  return [...keys].sort();
}

/**
 * Every `uiString('key', { params })` call site, with the parameter names it
 * passes. Parsed from the source rather than run, so a branch no test exercises
 * is still checked for the placeholders its template needs.
 */
function callSites(): Array<{ key: string; params: string[] }> {
  const sites: Array<{ key: string; params: string[] }> = [];
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    for (const match of source.matchAll(/uiString\(/g)) {
      const open = match.index + match[0].length - 1;
      let depth = 0;
      let close = -1;
      for (let i = open; i < source.length; i++) {
        if (source[i] === '(') depth++;
        else if (source[i] === ')' && --depth === 0) {
          close = i;
          break;
        }
      }
      if (close === -1) continue;
      const args = source.slice(open + 1, close);
      const key = args.match(/^\s*'([^']+)'/)?.[1];
      if (!key) continue;

      const params: string[] = [];
      const braceStart = args.indexOf('{');
      if (braceStart !== -1) {
        let braces = 0;
        let braceEnd = -1;
        for (let i = braceStart; i < args.length; i++) {
          if (args[i] === '{') braces++;
          else if (args[i] === '}' && --braces === 0) {
            braceEnd = i;
            break;
          }
        }
        if (braceEnd !== -1) {
          for (const part of args.slice(braceStart + 1, braceEnd).split(',')) {
            const name = part.split(':')[0].trim();
            if (/^[A-Za-z_$][\w$]*$/.test(name)) params.push(name);
          }
        }
      }
      sites.push({ key, params });
    }
  }
  return sites;
}

describe('apps/magical/ui-strings.json', () => {
  it('validates against the shared catalogue rules', () => {
    expect(validateUiStringsMap(UI_STRINGS)).toEqual([]);
  });

  it('defines every key the source asks for', () => {
    const referenced = referencedKeys();
    expect(referenced.length).toBeGreaterThan(0);
    for (const key of referenced) {
      expect(UI_STRINGS.strings[key], `missing key: ${key}`).toBeDefined();
    }
  });

  it('leaves no key the source never asks for', () => {
    const referenced = new Set(referencedKeys());
    expect(Object.keys(UI_STRINGS.strings).filter((key) => !referenced.has(key))).toEqual([]);
  });

  it('passes every placeholder a template needs at every call site', () => {
    for (const { key, params } of callSites()) {
      const entry = UI_STRINGS.strings[key];
      if (!entry) continue; // reported by the key test above
      const placeholders = new Set<string>();
      for (const value of Object.values(entry)) {
        for (const match of value.matchAll(/\{([A-Za-z_][\w]*)\}/g)) placeholders.add(match[1]);
      }
      for (const name of placeholders) {
        expect(params, `${key} must pass {${name}}`).toContain(name);
      }
    }
  });

  it('writes English at the base and no other language yet', () => {
    for (const [key, entry] of Object.entries(UI_STRINGS.strings)) {
      expect(Object.keys(entry), key).toContain('en');
    }
  });

  it('resolves the menu, dialog and notification strings the app renders', () => {
    expect(uiString('menu.file')).toBe('File');
    expect(uiString('menu.help.about')).toBe('About Magical');
    expect(uiString('notification.lead.minutes', { count: 5 })).toBe('In 5 minutes');
    expect(uiString('dialog.defaultCalendar.title')).toBe('Default Calendar App');
  });

  it('renders English on a system language it has not been translated into', () => {
    setUiLocale('de-DE');
    try {
      expect(uiString('menu.file')).toBe('File');
      expect(uiString('notification.lead.minutes', { count: 5 })).toBe('In 5 minutes');
    } finally {
      setUiLocale('en');
    }
  });

  it('resolves en-GB overrides when the locale is British English', () => {
    setUiLocale('en-GB');
    try {
      expect(uiString('menu.view.customizeToolbar')).toBe('Customise Toolbar...');
      // Falls back to base English for untouched keys
      expect(uiString('menu.file')).toBe('File');
    } finally {
      setUiLocale('en');
    }
  });

  it('overrides only intended British English spellings in en-GB', () => {
    const gbStrings: Record<string, string> = {};
    for (const [key, entry] of Object.entries(UI_STRINGS.strings)) {
      if ('en-GB' in entry) gbStrings[key] = entry['en-GB']!;
    }
    expect(gbStrings).toEqual({
      'menu.view.customizeToolbar': 'Customise Toolbar...',
    });
  });
});
