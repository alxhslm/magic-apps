import type { BrowserWindowConstructorOptions } from 'electron';

export interface WindowLayoutConfig {
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  titleBarStyle?: 'hiddenInset' | 'hidden' | 'customButtonsOnHover' | 'default';
  trafficLightPosition?: { x: number; y: number };
  vibrancy?:
    | 'sidebar'
    | 'under-window'
    | 'popover'
    | 'window'
    | 'header'
    | 'sheet'
    | 'hud'
    | 'fullscreen-ui'
    | 'tooltip'
    | 'content'
    | 'under-page'
    | 'menu';
  visualEffectState?: 'active' | 'inactive' | 'followWindow';
  backgroundColor?: string;
}

export interface GoogleSessionOptions {
  partitionName?: string;
  userAgent?: string;
}

export interface MagimailPreloadApi {
  onThemeChanged?: (callback: (theme: 'light' | 'dark') => void) => void;
}

declare global {
  interface Window {
    magimailBridge?: MagimailPreloadApi;
  }
}

export type MainWindowOptions = BrowserWindowConstructorOptions & WindowLayoutConfig;

/**
 * The logging surface core modules write through.
 *
 * Core never imports the logger itself: the barrel is loaded in plain Node
 * contexts (tests, the preload build) where pulling in `electron-log` and its
 * Electron dependency would fail. The app owns the logger and injects it; the
 * fallback is `console`, which is what a test sees.
 */
export interface LogSink {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
