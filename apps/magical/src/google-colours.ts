import palette from './google-colours.json';

/**
 * Google's 24 colours, in the order the wire numbers them.
 *
 * Read once out of the live colour picker, where each swatch carries both its hex and its
 * label id, and joined against the override table in a real payload: all 24 matched, and
 * the ids run 1 to 24 in the order the picker lists them. The same ids serve calendar
 * colours; Peacock 14 is `#039BE5`, the colour Google paints an account's own calendar.
 *
 * Checked in rather than read at runtime because the palette is static. Google has
 * remapped it once, which is why the wire's own colour numbers are the old values and
 * cannot be used directly; if it happens again these hexes are what goes stale, visibly.
 *
 * The position in the file is the id, so the names are there only to say which colour is
 * which. That is safe because a JSON object keeps its keys in file order unless a key
 * reads as an array index, and none of these do.
 */
const HEX_BY_ID: readonly string[] = Object.values(palette);

/** The hex Google paints for a colour id, or null for an id outside the palette. */
export function colourForId(id: number): string | null {
  return HEX_BY_ID[id - 1] ?? null;
}
