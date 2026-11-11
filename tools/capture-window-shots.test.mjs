import { describe, expect, it } from 'vitest';
import {
  extractRunningDemoPid,
  findPersonalProcesses,
  parseArgs,
  validateMagicalCdp,
  validateMagimailCdp,
} from './capture-window-shots.mjs';

describe('capture-window-shots argument parsing', () => {
  it('parses default arguments', () => {
    const res = parseArgs([]);
    expect(res.targetApp).toBe('all');
    expect(res.outDir).toContain('website/src/assets');
    expect(res.keepOpen).toBe(false);
    expect(res.noLaunch).toBe(false);
    expect(res.showHelp).toBe(false);
  });

  it('supports positional output directory', () => {
    const res = parseArgs(['/custom/assets']);
    expect(res.outDir).toBe('/custom/assets');
  });

  it('parses flags correctly', () => {
    const res = parseArgs([
      '--app',
      'magical',
      '--out-dir',
      '/tmp/out',
      '--keep-open',
      '--no-launch',
    ]);
    expect(res.targetApp).toBe('magical');
    expect(res.outDir).toBe('/tmp/out');
    expect(res.keepOpen).toBe(true);
    expect(res.noLaunch).toBe(true);
  });

  it('handles help flags', () => {
    expect(parseArgs(['--help']).showHelp).toBe(true);
    expect(parseArgs(['-h']).showHelp).toBe(true);
  });
});

describe('process safety guardrails', () => {
  it('flags a personal/daily-driver instance without --demo', () => {
    const lines = ['1000 /bin/bash', '82094 /Applications/Magical.app/Contents/MacOS/Magical'];
    const offending = findPersonalProcesses(lines, 'Magical');
    expect(offending).toHaveLength(1);
    expect(offending[0]).toContain('82094');
  });

  it('does not flag helper processes as personal instances', () => {
    const lines = [
      '82094 /Applications/Magical.app/Contents/MacOS/Magical --demo',
      '82113 /Applications/Magical.app/Contents/MacOS/MagicalHelper',
      '82120 /Applications/Magical.app/Contents/Frameworks/Magical Helper.app/Contents/MacOS/Magical Helper --type=utility',
    ];
    const offending = findPersonalProcesses(lines, 'Magical');
    expect(offending).toHaveLength(0);
  });

  it('permits instances launched with --demo or --profile=demo', () => {
    const lines = [
      '1234 /Applications/Magical.app/Contents/MacOS/Magical --demo --debug-port=9223',
      '5678 /Applications/Magimail.app/Contents/MacOS/Magimail --profile=demo',
    ];
    expect(findPersonalProcesses(lines, 'Magical')).toHaveLength(0);
    expect(findPersonalProcesses(lines, 'Magimail')).toHaveLength(0);
  });

  it('extracts PID of running demo instance', () => {
    const lines = [
      '82113 /Applications/Magical.app/Contents/MacOS/MagicalHelper',
      '82094 /Applications/Magical.app/Contents/MacOS/Magical --demo --debug-port=9223',
    ];
    expect(extractRunningDemoPid(lines, 'Magical')).toBe(82094);
  });

  it('returns null if demo instance is not running', () => {
    const lines = ['82094 /Applications/Magical.app/Contents/MacOS/Magical'];
    expect(extractRunningDemoPid(lines, 'Magical')).toBeNull();
  });
});

describe('CDP fixture validation', () => {
  it('validates Magical calendar demo target', () => {
    const targets = [
      { url: 'https://calendar.google.com/calendar/u/0/r', title: 'Week of October 25, 2026' },
    ];
    expect(validateMagicalCdp(targets)).toEqual(targets[0]);
  });

  it('refuses Magical if calendar target is absent', () => {
    const targets = [{ url: 'https://other.com', title: 'Other' }];
    expect(() => validateMagicalCdp(targets)).toThrow(
      'Magical is not loaded at calendar.google.com',
    );
  });

  it('refuses Magical if calendar target does not show the seeded 2026 demo fixture', () => {
    const targets = [
      { url: 'https://calendar.google.com/calendar/u/0/r', title: 'My Personal Live Calendar' },
    ];
    expect(() => validateMagicalCdp(targets)).toThrow(
      'Magical is not showing the seeded demo calendar fixture',
    );
  });

  it('validates Magimail mail demo target and dismisses banner if present', async () => {
    let clicked = false;
    const evaluateFn = async (_wsUrl, expr) => {
      if (expr.includes('.dismiss-btn')) clicked = true;
      return {};
    };

    const targets = [
      {
        title: 'enable offline mail',
        url: 'data:text/html,...',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/banner',
      },
      {
        title: 'Inbox (2) - demo@example.com - Magimail',
        url: 'https://mail.google.com/mail/u/0/#inbox',
      },
    ];

    const mailTarget = await validateMagimailCdp(targets, evaluateFn);
    expect(mailTarget.url).toContain('mail.google.com');
    expect(clicked).toBe(true);
  });

  it('refuses Magimail if mail target is absent', async () => {
    const targets = [{ url: 'https://example.com', title: 'Example' }];
    await expect(validateMagimailCdp(targets)).rejects.toThrow(
      'Magimail is not loaded at mail.google.com',
    );
  });
});
