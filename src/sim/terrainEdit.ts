import type { World } from './World';
import { NO_WATER, type Pond } from '../world/Terrain';
import { Biome } from '../world/biomes';
import { smoothstep } from '../core/math';

export type TerrainEditKind = 'raise' | 'lower' | 'crater' | 'spring';

/** A change to the land made by the god. Saved and replayed on load, in order. */
export interface TerrainEdit {
  kind: TerrainEditKind;
  x: number;
  z: number;
  r: number;
  amount: number;
  /** Pond created by a spring. */
  pondId?: number;
}

export interface EditBounds {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Why the land refused, or null if it can be shaped here. */
export function editBlocked(w: World, kind: TerrainEditKind, x: number, z: number, r: number): string | null {
  const t = w.terrain;
  if (Math.abs(x) > t.size / 2 - r - 4 || Math.abs(z) > t.size / 2 - r - 4) return 'That is the edge of the world.';
  for (const l of t.landmarks) if (Math.hypot(l.x - x, l.z - z) < r + Math.max(8, l.block + 6)) return `${l.name} resists your touch.`;
  if (kind === 'spring') {
    if (t.heightAt(x, z) < 1.2) return 'The ground there is too low for a spring.';
    if (t.isWater(x, z)) return 'There is already water there.';
    for (const p of t.ponds) if (Math.hypot(p.x - x, p.z - z) < p.radius + r + 4) return 'Too close to other water.';
  }
  return null;
}

/**
 * Change the heightfield (and water) for one edit. Pure terrain work, also used when replaying
 * saved edits. Rivers and lakes keep their beds so water never floats or vanishes.
 */
export function shapeTerrain(w: World, e: TerrainEdit): EditBounds {
  const t = w.terrain;
  const reach = e.kind === 'crater' ? e.r * 1.45 : e.r;
  const g0x = Math.max(0, Math.floor(t.toGrid(e.x - reach)));
  const g0z = Math.max(0, Math.floor(t.toGrid(e.z - reach)));
  const g1x = Math.min(t.res - 1, Math.ceil(t.toGrid(e.x + reach)));
  const g1z = Math.min(t.res - 1, Math.ceil(t.toGrid(e.z + reach)));
  const pondId = e.kind === 'spring' ? (e.pondId ?? 900 + t.ponds.length) : -1;
  for (let iz = g0z; iz <= g1z; iz++) {
    for (let ix = g0x; ix <= g1x; ix++) {
      const x = t.toWorld(ix);
      const z = t.toWorld(iz);
      const d = Math.hypot(x - e.x, z - e.z) / e.r;
      if (d > reach / e.r) continue;
      const i = iz * t.res + ix;
      if (t.riverMask[i] || (t.waterLevel[i]! > NO_WATER && e.kind !== 'spring')) continue;
      const h = t.heights[i]!;
      let dh = 0;
      const s = 1 - Math.min(1, d);
      switch (e.kind) {
        case 'raise':
          dh = e.amount * s * s * (3 - 2 * s);
          break;
        case 'lower':
          dh = -e.amount * s * s * (3 - 2 * s);
          break;
        case 'crater': {
          const bowl = d < 1 ? -e.amount * (1 - d * d) : 0;
          const rim = e.amount * 0.32 * Math.exp(-(((d - 1) / 0.2) ** 2));
          dh = bowl + rim;
          if (d < 0.85) t.biome[i] = Biome.Ashen;
          break;
        }
        case 'spring':
          dh = -e.amount * smoothstep(0, 1, s * 1.25);
          t.moisture[i] = Math.min(1, t.moisture[i]! + 0.4 * (1 - Math.min(1, d / 1.6)));
          break;
      }
      let nh = h + dh;
      if (e.kind === 'lower' || e.kind === 'crater') nh = Math.max(nh, Math.min(h, -2.5));
      t.heights[i] = nh;
    }
  }
  if (e.kind === 'spring') {
    // The water settles a little below the lowest point of the rim.
    let rim = Infinity;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      rim = Math.min(rim, t.heightAt(e.x + Math.cos(a) * e.r * 1.02, e.z + Math.sin(a) * e.r * 1.02));
    }
    const floor = t.heightAt(e.x, e.z);
    const level = Math.max(floor + 0.6, rim - 0.3);
    for (let iz = g0z; iz <= g1z; iz++) {
      for (let ix = g0x; ix <= g1x; ix++) {
        const i = iz * t.res + ix;
        const x = t.toWorld(ix);
        const z = t.toWorld(iz);
        if (Math.hypot(x - e.x, z - e.z) > e.r * 1.1) continue;
        if (t.heights[i]! < level) t.waterLevel[i] = level;
      }
    }
    const pond: Pond = { id: pondId, x: e.x, z: e.z, radius: e.r * 0.78, level };
    if (!t.ponds.some((p) => p.id === pondId)) t.ponds.push(pond);
    e.pondId = pondId;
  }
  return { x0: e.x - reach - 2, z0: e.z - reach - 2, x1: e.x + reach + 2, z1: e.z + reach + 2 };
}

/**
 * Apply an edit to a live world: shape the land, refresh walkability, move or bury what stood
 * there, record it for saving, and tell the views.
 */
export function editTerrain(w: World, e: TerrainEdit): EditBounds {
  const b = shapeTerrain(w, e);
  w.terrainEdits.push({ ...e });
  w.nav.refreshTerrain(w.terrain, b.x0, b.z0, b.x1, b.z1);
  if (e.kind === 'spring' && e.pondId !== undefined) {
    const p = w.terrain.ponds.find((q) => q.id === e.pondId);
    if (p) w.addPondWater(p, 'the Godspring');
  }
  // Anyone standing somewhere they can no longer stand steps aside.
  for (const a of w.agents) {
    if (!a.alive || a.x < b.x0 || a.x > b.x1 || a.z < b.z0 || a.z > b.z1) continue;
    if (!w.nav.walkable(a.x, a.z)) {
      const p = w.nav.nearestWalkable(a.x, a.z, 14);
      if (p) {
        a.x = a.prevX = p.x;
        a.z = a.prevZ = p.z;
        w.agentHash.update(a);
      }
    }
    a.nav.status = a.nav.status === 'moving' ? 'failed' : a.nav.status;
  }
  // Plants and stones rest on the new ground (the views re-seat them).
  w.resourceHash.query((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, Math.max(b.x1 - b.x0, b.z1 - b.z0) * 0.72, (r) => {
    if (w.terrain.isWater(r.x, r.z) && r.state !== 'burnt') {
      w.setResourceState(r, 'burnt');
      r.amount = 0;
    }
    w.events.emit('resourceChanged', r);
  });
  for (const s of w.structures) if (s.x > b.x0 && s.x < b.x1 && s.z > b.z0 && s.z < b.z1) w.events.emit('structureChanged', s);
  w.events.emit('terrainChanged', b);
  return b;
}
