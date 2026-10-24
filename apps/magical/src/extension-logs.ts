import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@magimail/core/logger';
import { appGroupContainerPath } from './native-widgets.js';

const log = createLogger('ExtensionLogs');

/**
 * Copies the logs that sandboxed `.appex` extensions write into the shared App
 * Group container across to `~/Library/Logs/Magical/`.
 *
 * The widgets extension cannot write to the logs folder itself, so without
 * this the file naming a missing cache or a `DecodingError` sits in a
 * container the user cannot find, and a "my widget is blank" report arrives
 * with `main.log` alone.
 *
 * `MagicalAppIntents.appex` writes its log into the same container, so its
 * file is copied as well.
 *
 * @param targetDir Destination directory, normally `logDirectory()`.
 * @param resolveGroupContainer Resolver override, for tests.
 * @returns The paths copied into `targetDir`.
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

    for (const entry of fs.readdirSync(groupLogsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
      const dest = path.join(targetDir, entry.name);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(path.join(groupLogsDir, entry.name), dest);
      copied.push(dest);
    }
  } catch (error) {
    log.warn('Could not sync the extension logs from the App Group container:', error);
  }
  return copied;
}
