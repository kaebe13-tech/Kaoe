import { hash01 } from '../core/rng';
import { DAY_LENGTH, HOUR, MAP_CELL, MAP_N, WORLD_HALF } from '../world/config';
import { effectiveSpeed } from '../civ/timeScale';
import { BLUEPRINTS } from './blueprints';
import { TreeVariant, type ResourceNode, type Structure } from './types';
import type { World } from './World';

const TICK = 1; // ecology runs once per game second

/**
 * Plants regrow, stumps sprout, fires spread and burn out. Runs at a low fixed rate
 * because nothing here needs frame precision.
 */
export class Ecology {
  private acc = 0;

  update(w: World, dt: number): void {
    this.acc += dt;
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.tick(w, TICK);
    }
  }

  private wearT = 0;
  /** Growth multiplier per civilization (its time bubble covers its own land). */
  private readonly civRate: number[] = [];

  /** How fast plants grow at a point: time runs at the local civilization's speed on its land. */
  private rateAt(w: World, x: number, z: number): number {
    const cx = Math.floor((x + WORLD_HALF) / MAP_CELL);
    const cz = Math.floor((z + WORLD_HALF) / MAP_CELL);
    if (cx < 0 || cz < 0 || cx >= MAP_N || cz >= MAP_N) return 1;
    const owner = w.territory[cz * MAP_N + cx]!;
    return owner >= 0 ? (this.civRate[owner] ?? 1) : 1;
  }

  private tick(w: World, dt: number): void {
    for (const c of w.civs) this.civRate[c.id] = effectiveSpeed(c, w.worldTime);
    for (const r of w.resources.values()) {
      if (r.burning > 0) {
        this.burnResource(w, r, dt);
        continue;
      }
      if (r.kind === 'rock') continue;
      if (r.state === 'grown' && r.amount >= r.max && !r.blessed && !w.weather.droughts.length) continue;
      const rate = this.rateAt(w, r.x, r.z);
      if (rate > 0) this.grow(w, r, dt * rate);
    }
    for (const s of [...w.structures]) this.updateStructure(w, s, dt);
    for (let i = w.dangers.length - 1; i >= 0; i--) {
      const d = w.dangers[i]!;
      d.ttl -= dt;
      if (d.ttl <= 0) w.dangers.splice(i, 1);
    }
    for (let i = w.scorches.length - 1; i >= 0; i--) {
      const s = w.scorches[i]!;
      s.age += dt;
      if (s.age > DAY_LENGTH * 1.5) w.scorches.splice(i, 1);
    }
    // Paths slowly grow back over when nobody walks them.
    this.wearT += dt;
    if (this.wearT >= 5) {
      const decay = (this.wearT / DAY_LENGTH) * 0.14;
      this.wearT = 0;
      const wear = w.wear;
      let any = false;
      for (let i = 0; i < wear.length; i++) {
        const v = wear[i]!;
        if (v > 0) {
          wear[i] = v > decay ? v - decay : 0;
          any = true;
        }
      }
      if (any) w.wearDirty = true;
    }
  }

  private grow(w: World, r: ResourceNode, dt: number): void {
    const rain = w.rainAt(r.x, r.z);
    const dry = w.weather.droughts.length ? w.weather.droughtAt(r.x, r.z, w.worldTime) : 0;
    const boost = (1 + rain * 2) * (r.blessed ? 2 : 1) * (1 - dry * 0.95);
    if (r.state === 'grown') {
      // Drought withers fruit on the branch.
      if (dry > 0.4 && r.amount > 0 && (r.kind === 'berryBush' || r.kind === 'fruitTree' || r.kind === 'mushroom')) {
        r.regrow -= (dt / (HOUR * 2)) * dry;
        if (r.regrow <= -1) {
          r.regrow = 0;
          r.amount--;
          w.events.emit('resourceChanged', r);
        }
        return;
      }
      if (r.amount >= r.max) return;
      let perUnit: number;
      if (r.kind === 'berryBush') perUnit = HOUR * 3;
      else if (r.kind === 'fruitTree') perUnit = HOUR * 5;
      else if (r.kind === 'mushroom') perUnit = HOUR * 4;
      else if (r.kind === 'crystal') perUnit = HOUR * 30 * (nearSpire(w, r) ? 0.25 : 1);
      else return; // trees don't regrow wood while standing
      r.regrow += (dt / perUnit) * boost;
      if (r.regrow >= 1) {
        r.regrow -= 1;
        r.amount++;
        w.events.emit('resourceChanged', r);
      }
      return;
    }
    if (r.state === 'stump' || r.state === 'burnt') {
      if (r.kind === 'crystal') {
        // Crystal slowly grows back from its shards.
        r.regrow += (dt / (DAY_LENGTH * (nearSpire(w, r) ? 0.8 : 2.5))) * boost;
        if (r.regrow >= 1) {
          r.regrow = 0;
          r.amount = 2;
          w.setResourceState(r, 'grown', 1);
        }
        return;
      }
      // Land cleared for the camp stays cleared.
      for (const s of w.structures) if (Math.abs(s.x - r.x) < 12 && Math.abs(s.z - r.z) < 12 && Math.hypot(s.x - r.x, s.z - r.z) < BLUEPRINTS[s.kind].radius + 5) return;
      const wait = (r.state === 'burnt' ? 1.4 : 1.1) * DAY_LENGTH * (0.8 + hash01(r.id, 17) * 0.5);
      r.regrow += (dt / wait) * boost;
      if (r.regrow >= 1) {
        r.regrow = 0;
        r.amount = 0;
        w.setResourceState(r, 'sapling', 0);
      }
      return;
    }
    if (r.state === 'sapling') {
      const span = (r.kind === 'berryBush' ? 0.5 : 1.3) * DAY_LENGTH;
      const before = r.growth;
      const growth = Math.min(1, r.growth + (dt / span) * boost);
      if (growth >= 1) {
        r.amount = r.kind === 'tree' ? (r.variant === TreeVariant.Broadleaf ? 4 : 3) : Math.ceil(r.max / 2);
        r.regrow = 0;
        w.setResourceState(r, 'grown', 1);
      } else if (Math.floor(before * 10) !== Math.floor(growth * 10)) {
        w.setResourceState(r, 'sapling', growth);
      } else r.growth = growth;
    }
  }

  private burnResource(w: World, r: ResourceNode, dt: number): void {
    const rain = w.rainAt(r.x, r.z);
    r.burning -= dt * (1 + rain * 8);
    if (rain > 0.35 && r.burning > 3) r.burning = Math.min(r.burning, 3);
    // Spread to neighbours unless it's wet.
    if (rain < 0.2) {
      w.resourceHash.query(r.x, r.z, 4.5, (n) => {
        if (n === r || n.burning > 0 || n.kind === 'rock' || n.state === 'burnt' || n.state === 'stump') return;
        const d = Math.hypot(n.x - r.x, n.z - r.z);
        const p = 0.05 * (1 - d / 4.5) * (n.kind === 'tree' ? 1 : 0.7);
        if (w.rng.chance(p * dt)) igniteResource(w, n);
      });
      for (const s of w.structures) {
        if (s.burning > 0 || s.kind === 'grave' || s.kind === 'campfire') continue;
        const d = Math.hypot(s.x - r.x, s.z - r.z);
        if (d < 4.5 + BLUEPRINTS[s.kind].radius * 0.5 && w.rng.chance(0.04 * dt)) igniteStructure(w, s);
      }
    }
    if (w.rng.chance(0.3 * dt)) w.events.emit('fx', { kind: 'embers', x: r.x, z: r.z, y: 2.5 });
    if (r.burning <= 0) {
      r.burning = 0;
      r.amount = 0;
      r.regrow = 0;
      if (r.kind === 'tree' || r.kind === 'fruitTree') {
        if (r.state === 'grown' || r.state === 'sapling') w.setResourceState(r, 'burnt');
        else w.events.emit('resourceChanged', r);
      } else {
        w.setResourceState(r, 'burnt');
      }
      w.events.emit('fx', { kind: 'smoke', x: r.x, z: r.z, y: 1.5, count: 8 });
    }
  }

  private updateStructure(w: World, s: Structure, dt: number): void {
    if (s.kind === 'campfire' && s.complete) {
      // The fire burns on its owners' clock.
      const h = w.hourOf(s.civId);
      const civ = w.civs[s.civId];
      const rate = civ ? this.civRate[civ.id] ?? 1 : 1;
      const rain = w.rainAt(s.x, s.z);
      const wantLit = (h >= 17.5 || h < 6.5) && s.fuel > 0 && rain < 0.55;
      if (wantLit !== s.lit) {
        s.lit = wantLit;
        w.events.emit('structureChanged', s);
      }
      if (s.lit) s.fuel = Math.max(0, s.fuel - (dt / HOUR) * 0.075 * (1 + rain) * rate);
    }
    if (s.burning > 0) {
      const rain = w.rainAt(s.x, s.z);
      s.burning -= dt * (1 + rain * 6);
      s.damage = Math.min(1, s.damage + (dt / 45) * (1 - rain * 0.8));
      if (w.rng.chance(0.4 * dt)) w.events.emit('fx', { kind: 'embers', x: s.x, z: s.z, y: 2.2 });
      if (rain < 0.2) {
        w.resourceHash.query(s.x, s.z, 5, (n) => {
          if (n.burning > 0 || n.kind === 'rock' || n.state !== 'grown') return;
          if (w.rng.chance(0.03 * dt)) igniteResource(w, n);
        });
      }
      if (s.damage >= 1) {
        const bp = BLUEPRINTS[s.kind];
        const owner = w.civs[s.civId];
        w.log(`${owner ? `${owner.name}'s` : 'The'} ${bp.name.toLowerCase()} burned to the ground.`, 'fire', 3, s);
        w.events.emit('fx', { kind: 'smoke', x: s.x, z: s.z, y: 1.5, count: 16 });
        w.removeStructure(s);
        return;
      }
      if (s.burning <= 0) {
        s.burning = 0;
        w.log(`The fire at the ${BLUEPRINTS[s.kind].name.toLowerCase()} went out.`, 'fire', 2, s);
        w.events.emit('structureChanged', s);
      }
    }
  }
}

export function igniteResource(w: World, r: ResourceNode): void {
  if (r.kind === 'rock' || r.burning > 0 || r.state === 'burnt' || r.state === 'stump') return;
  r.burning = r.kind === 'tree' || r.kind === 'fruitTree' ? 26 + w.rng.range(0, 12) : 12;
  w.dangers.push({ id: w.nextId(), x: r.x, z: r.z, radius: 7, ttl: r.burning + 4, kind: 'fire' });
  w.events.emit('resourceChanged', r);
  w.events.emit('sfx', { kind: 'ignite', x: r.x, z: r.z });
}

export function igniteStructure(w: World, s: Structure): void {
  if (s.burning > 0 || s.kind === 'grave' || s.kind === 'campfire') return;
  s.burning = 40;
  w.dangers.push({ id: w.nextId(), x: s.x, z: s.z, radius: 8, ttl: 44, kind: 'fire' });
  w.log(`The ${BLUEPRINTS[s.kind].name.toLowerCase()} caught fire!`, 'fire', 3, s);
  w.events.emit('structureChanged', s);
  w.events.emit('sfx', { kind: 'ignite', x: s.x, z: s.z });
}

export type { Structure };

function nearSpire(w: World, r: ResourceNode): boolean {
  for (const l of w.terrain.landmarks) if (l.kind === 'crystalSpire' && Math.hypot(l.x - r.x, l.z - r.z) < 40) return true;
  return false;
}
