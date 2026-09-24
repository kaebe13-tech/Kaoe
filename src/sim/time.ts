/** 1 at midday, 0 at night, smooth at dawn/dusk. */
export function daylightAt(h: number): number {
  if (h < 5 || h > 21) return 0;
  if (h < 7) return (h - 5) / 2;
  if (h > 19) return (21 - h) / 2;
  return 1;
}
