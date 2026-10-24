import { describe, it, expect } from 'vitest';
import { type AppTheme, GOOGLE_SURFACE_PALETTE, getGoogleSurfaceColor } from '../src/theme.js';

describe('AppTheme type', () => {
  it('accepts valid theme values', () => {
    const themes: AppTheme[] = ['system', 'light', 'dark'];
    expect(themes).toHaveLength(3);
  });
});

describe('getGoogleSurfaceColor', () => {
  it('selects light or dark colour from an injected palette', () => {
    const testPalette = { light: 'test-light', dark: 'test-dark' };
    expect(getGoogleSurfaceColor(false, testPalette)).toBe('test-light');
    expect(getGoogleSurfaceColor(true, testPalette)).toBe('test-dark');
  });

  it('defaults to the shared Google surface palette', () => {
    expect(getGoogleSurfaceColor(false)).toBe(GOOGLE_SURFACE_PALETTE.light);
    expect(getGoogleSurfaceColor(true)).toBe(GOOGLE_SURFACE_PALETTE.dark);
  });
});
