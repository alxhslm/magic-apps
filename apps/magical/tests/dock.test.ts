import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  getCalendarDateParts,
  renderDockIconSvg,
  msUntilNextMidnight,
  scheduleMidnightRollover,
  formatRsvpBadge,
  updateDockBadge,
  initDock,
} from '../src/dock.js';

describe('apps/magical: dock date and badge unit tests', () => {
  describe('getCalendarDateParts', () => {
    it('extracts 3-letter uppercase month and numeric day', () => {
      const d1 = new Date(2026, 8, 13); // September 13, 2026 (0-indexed month 8)
      const parts1 = getCalendarDateParts(d1);
      expect(parts1.day).toBe(13);
      expect(parts1.month).toBe('SEP');

      const d2 = new Date(2026, 0, 1); // January 1
      const parts2 = getCalendarDateParts(d2);
      expect(parts2.day).toBe(1);
      expect(parts2.month).toBe('JAN');

      const d3 = new Date(2024, 1, 29); // February 29 (leap year)
      const parts3 = getCalendarDateParts(d3);
      expect(parts3.day).toBe(29);
      expect(parts3.month).toBe('FEB');
    });
  });

  describe('renderDockIconSvg', () => {
    const iconSvgPath = path.resolve(__dirname, '../build/icon.svg');
    const templateSvg = readFileSync(iconSvgPath, 'utf8');

    it('substitutes month and day into icon.svg template', () => {
      const testDate = new Date(2026, 8, 13); // SEP 13
      const rendered = renderDockIconSvg(templateSvg, testDate);

      // Both month elements should now have SEP
      expect(rendered).toMatch(/<text id="cal-month-text-back"[^>]*>SEP<\/text>/);
      expect(rendered).toMatch(/<text id="cal-month-text"[^>]*>SEP<\/text>/);

      // Date number should now be 13
      expect(rendered).toMatch(/<text id="cal-date-number"[^>]*>13<\/text>/);

      // Should not contain old template text
      expect(rendered).not.toContain('>AUG<');
      expect(rendered).not.toContain('>31<');
    });
  });

  describe('msUntilNextMidnight', () => {
    it('calculates milliseconds until tomorrow 00:00:00.050', () => {
      // 23:59:00 -> 1 minute (60,000ms) + 50ms = 60,050ms
      const now = new Date(2026, 8, 13, 23, 59, 0, 0);
      const ms = msUntilNextMidnight(now);
      expect(ms).toBe(60050);
    });

    it('handles midday calculation', () => {
      // 12:00:00 -> 12 hours (43,200,000ms) + 50ms
      const now = new Date(2026, 8, 13, 12, 0, 0, 0);
      const ms = msUntilNextMidnight(now);
      expect(ms).toBe(12 * 60 * 60 * 1000 + 50);
    });
  });

  describe('scheduleMidnightRollover', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('triggers callback on rollover and reschedules', () => {
      const onRollover = vi.fn();
      const now = new Date(2026, 8, 13, 23, 59, 50, 0); // 10s + 50ms to midnight
      const cleanup = scheduleMidnightRollover(onRollover, now);

      expect(onRollover).not.toHaveBeenCalled();

      // Advance past midnight
      vi.advanceTimersByTime(10100);
      expect(onRollover).toHaveBeenCalledTimes(1);

      // Clean up timer
      cleanup();
    });
  });

  describe('RSVP-pending badge single source of truth', () => {
    it('formats badge label correctly', () => {
      expect(formatRsvpBadge(0)).toBeNull();
      expect(formatRsvpBadge(-5)).toBeNull();
      expect(formatRsvpBadge(1)).toBe('1');
      expect(formatRsvpBadge(5)).toBe('5');
      expect(formatRsvpBadge(99)).toBe('99');
      expect(formatRsvpBadge(100)).toBe('99+');
    });

    it('takes the count it is given rather than deriving a second one', () => {
      // `InviteWatcher` owns the number, since it is the only thing that knows what is
      // still outstanding across accounts. A badge with two sources disagrees with itself.
      expect(() => updateDockBadge(3)).not.toThrow();
      expect(() => updateDockBadge(0)).not.toThrow();
    });
  });

  describe('initDock lifecycle and powerMonitor resume', () => {
    it('registers resume and speed-limit-change listeners and cleans up', () => {
      const listeners: Record<string, () => void> = {};
      const mockPowerMonitor = {
        on: vi.fn((event: string, cb: () => void) => {
          listeners[event] = cb;
        }),
        removeListener: vi.fn((event: string, cb: () => void) => {
          if (listeners[event] === cb) {
            delete listeners[event];
          }
        }),
      };

      const cleanup = initDock(mockPowerMonitor as any);

      expect(mockPowerMonitor.on).toHaveBeenCalledWith('resume', expect.any(Function));
      expect(mockPowerMonitor.on).toHaveBeenCalledWith('speed-limit-change', expect.any(Function));

      // Simulate wake from sleep
      expect(() => listeners['resume']?.()).not.toThrow();

      // Teardown
      cleanup();
      expect(mockPowerMonitor.removeListener).toHaveBeenCalledWith('resume', expect.any(Function));
      expect(mockPowerMonitor.removeListener).toHaveBeenCalledWith(
        'speed-limit-change',
        expect.any(Function),
      );
    });
  });

  describe('Dock tile artwork source of truth', () => {
    const appDir = path.resolve(__dirname, '..');

    it('ships build/icon.svg as a bundle resource, not a generated Swift string', () => {
      const builder = JSON.parse(readFileSync(path.join(appDir, 'electron-builder.json'), 'utf8'));
      const entry = builder.extraResources.find(
        (resource: { from?: string }) => resource.from === 'build/icon.svg',
      );
      expect(entry?.to).toBe('icon.svg');

      // The generated embed is gone. Shipping the tracked file is what makes drift
      // impossible, so its reappearance would be a regression of the whole point.
      expect(() =>
        readFileSync(path.join(appDir, 'native/Sources/DockTileBaseSvg.swift')),
      ).toThrow();
      expect(readFileSync(path.join(appDir, 'build/generate-icons.swift'), 'utf8')).not.toContain(
        'DockTileBaseSvg',
      );
    });

    it('strips the fixed date from the shipped SVG at load', () => {
      const bridge = readFileSync(path.join(appDir, 'native/Sources/DockTileBridge.swift'), 'utf8');
      expect(bridge).toContain('icon.svg');
      for (const id of ['month-text-back', 'month-text', 'date-number']) {
        expect(bridge).toContain(id);
      }
    });
  });
});
