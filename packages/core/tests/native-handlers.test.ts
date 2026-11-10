import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNativeHandlerRegistry } from '../src/native-handlers.js';

describe('createNativeHandlerRegistry', () => {
  const addonAnswer = vi.fn((_url: string) => true as boolean | undefined);
  const getAddon = vi.fn(() => ({ hasApplicationForUrl: addonAnswer }) as unknown);

  let registry: ReturnType<typeof createNativeHandlerRegistry>;

  beforeEach(() => {
    addonAnswer.mockClear();
    addonAnswer.mockReturnValue(true);
    getAddon.mockClear();
    getAddon.mockReturnValue({ hasApplicationForUrl: addonAnswer });
    registry = createNativeHandlerRegistry(() => (getAddon() as any)?.hasApplicationForUrl);
  });

  it('reports what macOS says about the URL', () => {
    expect(registry.hasApplicationForUrl('zoommtg://zoom.us/join?confno=1')).toBe(true);

    addonAnswer.mockReturnValue(false);
    registry.clearHandlerCache();
    expect(registry.hasApplicationForUrl('zoommtg://zoom.us/join?confno=1')).toBe(false);
  });

  it('asks once per scheme rather than once per meeting', () => {
    registry.hasApplicationForUrl('zoommtg://zoom.us/join?confno=1');
    registry.hasApplicationForUrl('zoommtg://zoom.us/join?confno=2');

    expect(addonAnswer).toHaveBeenCalledTimes(1);
  });

  it('keeps one scheme answer out of another scheme', () => {
    addonAnswer.mockImplementation((url: string) => url.startsWith('zoommtg:'));

    expect(registry.hasApplicationForUrl('zoommtg://zoom.us/join?confno=1')).toBe(true);
    expect(
      registry.hasApplicationForUrl('msteams://teams.microsoft.com/l/meetup-join/19%3ax'),
    ).toBe(false);
  });

  it('says no to a string carrying no scheme rather than asking about it', () => {
    expect(registry.hasApplicationForUrl('not a url')).toBe(false);
    expect(addonAnswer).not.toHaveBeenCalled();
  });

  it('says no when the addon cannot be loaded', () => {
    getAddon.mockImplementation(() => {
      throw new Error('addon not found');
    });

    expect(
      registry.hasApplicationForUrl('msteams://teams.microsoft.com/l/meetup-join/19%3ax'),
    ).toBe(false);
  });

  it('says no when the addon predates the check', () => {
    getAddon.mockReturnValue({});

    expect(
      registry.hasApplicationForUrl('msteams://teams.microsoft.com/l/meetup-join/19%3ax'),
    ).toBe(false);
  });
});
