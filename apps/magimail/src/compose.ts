import { BrowserWindow, shell } from 'electron';
import { unwrapRedirectors } from '@magimail/core';
import { GMAIL_COMPOSE_URL, DEFAULT_PARTITION } from './constants.js';
import { createComposeWindowOptions, createThreadWindowOptions } from './window.js';
import { getHideSidebarCss, injectGmailStyles } from './css.js';
import { loadSettings } from './settings-store.js';

const openComposeWindows = new Set<BrowserWindow>();

export function openDetachedComposeWindow(
  preloadPath: string,
  partitionName: string = DEFAULT_PARTITION,
  draftUrl?: string,
  themeManager?: import('./theme-manager.js').ThemeManager,
): BrowserWindow {
  const options = createComposeWindowOptions({
    preloadPath,
    partitionName,
  });

  const composeWin = new BrowserWindow(options);
  openComposeWindows.add(composeWin);

  composeWin.once('ready-to-show', () => {
    composeWin.show();
  });

  composeWin.on('closed', () => {
    openComposeWindows.delete(composeWin);
  });

  // Inject custom CSS & dark mode when DOM is ready
  composeWin.webContents.on('dom-ready', () => {
    const settings = loadSettings();
    injectGmailStyles(composeWin.webContents, {
      darkMode: themeManager?.isDark() ?? false,
      hideAds: settings.hidePromotionAds,
      hideSidebar: settings.hideSidebar,
    });

    // Strip Gmail chrome and prevent page scroll in compose popout
    composeWin.webContents.insertCSS(`
      html, body { overflow: hidden !important; }
      header[role="banner"] { display: none !important; }
      div[role="navigation"] { display: none !important; }
      ${getHideSidebarCss()}
    `);
  });

  // Route external links out to system browser
  composeWin.webContents.setWindowOpenHandler(({ url }) => {
    if (
      url.startsWith('https://mail.google.com') ||
      url.startsWith('https://accounts.google.com')
    ) {
      return { action: 'allow' };
    }
    shell.openExternal(unwrapRedirectors(url));
    return { action: 'deny' };
  });

  const targetUrl = draftUrl || GMAIL_COMPOSE_URL;
  composeWin.loadURL(targetUrl);

  return composeWin;
}

export function openDetachedThreadWindow(
  preloadPath: string,
  partitionName: string = DEFAULT_PARTITION,
  threadUrl: string,
  themeManager?: import('./theme-manager.js').ThemeManager,
): BrowserWindow {
  const options = createThreadWindowOptions({
    preloadPath,
    partitionName,
  });

  const threadWin = new BrowserWindow(options);
  openComposeWindows.add(threadWin);

  threadWin.once('ready-to-show', () => {
    threadWin.show();
  });

  threadWin.on('closed', () => {
    openComposeWindows.delete(threadWin);
  });

  threadWin.webContents.on('dom-ready', () => {
    const s = loadSettings();
    injectGmailStyles(threadWin.webContents, {
      darkMode: themeManager?.isDark() ?? false,
      hideAds: s.hidePromotionAds,
      hideSidebar: s.hideSidebar,
    });
  });

  // Compose links from within a thread open a compose pop-out
  threadWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('view=cm')) {
      openDetachedComposeWindow(preloadPath, partitionName, url, themeManager);
      return { action: 'deny' };
    }
    if (
      url.startsWith('https://mail.google.com') ||
      url.startsWith('https://accounts.google.com')
    ) {
      return { action: 'allow' };
    }
    shell.openExternal(unwrapRedirectors(url));
    return { action: 'deny' };
  });

  threadWin.loadURL(threadUrl);

  return threadWin;
}

export function closeAllComposeWindows(): void {
  for (const win of openComposeWindows) {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
  openComposeWindows.clear();
}
