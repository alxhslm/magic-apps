import type { BrowserWindowConstructorOptions } from 'electron';
import { uiString } from './strings.js';

export interface DetachedWindowConfigOptions extends Partial<BrowserWindowConstructorOptions> {
  preloadPath?: string;
  partitionName?: string;
}

export type ComposeWindowConfigOptions = DetachedWindowConfigOptions;

/**
 * Generates options for detached compose / thread windows (Cmd+Shift+N)
 */
export function createComposeWindowOptions(
  overrides?: DetachedWindowConfigOptions,
): BrowserWindowConstructorOptions {
  const { preloadPath, partitionName, ...rest } = overrides || {};

  return {
    width: 720,
    height: 770,
    useContentSize: true,
    minWidth: 500,
    minHeight: 430,
    show: false,
    titleBarStyle: 'default',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    title: uiString('window.compose.title'),
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      partition: partitionName,
      spellcheck: true,
    },
    ...rest,
  };
}

/**
 * Generates options for detached thread reader windows
 */
export function createThreadWindowOptions(
  overrides?: DetachedWindowConfigOptions,
): BrowserWindowConstructorOptions {
  const { preloadPath, partitionName, ...rest } = overrides || {};

  return {
    width: 900,
    height: 780,
    minWidth: 600,
    minHeight: 430,
    show: false,
    titleBarStyle: 'default',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    title: uiString('window.thread.title'),
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      partition: partitionName,
      spellcheck: true,
    },
    ...rest,
  };
}
