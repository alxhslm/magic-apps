import { describe, expect, it } from 'vitest';
import { resolveBuildVersion } from './build-version.mjs';

describe('the build version', () => {
  it('names the commit when a local build has no release version', () => {
    expect(resolveBuildVersion({ packageVersion: '0.0.0', commit: 'a1b2c3d' })).toBe(
      '0.0.0-dev+a1b2c3d',
    );
  });

  it('uses the release version unchanged', () => {
    expect(
      resolveBuildVersion({
        packageVersion: '0.0.0',
        commit: 'a1b2c3d',
        explicit: '1.4.2',
      }),
    ).toBe('1.4.2');
  });
});
