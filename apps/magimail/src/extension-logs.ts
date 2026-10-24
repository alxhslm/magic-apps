import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@magimail/core/logger';
import { appGroupContainerPath } from './native-widgets.js';

const log = createLogger('ExtensionLogs');

/**
 * Copies log files written by sandboxed .appex extensions from the shared
 * App Group container into the main application log directory (~/Library/Logs/Magimail/).
 *
 * This ensures that when the user opens "Help → Reveal Logs in Finder", or
 * archives their diagnostic logs, extension logs (like `share-extension.log`)
 * sit right beside `main.log`.
 *
 * @param targetDir Destination directory (typically `logDirectory()`).
 * @param resolveGroupContainer Optional resolver override for tests.
 * @returns Array of file paths copied to `targetDir`.
 */
export function syncExtensionLogs(
  targetDir: string,
  resolveGroupContainer?: () => string | null,
): string[] {
  const copied: string[] = [];
  try {
    const container = resolveGroupContainer ? resolveGroupContainer() : appGroupContainerPath();

    if (!container) return copied;

    const groupLogsDir = path.join(container, 'logs');
    if (!fs.existsSync(groupLogsDir)) return copied;

    const entries = fs.readdirSync(groupLogsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.log')) {
        const src = path.join(groupLogsDir, entry.name);
        const dest = path.join(targetDir, entry.name);
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(src, dest);
        copied.push(dest);
      }
    }
  } catch (error) {
    log.warn('Failed to sync extension logs from App Group container:', error);
  }
  return copied;
}
