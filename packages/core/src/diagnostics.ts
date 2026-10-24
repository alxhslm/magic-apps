import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { app, nativeTheme, screen, type MessageBoxOptions } from 'electron';
import { redactText, redactValue } from './redact.js';
import { GITHUB_NEW_ISSUE_URL, SUPPORT_EMAIL } from './constants.js';
import type { UiTranslator } from './ui-strings.js';

export interface DisplayInfo {
  count: number;
  primary: {
    width: number;
    height: number;
    scaleFactor: number;
  };
  appearance: 'dark' | 'light';
  themeSource: string;
  highContrast: boolean;
}

export interface SystemEnvironmentSummary {
  app: {
    name: string;
    version: string;
  };
  os: {
    platform: string;
    release: string;
    version: string;
    build: string | null;
    arch: string;
  };
  versions: {
    app: string;
    electron: string;
    chrome: string;
    node: string;
    swift?: string;
  };
  hardware: {
    totalMemoryMB: number;
    freeMemoryMB: number;
    systemUptimeHours: number;
    processUptimeMinutes: number;
    memoryUsageMB: {
      rss: number;
      heapTotal: number;
      heapUsed: number;
      external: number;
    };
  };
  display?: DisplayInfo | null;
  state?: Record<string, unknown>;
  generatedAt: string;
  files: string[];
}

export interface CollectDiagnosticsOptions {
  appName: string;
  appVersion: string;
  logsDir: string;
  targetDir?: string;
  state?: Record<string, unknown>;
  display?: DisplayInfo | null;
  swiftVersion?: string;
  archiveFn?: (sourceDir: string, destZipPath: string) => Promise<void>;
  timestamp?: Date;
}

export interface DiagnosticBundleResult {
  archivePath: string;
  archiveName: string;
  files: string[];
  summaryText: string;
  environment: SystemEnvironmentSummary;
}

/** `15.6.1 (24G90)`, falling back to the version alone if the build is unreadable. */
export function systemVersion(): string {
  const version =
    (process as unknown as { getSystemVersion?: () => string }).getSystemVersion?.() ??
    os.release();
  const build = productBuildVersion();
  return build ? `${version} (${build})` : version;
}

/**
 * The macOS build, read from the system plist.
 *
 * Apple ships more than one build under a single version string, so two
 * reporters both on "15.6.1" can be on different systems. Nothing in Node or
 * Electron exposes it, and `sw_vers` would mean spawning a process at launch.
 */
export function productBuildVersion(): string | null {
  try {
    const plist = fs.readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8');
    return /<key>ProductBuildVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads display and theme settings from Electron if available.
 */
export function getDisplayEnvironmentInfo(): DisplayInfo | null {
  try {
    if (screen && nativeTheme) {
      const displays = screen.getAllDisplays();
      const primary = screen.getPrimaryDisplay();
      return {
        count: displays.length,
        primary: {
          width: primary.size.width,
          height: primary.size.height,
          scaleFactor: primary.scaleFactor,
        },
        appearance: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
        themeSource: nativeTheme.themeSource,
        highContrast: Boolean(nativeTheme.shouldUseHighContrastColors),
      };
    }
  } catch {
    // In plain Node or test runner
  }
  return null;
}

/**
 * Reads the installed Swift version from xcrun if available.
 */
export function getSwiftVersion(): string | undefined {
  try {
    const stdout = execFileSync('/usr/bin/xcrun', ['swift', '-version'], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /swift-driver version:\s*([^\s]+)|Apple Swift version\s*([^\s]+)/i.exec(stdout);
    return match ? match[1] || match[2] : stdout.trim().split('\n')[0];
  } catch {
    return undefined;
  }
}

/**
 * Formats a Date as YYYYMMDD-HHmmss for file and archive naming.
 */
export function formatDiagnosticsTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const mins = pad(date.getMinutes());
  const secs = pad(date.getSeconds());
  return `${year}${month}${day}-${hours}${mins}${secs}`;
}

/**
 * Target directory where diagnostic archives are saved by default.
 * Prefers the user's Downloads directory.
 */
export function defaultDiagnosticsTargetDir(): string {
  try {
    if (app?.getPath) {
      return app.getPath('downloads');
    }
  } catch {
    // In plain Node
  }
  const downloads = path.join(os.homedir(), 'Downloads');
  if (fs.existsSync(downloads)) {
    return downloads;
  }
  return os.tmpdir();
}

/**
 * Standard macOS zip creation via /usr/bin/ditto.
 */
export async function createZipArchive(sourceDir: string, destZipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/ditto',
      ['-c', '-k', '--keepParent', '--norsrc', sourceDir, destZipPath],
      (error) => {
        if (error) {
          reject(new Error(`Failed to create zip archive: ${error.message}`));
        } else {
          resolve();
        }
      },
    );
  });
}

/**
 * Human-readable concise summary of the environment and state.
 */
export function formatSummaryText(summary: SystemEnvironmentSummary): string {
  const lines: string[] = [];
  lines.push(`App: ${summary.app.name} ${summary.app.version}`);
  lines.push(
    `Engine: Electron ${summary.versions.electron}, Chrome ${summary.versions.chrome}, Node ${summary.versions.node}`,
  );
  lines.push(`OS: macOS ${summary.os.version} (${summary.os.arch}, Darwin ${summary.os.release})`);

  if (summary.display) {
    const d = summary.display;
    lines.push(
      `Display: ${d.count} display(s), primary ${d.primary.width}x${d.primary.height} @${d.primary.scaleFactor}x (${d.appearance} appearance)`,
    );
  }

  if (summary.state) {
    const stateParts: string[] = [];
    if (typeof summary.state.accountCount === 'number') {
      stateParts.push(`${summary.state.accountCount} account(s)`);
    }
    if (summary.state.helper && typeof summary.state.helper === 'object') {
      const helper = summary.state.helper as { running?: boolean; pid?: number | null };
      if (helper.running) {
        stateParts.push(`Helper running${helper.pid ? ` (PID ${helper.pid})` : ''}`);
      } else {
        stateParts.push('Helper stopped');
      }
    }
    if (stateParts.length > 0) {
      lines.push(`State: ${stateParts.join(', ')}`);
    }
  }

  return lines.join('\n');
}

/**
 * Formats full markdown report for diagnostics.md.
 */
export function formatDiagnosticsMarkdown(summary: SystemEnvironmentSummary): string {
  const lines: string[] = [
    `# ${summary.app.name} Diagnostic Report`,
    `Generated: ${summary.generatedAt}`,
    '',
    '## System Environment',
    `- **App Version**: ${summary.app.name} ${summary.app.version}`,
    `- **macOS Version**: ${summary.os.version}`,
    `- **Darwin Kernel**: ${summary.os.release}`,
    `- **Architecture**: ${summary.os.arch}`,
    `- **Electron**: ${summary.versions.electron}`,
    `- **Chromium**: ${summary.versions.chrome}`,
    `- **Node.js**: ${summary.versions.node}`,
    ...(summary.versions.swift ? [`- **Swift**: ${summary.versions.swift}`] : []),
    '',
    '## Hardware & Resources',
    `- **Total Memory**: ${summary.hardware.totalMemoryMB} MB`,
    `- **Free Memory**: ${summary.hardware.freeMemoryMB} MB`,
    `- **Process Memory (RSS)**: ${summary.hardware.memoryUsageMB.rss} MB`,
    `- **System Uptime**: ${summary.hardware.systemUptimeHours.toFixed(1)} hours`,
    `- **Process Uptime**: ${summary.hardware.processUptimeMinutes.toFixed(1)} minutes`,
    '',
  ];

  if (summary.display) {
    const d = summary.display;
    lines.push(
      '## Display & Appearance',
      `- **Appearance**: ${d.appearance}`,
      `- **Theme Source**: ${d.themeSource}`,
      `- **High Contrast**: ${d.highContrast ? 'Enabled' : 'Disabled'}`,
      `- **Display Count**: ${d.count}`,
      `- **Primary Resolution**: ${d.primary.width}x${d.primary.height} @${d.primary.scaleFactor}x`,
      '',
    );
  }

  if (summary.state && Object.keys(summary.state).length > 0) {
    lines.push(
      '## Application State',
      '```json',
      JSON.stringify(summary.state, null, 2),
      '```',
      '',
    );
  }

  lines.push(
    '## Included Files',
    ...summary.files.map((f) => `- \`${f}\``),
    '',
    '## Privacy & Redaction Invariant',
    'All logs and diagnostic details in this archive have been redacted in accordance with the Magic Apps privacy standard:',
    '- Email addresses have been replaced with `<email>`.',
    '- Personal home directory paths have been truncated to `~`.',
    '- URL query parameters and tokens have been stripped.',
    '- No passwords, auth tokens, cookies, or email contents are collected or stored.',
  );

  return lines.join('\n');
}

/**
 * Collects a full diagnostic bundle: logs, system info, state metrics, and packages them
 * into a zipped archive.
 */
export async function collectDiagnosticBundle(
  options: CollectDiagnosticsOptions,
): Promise<DiagnosticBundleResult> {
  const {
    appName,
    appVersion,
    logsDir,
    targetDir = defaultDiagnosticsTargetDir(),
    state,
    display = getDisplayEnvironmentInfo(),
    swiftVersion = options.swiftVersion ?? getSwiftVersion(),
    archiveFn = createZipArchive,
    timestamp = new Date(),
  } = options;

  const dateStr = formatDiagnosticsTimestamp(timestamp);
  const bundleFolderName = `${appName}-Diagnostics-${dateStr}`;
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-diagnostics-'));
  const bundleDir = path.join(stagingRoot, bundleFolderName);
  fs.mkdirSync(bundleDir, { recursive: true });

  const copiedFiles: string[] = [];

  try {
    // 1. Copy and redact all .log files from logsDir
    if (fs.existsSync(logsDir)) {
      const entries = fs.readdirSync(logsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.log')) {
          const src = path.join(logsDir, entry.name);
          const dest = path.join(bundleDir, entry.name);
          try {
            const raw = fs.readFileSync(src, 'utf8');
            const sanitized = redactText(raw);
            fs.writeFileSync(dest, sanitized, 'utf8');
            copiedFiles.push(entry.name);
          } catch {
            // Unreadable log file skipped
          }
        }
      }
    }

    // 2. Prepare memory metrics
    const memUsage = process.memoryUsage();
    const toMB = (bytes: number) => Math.round(bytes / (1024 * 1024));

    // 3. Assemble environment summary
    const summary: SystemEnvironmentSummary = {
      app: {
        name: appName,
        version: appVersion,
      },
      os: {
        platform: process.platform,
        release: os.release(),
        version: systemVersion(),
        build: productBuildVersion(),
        arch: process.arch,
      },
      versions: {
        app: appVersion,
        electron: process.versions.electron ?? 'unknown',
        chrome: process.versions.chrome ?? 'unknown',
        node: process.versions.node ?? 'unknown',
        ...(swiftVersion ? { swift: swiftVersion } : {}),
      },
      hardware: {
        totalMemoryMB: toMB(os.totalmem()),
        freeMemoryMB: toMB(os.freemem()),
        systemUptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
        processUptimeMinutes: Math.round((process.uptime() / 60) * 10) / 10,
        memoryUsageMB: {
          rss: toMB(memUsage.rss),
          heapTotal: toMB(memUsage.heapTotal),
          heapUsed: toMB(memUsage.heapUsed),
          external: toMB(memUsage.external),
        },
      },
      display,
      state: state ? (redactValue(state) as Record<string, unknown>) : undefined,
      generatedAt: timestamp.toISOString(),
      files: [...copiedFiles, 'diagnostics.json', 'diagnostics.md'],
    };

    // 4. Write diagnostics.json
    fs.writeFileSync(
      path.join(bundleDir, 'diagnostics.json'),
      JSON.stringify(summary, null, 2),
      'utf8',
    );

    // 5. Write diagnostics.md
    fs.writeFileSync(
      path.join(bundleDir, 'diagnostics.md'),
      formatDiagnosticsMarkdown(summary),
      'utf8',
    );

    // 6. Create the zip archive in targetDir
    fs.mkdirSync(targetDir, { recursive: true });
    const archiveName = `${bundleFolderName}.zip`;
    const archivePath = path.join(targetDir, archiveName);

    await archiveFn(bundleDir, archivePath);

    const summaryText = formatSummaryText(summary);

    return {
      archivePath,
      archiveName,
      files: summary.files,
      summaryText,
      environment: summary,
    };
  } finally {
    // Clean up temporary uncompressed directory
    try {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * The catalogue keys the diagnostics dialog renders, so an app can assert they
 * exist. The `dialog.diagnostics.*` entries live in each app's catalogue.
 */
export const DIAGNOSTICS_DIALOG_KEYS = [
  'dialog.diagnostics.title',
  'dialog.diagnostics.message',
  'dialog.diagnostics.archiveSaved',
  'dialog.diagnostics.summary',
  'dialog.diagnostics.privacyGuarantee',
  'dialog.diagnostics.privacyDetail',
  'dialog.diagnostics.prompt',
  'dialog.diagnostics.revealInFinder',
  'dialog.diagnostics.copySystemInfo',
  'dialog.diagnostics.reportOnGitHub',
  'dialog.diagnostics.emailToSupport',
  'dialog.diagnostics.done',
] as const;

/**
 * Builds the options for dialog.showMessageBox to present the diagnostic results.
 *
 * Core owns the layout and no app's data, so it cannot hold the wording: `t` is
 * the app's catalogue translator, and the app owns the language. See
 * `docs/shared/ui-strings.md`.
 */
export function buildDiagnosticsDialogOptions(
  result: DiagnosticBundleResult,
  t: UiTranslator,
): MessageBoxOptions {
  return {
    type: 'info',
    title: t('dialog.diagnostics.title', { app: result.environment.app.name }),
    message: t('dialog.diagnostics.message'),
    detail:
      `${t('dialog.diagnostics.archiveSaved')}\n${redactText(result.archivePath)}\n\n` +
      `${t('dialog.diagnostics.summary')}\n${result.summaryText}\n\n` +
      `${t('dialog.diagnostics.privacyGuarantee')}\n` +
      `${t('dialog.diagnostics.privacyDetail')}\n\n` +
      `${t('dialog.diagnostics.prompt')}`,
    buttons: [
      t('dialog.diagnostics.revealInFinder'),
      t('dialog.diagnostics.copySystemInfo'),
      t('dialog.diagnostics.reportOnGitHub'),
      t('dialog.diagnostics.emailToSupport'),
      t('dialog.diagnostics.done'),
    ],
    defaultId: 0,
    cancelId: 4,
  };
}

/**
 * Builds a mailto: URL for submitting the diagnostic report via email.
 */
export function buildSupportEmailUrl(result: DiagnosticBundleResult): string {
  const { app, os: osInfo } = result.environment;
  const subject = `[${app.name} Diagnostics] v${app.version} (${osInfo.version})`;
  const body =
    `Please describe what happened:\n` +
    `[Describe your issue here]\n\n` +
    `--- System Information ---\n` +
    `${result.summaryText}\n\n` +
    `(Diagnostic archive revealed in Finder: ${result.archiveName} — please attach it to this email.)\n`;

  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Builds a GitHub new issue URL pre-filled with the bug report structure,
 * environment summary, and diagnostic archive instructions.
 */
export function buildGitHubIssueUrl(result: DiagnosticBundleResult): string {
  const { app } = result.environment;
  const title = `[Bug]: Issue in ${app.name} ${app.version}`;
  const appLabel = app.name.toLowerCase() === 'magimail' ? 'app:magimail' : 'app:magical';
  const body =
    `### What happened?\n\n[Describe what happened]\n\n` +
    `### What did you expect to happen?\n\n[Describe what you expected]\n\n` +
    `### How can we reproduce it?\n\n1. \n2. \n3. \n\n` +
    `### Environment\n\`\`\`\n${result.summaryText}\n\`\`\`\n\n` +
    `### Screenshots and logs\nDiagnostic archive: \`${result.archiveName}\`\n*(Revealed in Finder — drag and drop into this box to attach)*\n`;

  const params = new URLSearchParams({
    title,
    body,
    labels: `type:bug,${appLabel}`,
  });

  return `${GITHUB_NEW_ISSUE_URL}?${params.toString()}`;
}
