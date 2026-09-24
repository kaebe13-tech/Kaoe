import { DAY_LENGTH, HOUR } from '../world/config';
import type { Civilization } from './Civilization';

/**
 * Speed a civilization actually runs at this step. At 1x its hour of day drifts back into line
 * with the sun ("jet lag" after being sped up, slowed or frozen), so people never end up
 * permanently sleeping through the day.
 */
export function effectiveSpeed(civ: Civilization, worldTime: number): number {
  if (civ.speed !== 1) return civ.speed;
  let diff = ((civ.clock - worldTime) % DAY_LENGTH + DAY_LENGTH) % DAY_LENGTH;
  if (diff > DAY_LENGTH / 2) diff -= DAY_LENGTH;
  const tol = HOUR * 0.02;
  if (Math.abs(diff) <= tol) {
    return 1;
  }
  // Ahead of the sun: slow down; behind: speed up, until back in step.
  return diff > 0 ? 0.5 : 1.5;
}

/** True while a 1x civilization is drifting back into step with the sun. */
export function resyncing(civ: Civilization, worldTime: number): boolean {
  return civ.speed === 1 && effectiveSpeed(civ, worldTime) !== 1;
}
