import { afterEach, describe, expect, it, vi } from 'vitest';
import { systemPreferences } from 'electron';
import { formatClock, formatTime, resolveHourCycle, setClockForTests } from '../src/time-format';
import { parseForced24Hour, readMacForced24Hour } from '../src/mac-clock';

vi.mock('electron', () => ({
  systemPreferences: { getUserDefault: vi.fn() },
}));

/** 13:05 on a fixed date, built from local fields so the test holds in any zone. */
const afternoon = (): Date => new Date(2026, 2, 3, 13, 5);

afterEach(() => {
  vi.mocked(systemPreferences.getUserDefault).mockReset();
});

describe('resolveHourCycle', () => {
  it('takes the 24-hour cycle from a 24-hour locale', () => {
    expect(resolveHourCycle('en-GB')).toBe('h23');
    expect(resolveHourCycle('de-DE')).toBe('h23');
  });

  it('takes the 12-hour cycle from a 12-hour locale', () => {
    expect(resolveHourCycle('en-US')).toBe('h12');
    expect(resolveHourCycle('en-AU')).toBe('h12');
  });

  it('lets the Mac switch override the locale', () => {
    // The switch is separate from the region: a US-locale Mac can be set to 24-hour time.
    expect(resolveHourCycle('en-US', true)).toBe('h23');
    expect(resolveHourCycle('en-GB', false)).toBe('h12');
  });
});

describe('formatTime', () => {
  it('drops the meridiem on a 24-hour clock', () => {
    setClockForTests('en-US', 'h23');
    const text = formatTime(afternoon());

    expect(text).toContain('13:05');
    expect(text.toLowerCase()).not.toContain('pm');
  });

  it('keeps the meridiem on a 12-hour clock', () => {
    setClockForTests('en-GB', 'h12');
    const text = formatTime(afternoon());

    expect(text).toContain('1:05');
    expect(text.toLowerCase()).toContain('pm');
    expect(text).not.toContain('13');
  });
});

describe('formatClock', () => {
  it('ignores the hour cycle on a date with no clock on it', () => {
    setClockForTests('en-US', 'h23');
    const text = formatClock(new Date(2026, 2, 3), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });

    expect(text).toBe('Tue, Mar 3');
  });
});

describe('parseForced24Hour', () => {
  it('reads every shape macOS has stored the switch in', () => {
    expect(parseForced24Hour(true)).toBe(true);
    expect(parseForced24Hour(false)).toBe(false);
    expect(parseForced24Hour(1)).toBe(true);
    expect(parseForced24Hour(0)).toBe(false);
    expect(parseForced24Hour('1')).toBe(true);
    expect(parseForced24Hour('0')).toBe(false);
    expect(parseForced24Hour('true')).toBe(true);
    expect(parseForced24Hour('false')).toBe(false);
  });

  it('says nothing when the switch has never been touched', () => {
    expect(parseForced24Hour('')).toBeUndefined();
    expect(parseForced24Hour(undefined)).toBeUndefined();
    expect(parseForced24Hour({})).toBeUndefined();
  });
});

describe('readMacForced24Hour', () => {
  it('returns undefined for an absent key rather than treating it as false', () => {
    vi.mocked(systemPreferences.getUserDefault).mockReturnValue('');

    expect(readMacForced24Hour()).toBeUndefined();
  });

  it('reads a key stored as an integer when the string read refuses it', () => {
    vi.mocked(systemPreferences.getUserDefault).mockImplementation((_key, type) => {
      if (type === 'string') throw new Error('wrong type');
      return type === 'integer' ? 1 : false;
    });

    expect(readMacForced24Hour()).toBe(true);
  });
});
