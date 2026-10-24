import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hasApplicationForUrl, clearHandlerCache } from '../src/native-handlers.js';

const addonAnswer = vi.fn((_url: string) => true as boolean | undefined);
const loadAddon = vi.fn(() => ({ hasApplicationForUrl: addonAnswer }) as unknown);

vi.mock('../src/native-addon.js', () => ({
  loadAddon: () => loadAddon(),
}));

describe('magical native handlers', () => {
  beforeEach(() => {
    clearHandlerCache();
    addonAnswer.mockClear();
    addonAnswer.mockReturnValue(true);
    loadAddon.mockClear();
    loadAddon.mockReturnValue({ hasApplicationForUrl: addonAnswer });
  });

  it('reports what macOS says about the URL', () => {
    expect(hasApplicationForUrl('zoommtg://zoom.us/join?confno=1')).toBe(true);

    addonAnswer.mockReturnValue(false);
    clearHandlerCache();
    expect(hasApplicationForUrl('zoommtg://zoom.us/join?confno=1')).toBe(false);
  });

  it('asks once per scheme rather than once per meeting', () => {
    hasApplicationForUrl('zoommtg://zoom.us/join?confno=1');
    hasApplicationForUrl('zoommtg://zoom.us/join?confno=2');

    expect(addonAnswer).toHaveBeenCalledTimes(1);
  });

  it('keeps one scheme answer out of another scheme', () => {
    addonAnswer.mockImplementation((url: string) => url.startsWith('zoommtg:'));

    expect(hasApplicationForUrl('zoommtg://zoom.us/join?confno=1')).toBe(true);
    expect(hasApplicationForUrl('msteams://teams.microsoft.com/l/meetup-join/19%3ax')).toBe(false);
  });

  it('says no to a string carrying no scheme rather than asking about it', () => {
    expect(hasApplicationForUrl('not a url')).toBe(false);
    expect(addonAnswer).not.toHaveBeenCalled();
  });

  it('says no when the addon cannot be loaded, so the caller falls back to the browser', () => {
    loadAddon.mockImplementation(() => {
      throw new Error('magical_addon.node not found');
    });

    expect(hasApplicationForUrl('msteams://teams.microsoft.com/l/meetup-join/19%3ax')).toBe(false);
  });

  it('says no when the addon predates the check', () => {
    loadAddon.mockReturnValue({});

    expect(hasApplicationForUrl('msteams://teams.microsoft.com/l/meetup-join/19%3ax')).toBe(false);
  });
});
