import { TAU } from '../core/math';
import type { World } from '../sim/World';
import { lightningStrike } from '../sim/hazards';
import { HOUR } from '../world/config';
import { describePlace } from '../ai/describe';
import { siteClear } from '../sim/settlement';
import type { ResourceNode } from '../sim/types';

export type PowerId = 'lightning' | 'rain' | 'bless' | 'heal';

export interface PowerDef {
  id: PowerId;
  name: string;
  key: string;
  hint: string;
}

export const POWERS: PowerDef[] = [
  { id: 'lightning', name: 'Lightning', key: '2', hint: 'Strike the land. Sets trees ablaze and terrifies anyone nearby.' },
  { id: 'rain', name: 'Rain', key: '3', hint: 'Summon a rain cloud. Puts out fires, waters plants, quenches thirst.' },
  { id: 'bless', name: 'Bless', key: '4', hint: 'Grow a fruit tree laden with fruit. Watch who finds it first.' },
  { id: 'heal', name: 'Heal', key: '5', hint: 'Mend a human: restores health, calms fear, lifts them up.' },
];

/** A bolt from the sky, aimed by the player. */
export function castLightning(w: World, x: number, z: number): void {
  lightningStrike(w, x, z, true);
}

export function summonRain(w: World, x: number, z: number): void {
  // Merge with a nearby god cloud instead of stacking many.
  const near = w.weather.clouds.find((c) => c.god && Math.hypot(c.x - x, c.z - z) < c.radius);
  if (near) {
    near.ttl = Math.max(near.ttl, HOUR * 2.5);
    near.peak = 1;
    near.radius = Math.min(28, near.radius + 3);
    w.log('The rain grows heavier.', 'rain', 1, { x, z });
    return;
  }
  w.weather.summon(x, z, true, 18, HOUR * 2.5, 1);
  w.log(`Rain clouds gather ${describePlace(w, x, z)}.`, 'rain', 2, { x, z });
}

/** Grow a blessed fruit tree (or berry bushes where a tree won't fit). */
export function bless(w: World, x: number, z: number): boolean {
  if (!w.nav.terrainWalkable(x, z) || w.terrain.heightAt(x, z) < 0.6) return false;
  const make = (kind: ResourceNode['kind'], px: number, pz: number, amount: number, blockRadius: number): ResourceNode => ({
    id: w.nextId(),
    kind,
    variant: 0,
    x: px,
    z: pz,
    rot: w.rng.range(0, TAU),
    scale: kind === 'fruitTree' ? 1.12 : 1,
    blockRadius,
    amount,
    max: amount,
    regrow: 0,
    state: 'grown',
    growth: 1,
    burning: 0,
    claims: 0,
    blessed: true,
    lastUse: -1e9,
  });
  const treeOk = siteClear(w, x, z, 1.2) || w.nav.walkable(x, z);
  if (treeOk) {
    // Keep agents from standing inside the new trunk.
    const r = make('fruitTree', x, z, 7, 0.4);
    w.addResource(r);
  } else {
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU;
      const px = x + Math.cos(a) * 1.4;
      const pz = z + Math.sin(a) * 1.4;
      if (!w.nav.terrainWalkable(px, pz)) continue;
      w.addResource(make('berryBush', px, pz, 6, 0));
    }
  }
  w.events.emit('fx', { kind: 'sparkle', x, z, y: 1, count: 40 });
  w.events.emit('sfx', { kind: 'bless', x, z });
  w.log(`The land is blessed ${describePlace(w, x, z)}: a fruit tree springs up!`, 'bless', 2, { x, z });
  // Anyone close enough notices immediately.
  for (const a of w.agents) {
    if (!a.alive) continue;
    const d = Math.hypot(a.x - x, a.z - z);
    if (d < 22) {
      a.emote = { icon: 'star', until: w.time + 3 };
      a.addLog(w.time, 'event', 'A tree grew out of the ground in front of my eyes!');
      a.faith = Math.min(1, a.faith + 0.18);
      a.brain.nextThink = w.time;
    }
  }
  return true;
}

export function healAt(w: World, x: number, z: number, targetId: number | null): number {
  let healed = 0;
  for (const a of w.agents) {
    if (!a.alive || a.inside !== null) continue;
    const d = Math.hypot(a.x - x, a.z - z);
    if (a.id !== targetId && d > 3) {
      if (d < 14) {
        a.faith = Math.min(1, a.faith + 0.1);
        a.addLog(w.time, 'event', 'Saw a light from the sky heal someone!');
      }
      continue;
    }
    a.faith = Math.min(1, a.faith + 0.35);
    a.needs.health = 1;
    a.needs.safety = Math.max(a.needs.safety, 0.95);
    a.needs.energy = Math.min(1, Math.max(a.needs.energy, 0.5) + 0.25);
    a.knocked = 0;
    a.emote = { icon: 'heal', until: w.time + 4 };
    a.addLog(w.time, 'event', 'Bathed in a warm light — all pain gone.');
    a.thought = 'I feel... blessed. Is someone watching over us?';
    w.events.emit('fx', { kind: 'sparkle', x: a.x, z: a.z, y: 1, count: 24 });
    healed++;
    w.log(`${a.name} was healed by a warm light from the sky.`, 'heal', 2, a, a.id);
  }
  if (healed) w.events.emit('sfx', { kind: 'heal', x, z });
  return healed;
}
