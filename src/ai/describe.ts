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

/** A short, human description of where something is, relative to camp and landmarks. */
export function describePlace(w: World, x: number, z: number, skipPond = false): string {
  for (const p of skipPond ? [] : w.water) {
    if (Math.hypot(p.x - x, p.z - z) < p.radius + 6) {
      const c = campCenter(w);
      const near = Math.hypot(p.x - c.x, p.z - c.z) < 25;
      return near ? 'by the camp pond' : `by the ${compass(c.x, c.z, p.x, p.z)} pond`;
    }
  }
  const c = campCenter(w);
  const d = Math.hypot(x - c.x, z - c.z);
  if (d < 12) return 'right by camp';
  const dir = compass(c.x, c.z, x, z);
  const h = w.terrain.heightAt(x, z);
  if (Math.hypot(x - w.mountain.x, z - w.mountain.z) < 25 && h > 7) return `up on the mountain, ${dir} of camp`;
  if (h < 1.6) return `on the ${dir} beach`;
  if (d < 30) return `a short walk ${dir} of camp`;
  return `far ${dir} of camp`;
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
