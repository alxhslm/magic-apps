import { app } from 'electron';
import { getAllChromiumProfiles, getDefaultBrowser, SUPPORTED_BROWSERS } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';
import { sendToHelper } from './swift-helper.js';
import { loadSettings } from './settings-store.js';

/** Every browser we can launch ourselves, which is not the same as one we have profiles for. */
const CHOOSABLE_BROWSERS = SUPPORTED_BROWSERS.filter((b) => b.id !== 'system').map((b) => ({
  id: b.id,
  name: b.name,
  bundleId: b.bundleId ?? '',
  isChromium: b.isChromium === true,
}));

const log = createLogger('Settings');

export function openSettingsWindow(pane?: string, accounts?: unknown[]): void {
  const settings = loadSettings();
  log.info(`Opening the settings window, pane=${pane ?? 'default'}`);
  sendToHelper('settings.show', {
    pane,
    settings,
    accounts: accounts ?? [],
    browserProfiles: getAllChromiumProfiles(),
    defaultBrowser: getDefaultBrowser(),
    browsers: CHOOSABLE_BROWSERS,
    appVersion: app.getVersion(),
  });
}
