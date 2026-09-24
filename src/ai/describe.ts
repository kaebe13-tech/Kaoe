import type { World } from '../sim/World';
import { campCenter } from '../sim/settlement';
import { resourceLabel, type ResourceNode } from '../sim/types';

const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** Compass direction from a to b (north = -z, east = +x). */
export function compass(fromX: number, fromZ: number, toX: number, toZ: number): string {
  const ang = Math.atan2(toX - fromX, -(toZ - fromZ)); // 0 = north, clockwise
  const i = Math.round(((ang + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return DIRS[i]!;
}

/**
 * A short, human description of where something is: relative to the speaker's home when close,
 * by landmark, river or lake when there is one, otherwise by region.
 */
export function describePlace(w: World, x: number, z: number, skipWater = false, ref?: { settlementId: number } | null): string {
  const home = ref && ref.settlementId >= 0 ? campCenter(w, ref.settlementId) : null;
  const settlement = ref ? w.settlement(ref.settlementId) : undefined;
  const d = home ? Math.hypot(x - home.x, z - home.z) : Infinity;
  if (d < 12) return 'right by camp';
  for (const l of w.terrain.landmarks) if (Math.hypot(l.x - x, l.z - z) < (l.kind === 'volcano' ? 45 : 18)) return `near ${l.name}`;
  if (!skipWater) {
    for (const p of w.water) {
      if (Math.hypot(p.x - x, p.z - z) < p.radius + 6) {
        if (p.kind === 'river') return d < 40 ? `by ${p.name}, near camp` : `by ${p.name}`;
        if (p.kind === 'spring') return 'at the Moonwell';
        return d < 30 ? 'by the lake near camp' : home ? `by the ${compass(home.x, home.z, p.x, p.z)} lake` : 'by a lake';
      }
    }
  }
  const region = w.terrain.regionAt(x, z);
  const h = w.terrain.heightAt(x, z);
  if (home) {
    const dir = compass(home.x, home.z, x, z);
    const where = settlement?.name ?? 'camp';
    if (h > 18) return `up in the hills ${dir} of ${where}`;
    if (h < 1.6) return `on the ${dir} shore`;
    if (d < 35) return `a short walk ${dir} of ${where}`;
    if (d < 90) return `${dir} of ${where}`;
    return region ? `far ${dir}, in ${region.name}` : `far ${dir} of ${where}`;
  }
  return region ? `in ${region.name}` : 'somewhere in the wilds';
}

export function resourceName(r: ResourceNode): string {
  return resourceLabel(r).toLowerCase();
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function pct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

export function withArticle(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}
