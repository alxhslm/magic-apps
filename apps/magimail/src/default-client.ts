import { app, dialog, BaseWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { readSecretFile, writeSecretFile } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';
import { uiString } from './strings.js';

const log = createLogger('DefaultClient');

export class DefaultClientManager {
  private configPath: string;

  constructor() {
    this.configPath = path.join(app.getPath('userData'), 'default-client-preference.json');
  }

  private shouldAskOnStartup(): boolean {
    try {
      if (readSecretFile<{ dontAskAgain?: boolean }>(this.configPath)?.dontAskAgain === true) {
        return false;
      }
    } catch (err) {
      log.warn('Could not read the default-client preference; asking again:', err);
    }
    return true;
  }

  private setDontAskAgain(): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      writeSecretFile(this.configPath, { dontAskAgain: true });
    } catch (err) {
      // The prompt then returns on the next launch, having been dismissed.
      log.warn('Could not record "do not ask again"; the prompt will return:', err);
    }
  }

  public isDefault(): boolean {
    try {
      return app.isDefaultProtocolClient('mailto');
    } catch (err) {
      log.warn('Could not read whether Magimail handles mailto:', err);
      return false;
    }
  }

  public setAsDefault(): boolean {
    try {
      // The user clicks a mailto: link and Mail opens instead; the claim
      // failing is the only explanation and it never reached the log.
      const success = app.setAsDefaultProtocolClient('mailto');
      log.info(`Claiming mailto: ${success ? 'ok' : 'refused'}`);
      try {
        app.setAsDefaultProtocolClient('magimail');
      } catch (err) {
        log.warn('Could not claim the magimail: scheme:', err);
      }
      return success;
    } catch (err) {
      log.error('Could not claim mailto:', err);
      return false;
    }
  }

  public async promptSetAsDefault(parentWindow?: BaseWindow | null): Promise<void> {
    if (this.isDefault()) {
      if (parentWindow && !parentWindow.isDestroyed()) {
        await dialog.showMessageBox(parentWindow, {
          type: 'info',
          title: uiString('dialog.defaultReader.title'),
          message: uiString('dialog.defaultReader.alreadyDefault'),
          buttons: [uiString('dialog.ok')],
        });
      }
      return;
    }

    const success = this.setAsDefault();
    if (parentWindow && !parentWindow.isDestroyed()) {
      await dialog.showMessageBox(parentWindow, {
        type: success ? 'info' : 'warning',
        title: uiString('dialog.defaultReader.title'),
        message: success
          ? uiString('dialog.defaultReader.nowDefault')
          : uiString('dialog.defaultReader.failed'),
        buttons: [uiString('dialog.ok')],
      });
    }
  }

  public async checkOnStartup(parentWindow: BaseWindow): Promise<void> {
    if (this.isDefault()) return;
    if (!this.shouldAskOnStartup()) return;

    if (parentWindow.isDestroyed()) return;

    const { response } = await dialog.showMessageBox(parentWindow, {
      type: 'question',
      buttons: [
        uiString('dialog.defaultReader.setAsDefault'),
        uiString('dialog.defaultReader.notNow'),
        uiString('dialog.defaultReader.dontAskAgain'),
      ],
      defaultId: 0,
      cancelId: 1,
      title: uiString('dialog.defaultReader.title'),
      message: uiString('dialog.defaultReader.question'),
      detail: uiString('dialog.defaultReader.explanation'),
    });

    if (response === 0) {
      this.setAsDefault();
    } else if (response === 2) {
      this.setDontAskAgain();
    }
  }
}
