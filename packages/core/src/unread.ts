/**
 * Formats unread count for macOS Dock badge (e.g. 0 -> '', 5 -> '5', 1000 -> '999+')
 *
 * `atLeast` appends a `+`, for a count the caller knows may be short of the
 * truth. The badge already spells that idea at the top end, where 1000 shows as
 * `999+`; this is the same claim — "at least this many" — made for a different
 * reason. Zero stays blank either way: `0+` reads as a fault rather than a
 * count, and there is nothing to draw attention to.
 */
export function formatDockBadge(count: number, atLeast = false): string {
  if (count <= 0) return '';
  if (count > 999) return '999+';
  return atLeast ? `${count}+` : count.toString();
}
