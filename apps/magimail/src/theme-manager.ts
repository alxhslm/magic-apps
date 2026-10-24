import { nativeTheme, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { type AppTheme, readSecretFile, writeSecretFile } from '@magimail/core';

export class ThemeManager {
  private currentTheme: AppTheme = 'system';
  private configPath: string;
  public onThemeChanged?: () => void;

  constructor() {
    const userData =
      typeof app?.getPath === 'function' ? app.getPath('userData') : '/tmp/magimail-theme';
    this.configPath = path.join(userData, 'theme-preference.json');
    this.loadSavedTheme();
    this.initNativeThemeListener();
  }

  private loadSavedTheme(): void {
    try {
      const data = readSecretFile<{ theme?: string }>(this.configPath);
      if (data?.theme && ['system', 'light', 'dark'].includes(data.theme)) {
        this.currentTheme = data.theme as AppTheme;
      }
    } catch {
      // A preference that will not read back is one the next setTheme rewrites.
      this.currentTheme = 'system';
    }
    nativeTheme.themeSource = this.currentTheme;
  }

  private saveTheme(): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      writeSecretFile(this.configPath, { theme: this.currentTheme });
    } catch {
      // Ignore write errors in restricted environments
    }
  }

  private initNativeThemeListener(): void {
    nativeTheme.on('updated', () => {
      this.onThemeChanged?.();
    });
  }

  public getTheme(): AppTheme {
    return this.currentTheme;
  }

  public isDark(): boolean {
    if (this.currentTheme === 'dark') return true;
    if (this.currentTheme === 'light') return false;
    return nativeTheme.shouldUseDarkColors;
  }

  public setTheme(theme: AppTheme): void {
    if (this.currentTheme === theme) return;
    this.currentTheme = theme;
    this.saveTheme();
    nativeTheme.themeSource = this.currentTheme;
    this.onThemeChanged?.();
  }
}
