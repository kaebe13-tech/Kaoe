import type { World } from './World';
import { DAY_LENGTH, HOUR } from '../world/config';
import { TAU } from '../core/math';
import { civHistory, territoryAt } from '../civ/civSystem';
import { leaderMemory, requestLeaderThought } from '../civ/leader';
import { Biome } from '../world/biomes';

export type WorldEventKind = 'drought' | 'bloom' | 'surge' | 'mist' | 'tempest' | 'starfall';

export interface WorldEventRecord {
  kind: WorldEventKind;
  time: number;
  text: string;
  x: number;
  z: number;
}

const LABEL: Record<WorldEventKind, string> = {
  drought: 'Drought',
  bloom: 'Great Bloom',
  surge: 'Crystal Surge',
  mist: 'Strange Mist',
  tempest: 'Tempest',
  starfall: 'Starfall',
};

export function worldEventLabel(k: WorldEventKind): string {
  return LABEL[k];
}

let checkT = 0;

/**
 * The world has moods of its own: droughts, blooms, mists, storms, surges of crystal light and
 * showers of falling stars. None of them are the god's doing, though the peoples may not know it.
 */
export function worldEvents(w: World, dt: number): void {
  checkT += dt;
  if (checkT < 10) return;
  checkT = 0;
  if (w.worldTime < w.nextWorldEvent) return;
  w.nextWorldEvent = w.worldTime + DAY_LENGTH * w.rng.range(0.7, 1.5);
  if (w.worldTime - w.startTime < DAY_LENGTH * 0.8) return;
  const night = w.worldNight;
  const pool: Array<[WorldEventKind, number]> = [
    ['bloom', 3],
    ['mist', 2],
    ['tempest', 2],
    ['drought', 1.2],
    ['surge', w.terrain.landmarks.some((l) => l.kind === 'crystalSpire') ? 1.5 : 0],
    ['starfall', night ? 3 : 0.5],
  ];
  let total = 0;
  for (const [, p] of pool) total += p;
  let roll = w.rng.range(0, total);
  let kind: WorldEventKind = 'bloom';
  for (const [k, p] of pool) {
    roll -= p;
    if (roll <= 0) {
      kind = k;
      break;
    }
  }
  startWorldEvent(w, kind);
}

/** Start a world event now (also used by the debug tools and tests). */
export function startWorldEvent(w: World, kind: WorldEventKind): WorldEventRecord | null {
  const regions = w.terrain.regions.filter((r) => r.biome !== Biome.Ocean);
  if (!regions.length) return null;
  // Events favour lands where people live, so someone is there to see them.
  const lived = regions.filter((r) => w.settlements.some((s) => Math.hypot(s.x - r.x, s.z - r.z) < r.radius + 40));
  const region = w.rng.chance(0.7) && lived.length ? w.rng.pick(lived) : w.rng.pick(regions);
  let x = region.x;
  let z = region.z;
  let text = '';
  switch (kind) {
    case 'drought': {
      w.weather.droughts.push({ x, z, radius: 75, until: w.worldTime + DAY_LENGTH * w.rng.range(1, 1.8) });
      for (const c of w.weather.clouds) if (Math.hypot(c.x - x, c.z - z) < 90) c.ttl = Math.min(c.ttl, 5);
      text = `A drought settles over ${region.name}. The streams run thin and fruit withers.`;
      break;
    }
    case 'bloom': {
      let n = 0;
      w.resourceHash.query(x, z, region.radius, (r) => {
        if ((r.kind === 'berryBush' || r.kind === 'fruitTree' || r.kind === 'mushroom') && r.burning === 0) {
          if (r.state !== 'grown') w.setResourceState(r, 'grown', 1);
          r.amount = r.max;
          w.events.emit('resourceChanged', r);
          n++;
        }
      });
      w.events.emit('fx', { kind: 'bloom', x, z, count: 80 });
      text = `A great bloom sweeps across ${region.name}: every bush hangs heavy with fruit.`;
      if (!n) return null;
      break;
    }
    case 'surge': {
      const spire = w.rng.pick(w.terrain.landmarks.filter((l) => l.kind === 'crystalSpire'));
      if (!spire) return null;
      x = spire.x;
      z = spire.z;
      w.resourceHash.query(x, z, 60, (r) => {
        if (r.kind === 'crystal') {
          if (r.state !== 'grown') w.setResourceState(r, 'grown', 1);
          r.amount = r.max;
          w.events.emit('resourceChanged', r);
        }
      });
      for (const a of w.agents) {
        if (!a.alive || Math.hypot(a.x - x, a.z - z) > 70) continue;
        a.faith = Math.min(1, a.faith + 0.12);
        a.needs.energy = Math.min(1, a.needs.energy + 0.3);
        a.addLog(w.now(a), 'event', 'The crystals sang, and light poured from the spire.');
      }
      w.events.emit('divineFx', { kind: 'surge', x, z, r: 60 });
      text = `${spire.name} blazes with light. Crystal grows back all around it.`;
      break;
    }
    case 'mist': {
      w.weather.addFog(x, z, region.radius + 30, HOUR * w.rng.range(3, 6), 0.85);
      text = `A strange mist rolls over ${region.name}. Voices carry oddly in it.`;
      break;
    }
    case 'tempest': {
      const a = w.rng.range(0, TAU);
      w.weather.summon(x + Math.cos(a) * 30, z + Math.sin(a) * 30, false, 70, HOUR * w.rng.range(2.5, 4), 1);
      text = `A tempest builds over ${region.name}. Thunder rolls across the land.`;
      break;
    }
    case 'starfall': {
      w.events.emit('divineFx', { kind: 'starfall', x, z, r: 200, t: 40 });
      // One star comes all the way down and leaves a shard of sky-crystal.
      for (let k = 0; k < 20; k++) {
        const px = x + w.rng.range(-region.radius, region.radius);
        const pz = z + w.rng.range(-region.radius, region.radius);
        if (!w.nav.walkable(px, pz)) continue;
        w.addResource({ id: w.nextId(), kind: 'crystal', variant: 0, x: px, z: pz, rot: w.rng.range(0, TAU), scale: 1.2, blockRadius: 0.5, amount: 5, max: 5, regrow: 0, state: 'grown', growth: 1, burning: 0, claims: 0, blessed: true, lastUse: -1e9 });
        w.events.emit('fx', { kind: 'sparkle', x: px, z: pz, y: 0.5, count: 30 });
        break;
      }
      text = `Stars fall across the sky over ${region.name}.`;
      break;
    }
  }
  const rec: WorldEventRecord = { kind, time: w.worldTime, text, x, z };
  w.worldEventLog.push(rec);
  if (w.worldEventLog.length > 30) w.worldEventLog.shift();
  w.log(text, kind === 'drought' ? 'warning' : kind === 'tempest' ? 'rain' : kind === 'bloom' ? 'food' : 'star', 3, { x, z });
  // Peoples in or near the region take note, and wonder whether it was sent.
  for (const civ of w.civs) {
    if (civ.population === 0) continue;
    const home = civ.capital;
    const near = home && Math.hypot(home.x - x, home.z - z) < region.radius + 90;
    const owned = territoryAt(w, x, z) === civ.id;
    if (!near && !owned) continue;
    civHistory(w, civ, text, kind === 'drought' || kind === 'tempest' ? 'disaster' : 'discovery', 2);
    leaderMemory(civ, text, kind === 'drought' ? 3 : 2);
    requestLeaderThought(w, civ, `world event: ${LABEL[kind].toLowerCase()} in ${region.name}`);
    if (kind === 'drought') civ.rep.anger = Math.min(1, civ.rep.anger + 0.03);
    if (kind === 'bloom' || kind === 'surge' || kind === 'starfall') civ.rep.awe = Math.min(1, civ.rep.awe + 0.04);
  }
  w.events.emit('civEvent', { civId: -1, kind: 'world', text, x, z });
  return rec;
}
