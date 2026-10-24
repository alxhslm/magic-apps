import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  collectDiagnosticBundle,
  formatDiagnosticsTimestamp,
  formatSummaryText,
  formatDiagnosticsMarkdown,
  buildDiagnosticsDialogOptions,
  buildSupportEmailUrl,
  buildGitHubIssueUrl,
  systemVersion,
  productBuildVersion,
  DIAGNOSTICS_DIALOG_KEYS,
  type SystemEnvironmentSummary,
} from '../src/diagnostics.js';
import type { UiTranslator } from '../src/ui-strings.js';

/**
 * A translator that renders the English the app supplies and records every key it
 * is asked for. An unexpected key throws, so a call the constant does not list is
 * a failure rather than a silent miss.
 */
function makeTranslator() {
  const calls: Array<{ key: string; params?: Record<string, string | number> }> = [];
  const t: UiTranslator = (key, params) => {
    calls.push({ key, params });
    switch (key) {
      case 'dialog.diagnostics.title':
        return `${params?.app} Diagnostics`;
      case 'dialog.diagnostics.message':
        return 'Diagnostic Bundle Created';
      case 'dialog.diagnostics.archiveSaved':
        return 'Archive saved to:';
      case 'dialog.diagnostics.summary':
        return 'Summary:';
      case 'dialog.diagnostics.privacyGuarantee':
        return 'Privacy Guarantee:';
      case 'dialog.diagnostics.privacyDetail':
        return 'All email addresses, personal directories, and sensitive parameters have been automatically redacted. No credentials or message bodies are included.';
      case 'dialog.diagnostics.prompt':
        return 'What would you like to do?';
      case 'dialog.diagnostics.revealInFinder':
        return 'Reveal in Finder';
      case 'dialog.diagnostics.copySystemInfo':
        return 'Copy System Info';
      case 'dialog.diagnostics.reportOnGitHub':
        return 'Report on GitHub…';
      case 'dialog.diagnostics.emailToSupport':
        return 'Email to Support…';
      case 'dialog.diagnostics.done':
        return 'Done';
      default:
        throw new Error(`unexpected key ${key}`);
    }
  };
  return { t, calls };
}

describe('systemVersion and productBuildVersion', () => {
  it('returns a non-empty system version string', () => {
    const version = systemVersion();
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
  });

  it('reads or gracefully falls back for productBuildVersion', () => {
    const build = productBuildVersion();
    // On macOS this may be string (e.g. 24G90) or null in mocked/non-darwin environments
    expect(build === null || typeof build === 'string').toBe(true);
  });
});

describe('formatDiagnosticsTimestamp', () => {
  it('formats dates as YYYYMMDD-HHmmss', () => {
    const d = new Date(2026, 9, 2, 14, 5, 9); // Oct is month 9 (0-indexed)
    expect(formatDiagnosticsTimestamp(d)).toBe('20261002-140509');
  });
});

describe('formatSummaryText and formatDiagnosticsMarkdown', () => {
  const sampleSummary: SystemEnvironmentSummary = {
    app: { name: 'Magimail', version: '1.2.3' },
    os: {
      platform: 'darwin',
      release: '24.6.0',
      version: '15.6.1 (24G90)',
      build: '24G90',
      arch: 'arm64',
    },
    versions: {
      app: '1.2.3',
      electron: '44.1.1',
      chrome: '152.0.7977.65',
      node: '22.13.5',
      swift: '6.0',
    },
    hardware: {
      totalMemoryMB: 16384,
      freeMemoryMB: 8192,
      systemUptimeHours: 48.5,
      processUptimeMinutes: 12.3,
      memoryUsageMB: { rss: 120, heapTotal: 80, heapUsed: 40, external: 10 },
    },
    display: {
      count: 1,
      primary: { width: 3024, height: 1964, scaleFactor: 2 },
      appearance: 'dark',
      themeSource: 'system',
      highContrast: false,
    },
    state: {
      accountCount: 2,
      helper: { running: true, pid: 12345 },
    },
    generatedAt: '2026-10-02T10:00:00.000Z',
    files: ['main.log', 'share-extension.log', 'diagnostics.json', 'diagnostics.md'],
  };

  it('formats concise summary text containing key facts', () => {
    const text = formatSummaryText(sampleSummary);
    expect(text).toContain('App: Magimail 1.2.3');
    expect(text).toContain('Electron 44.1.1');
    expect(text).toContain('Chrome 152.0.7977.65');
    expect(text).toContain('macOS 15.6.1 (24G90)');
    expect(text).toContain('Display: 1 display(s)');
    expect(text).toContain('3024x1964 @2x');
    expect(text).toContain('2 account(s)');
    expect(text).toContain('Helper running (PID 12345)');
  });

  it('formats full markdown with privacy statement', () => {
    const md = formatDiagnosticsMarkdown(sampleSummary);
    expect(md).toContain('# Magimail Diagnostic Report');
    expect(md).toContain('## System Environment');
    expect(md).toContain('## Hardware & Resources');
    expect(md).toContain('## Display & Appearance');
    expect(md).toContain('## Application State');
    expect(md).toContain('## Privacy & Redaction Invariant');
    expect(md).toContain('Email addresses have been replaced with `<email>`');
  });
});

describe('collectDiagnosticBundle', () => {
  let tempDir: string;
  let logsDir: string;
  let targetDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-test-'));
    logsDir = path.join(tempDir, 'Logs');
    targetDir = path.join(tempDir, 'Target');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('assembles logs, strips emails & home directory, and creates archive', async () => {
    const home = os.homedir();
    // Create simulated logs with sensitive strings
    fs.writeFileSync(
      path.join(logsDir, 'main.log'),
      `[Startup] App starting at ${home}/Library/Logs\nError for casey@example.com: session expired\n`,
    );
    fs.writeFileSync(
      path.join(logsDir, 'share-extension.log'),
      `Handling share link for morgan@example.org at ${home}/Documents\n`,
    );

    let archivedSourceDir = '';
    const archiveFn = vi.fn().mockImplementation(async (src: string, dst: string) => {
      archivedSourceDir = src;
      // Verify files inside staging directory before it gets cleaned up
      expect(fs.existsSync(path.join(src, 'main.log'))).toBe(true);
      expect(fs.existsSync(path.join(src, 'share-extension.log'))).toBe(true);
      expect(fs.existsSync(path.join(src, 'diagnostics.json'))).toBe(true);
      expect(fs.existsSync(path.join(src, 'diagnostics.md'))).toBe(true);

      const mainContent = fs.readFileSync(path.join(src, 'main.log'), 'utf8');
      expect(mainContent).not.toContain('casey@example.com');
      expect(mainContent).toContain('<email>');
      expect(mainContent).not.toContain(home);
      expect(mainContent).toContain('~/Library/Logs');

      const extContent = fs.readFileSync(path.join(src, 'share-extension.log'), 'utf8');
      expect(extContent).not.toContain('morgan@example.org');
      expect(extContent).toContain('<email>');
      expect(extContent).not.toContain(home);
      expect(extContent).toContain('~/Documents');

      // Create dummy archive file
      fs.writeFileSync(dst, 'dummy zip content');
    });

    const timestamp = new Date(2026, 9, 2, 10, 30, 0);
    const result = await collectDiagnosticBundle({
      appName: 'Magimail',
      appVersion: '1.0.0',
      logsDir,
      targetDir,
      state: {
        accountCount: 2,
        userEmail: 'sensitive@example.com', // Should be redacted in state
      },
      archiveFn,
      timestamp,
    });

    expect(archiveFn).toHaveBeenCalledTimes(1);
    expect(result.archiveName).toBe('Magimail-Diagnostics-20261002-103000.zip');
    expect(result.archivePath).toBe(
      path.join(targetDir, 'Magimail-Diagnostics-20261002-103000.zip'),
    );
    expect(result.files).toContain('main.log');
    expect(result.files).toContain('share-extension.log');
    expect(result.files).toContain('diagnostics.json');
    expect(result.files).toContain('diagnostics.md');

    // Verify state was redacted in diagnostics summary
    expect(result.environment.state?.userEmail).toBe('<email>');

    // Staging root must be cleaned up
    expect(fs.existsSync(archivedSourceDir)).toBe(false);
  });
});

describe('Dialog and URL builders', () => {
  const sampleResult = {
    archivePath: '/Users/test/Downloads/Magimail-Diagnostics-20261002-103000.zip',
    archiveName: 'Magimail-Diagnostics-20261002-103000.zip',
    files: ['main.log', 'diagnostics.json'],
    summaryText: 'App: Magimail 1.0.0\nmacOS 15.6.1\nAccounts: 1',
    environment: {
      app: { name: 'Magimail', version: '1.0.0' },
      os: {
        platform: 'darwin',
        release: '24.6.0',
        version: '15.6.1',
        build: '24G90',
        arch: 'arm64',
      },
      versions: { app: '1.0.0', electron: '44.1.1', chrome: '152.0.7977.65', node: '22.13.5' },
      hardware: {
        totalMemoryMB: 16384,
        freeMemoryMB: 8192,
        systemUptimeHours: 10,
        processUptimeMinutes: 5,
        memoryUsageMB: { rss: 100, heapTotal: 50, heapUsed: 30, external: 5 },
      },
      generatedAt: '2026-10-02T10:30:00.000Z',
      files: ['main.log', 'diagnostics.json'],
    },
  };

  it('builds dialog options offering Reveal, Copy, GitHub, Email, and Done', () => {
    const { t } = makeTranslator();
    const options = buildDiagnosticsDialogOptions(sampleResult, t);
    expect(options.title).toBe('Magimail Diagnostics');
    expect(options.buttons).toEqual([
      'Reveal in Finder',
      'Copy System Info',
      'Report on GitHub…',
      'Email to Support…',
      'Done',
    ]);
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(4);
    expect(options.detail).toContain('Magimail-Diagnostics-20261002-103000.zip');
    expect(options.detail).toContain('Privacy Guarantee');
  });

  it('asks the catalogue for exactly the keys it declares', () => {
    const { t, calls } = makeTranslator();
    buildDiagnosticsDialogOptions(sampleResult, t);
    expect([...new Set(calls.map((call) => call.key))].sort()).toEqual(
      [...DIAGNOSTICS_DIALOG_KEYS].sort(),
    );
  });

  it('passes the app name to the title and the archive path into the detail', () => {
    const { t, calls } = makeTranslator();
    const options = buildDiagnosticsDialogOptions(sampleResult, t);
    expect(calls.find((call) => call.key === 'dialog.diagnostics.title')?.params).toEqual({
      app: 'Magimail',
    });
    expect(options.detail).toContain('Magimail-Diagnostics-20261002-103000.zip');
  });

  it('builds a support mailto: URL pre-addressed with subject and summary', () => {
    const url = buildSupportEmailUrl(sampleResult);
    expect(url.startsWith('mailto:support@macmagic.app?')).toBe(true);
    expect(decodeURIComponent(url)).toContain('[Magimail Diagnostics] v1.0.0 (15.6.1)');
    expect(decodeURIComponent(url)).toContain('App: Magimail 1.0.0');
    expect(decodeURIComponent(url)).toContain('Magimail-Diagnostics-20261002-103000.zip');
  });

  it('builds a GitHub issue URL pre-filled with structured body and environment info', () => {
    const url = buildGitHubIssueUrl(sampleResult);
    expect(url.startsWith('https://github.com/alxhslm/magic-apps/issues/new?')).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('title')).toBe('[Bug]: Issue in Magimail 1.0.0');
    const body = parsed.searchParams.get('body') ?? '';
    expect(body).toContain('### What happened?');
    expect(body).toContain('### What did you expect to happen?');
    expect(body).toContain('### How can we reproduce it?');
    expect(body).toContain('### Environment');
    expect(body).toContain('App: Magimail 1.0.0');
    expect(body).toContain('Magimail-Diagnostics-20261002-103000.zip');
    expect(parsed.searchParams.get('labels')).toBe('type:bug,app:magimail');
  });
});
