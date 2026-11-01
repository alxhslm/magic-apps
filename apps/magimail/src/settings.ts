import { app } from 'electron';
import { getAllChromiumProfiles } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';
import { sendToHelper } from './swift-helper.js';
import { loadSettings } from './settings-store.js';

const log = createLogger('Settings');

export function openSettingsWindow(pane?: string, accounts?: unknown[]): void {
  const settings = loadSettings();
  log.info(`Opening the settings window, pane=${pane ?? 'default'}`);
  sendToHelper('settings.show', {
    pane,
    settings,
    accounts: accounts ?? [],
    browserProfiles: getAllChromiumProfiles(),
    appVersion: app.getVersion(),
  });
}
