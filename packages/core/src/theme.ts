export type AppTheme = 'system' | 'light' | 'dark';

export interface SurfacePalette {
  light: string;
  dark: string;
}

/**
 * Google Workspace surface colours measured on live surfaces (Google Calendar and
 * Tasks).
 *
 * An opaque window uses these instead of pure white or #1a1a1a, so cards (e.g. the
 * Google Tasks card at #ffffff / #131314) retain their contrast against the window
 * background when vibrancy is disabled.
 */
export const GOOGLE_SURFACE_PALETTE: SurfacePalette = {
  light: '#f8fafd',
  dark: '#1b1b1b',
};

export const GOOGLE_SURFACE_LIGHT = GOOGLE_SURFACE_PALETTE.light;
export const GOOGLE_SURFACE_DARK = GOOGLE_SURFACE_PALETTE.dark;

export function getGoogleSurfaceColor(
  isDark: boolean,
  palette: SurfacePalette = GOOGLE_SURFACE_PALETTE,
): string {
  return isDark ? palette.dark : palette.light;
}
