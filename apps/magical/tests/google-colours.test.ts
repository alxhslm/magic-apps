import { describe, it, expect } from 'vitest';
import palette from '../src/google-colours.json';
import { colourForId } from '../src/google-colours.js';

describe('the Google colour palette', () => {
  it('holds all 24 colours, because the position in the file is the id', () => {
    expect(Object.keys(palette)).toHaveLength(24);
  });

  it('resolves an id to the hex Google paints', () => {
    expect(colourForId(3)).toBe('#D50000');
    expect(colourForId(6)).toBe('#F09300');
  });

  it('has no colour for an id outside the palette', () => {
    expect(colourForId(0)).toBeNull();
    expect(colourForId(25)).toBeNull();
  });
});
