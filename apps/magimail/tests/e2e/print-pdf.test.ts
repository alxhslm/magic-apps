import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/test-print-pdf-e2e.js');

describe('authentic gmail print & pdf export e2e', () => {
  it('executes authentic print view and generates PDF buffer without blocking or modal dialogs', async () => {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(electronPath, [SCRIPT_PATH], {
          env: { ...process.env, MAGIMAIL_E2E: '1' },
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (d) => {
          stdout += d.toString();
        });

        child.stderr?.on('data', (d) => {
          stderr += d.toString();
        });

        child.on('close', (code) => {
          resolve({ code: code ?? -1, stdout, stderr });
        });
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'Verified window.print() suppression on view=pt (no-op, non-blocking).',
    );
    expect(result.stdout).toContain('Generating PDF buffer via webContents.printToPDF...');
    expect(result.stdout).toContain('Generated valid PDF:');
    expect(result.stdout).toContain('Successfully wrote PDF to disk:');
    expect(result.stdout).toContain('Verified detection of deleted conversation stub.');
    expect(result.stdout).toContain(
      'Cleaned up temporary test artifacts. All assertions passed successfully!',
    );
  }, 30000);
});
