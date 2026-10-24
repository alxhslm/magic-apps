import { describe, it, expect } from 'vitest';
import { createComposeWindowOptions, createThreadWindowOptions } from '../src/window.js';

describe('createComposeWindowOptions', () => {
  it('generates proper compose popup window defaults', () => {
    const opts = createComposeWindowOptions();

    expect(opts.titleBarStyle).toBe('default');
    expect(opts.vibrancy).toBe('under-window');
    expect(opts.title).toContain('New Message');
    expect(opts.useContentSize).toBe(true);
  });
});

describe('createThreadWindowOptions', () => {
  it('generates proper thread window defaults', () => {
    const opts = createThreadWindowOptions();

    expect(opts.titleBarStyle).toBe('default');
    expect(opts.vibrancy).toBe('under-window');
    expect(opts.title).toBe('Magimail');
    expect(opts.width).toBe(900);
    expect(opts.height).toBe(780);
  });
});
