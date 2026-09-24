import { Rng } from '../core/rng';
import { SpatialHash } from '../core/spatialHash';
import { smoothstep, TAU, type V2 } from '../core/math';
import { ISLAND_RADIUS } from './config';
import type { Terrain } from './Terrain';
import { TreeVariant, type ResourceKind, type ResourceNode } from '../sim/types';

interface Placed {
  id: number;
  x: number;
  z: number;
  r: number;
}

/**
 * Places trees, berry patches, fruit trees and boulders with believable ecology:
 * dense forests where moisture is high, palms on beaches, pines up the mountain,
 * berry patches in meadows and along forest edges, a natural clearing at the start.
 */
export function populateResources(terrain: Terrain, seed: number, start: V2): ResourceNode[] {
  const rng = new Rng(seed ^ 0x7ee5);
  const out: ResourceNode[] = [];
  const hash = new SpatialHash<Placed>(6);
  let nextId = 1;

  const clearance = (x: number, z: number, r: number): boolean => {
    let ok = true;
    hash.query(x, z, r + 3, (p, d2) => {
      const need = r + p.r;
      if (d2 < need * need) {
        ok = false;
        return true;
      }
      return false;
    });
    return ok;
  };

  const nearPond = (x: number, z: number, margin: number): boolean => {
    for (const p of terrain.ponds) if (Math.hypot(x - p.x, z - p.z) < p.radius * 1.2 + margin) return true;
    return false;
  };

  const add = (kind: ResourceKind, variant: number, x: number, z: number, opts: Partial<ResourceNode>, spacing: number): ResourceNode => {
    const id = nextId++;
    const node: ResourceNode = {
      id,
      kind,
      variant,
      x,
      z,
      rot: rng.range(0, TAU),
      scale: 1,
      blockRadius: 0,
      amount: 0,
      max: 0,
      regrow: rng.next(),
      state: 'grown',
      growth: 1,
      burning: 0,
      claims: 0,
      blessed: false,
      lastUse: -1e9,
      ...opts,
    };
    out.push(node);
    hash.insert({ id, x, z, r: spacing });
    return node;
  };

  const distStart = (x: number, z: number) => Math.hypot(x - start.x, z - start.z);

  // ---- Boulders first (they shape where trees can go) ----------------------
  for (let i = 0; i < 900 && out.filter((r) => r.kind === 'rock').length < 42; i++) {
    const a = rng.range(0, TAU);
    const d = Math.sqrt(rng.next()) * ISLAND_RADIUS * 1.05;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const h = terrain.heightAt(x, z);
    const s = terrain.slopeAt(x, z);
    if (h < 0.4 || terrain.isWater(x, z) || nearPond(x, z, 2)) continue;
    const p = h > 8 ? 0.5 : s > 0.45 ? 0.35 : h < 1.4 ? 0.12 : 0.04;
    if (!rng.chance(p)) continue;
    if (distStart(x, z) < 12) continue;
    const scale = rng.range(0.7, 1.6);
    const r = 0.75 * scale;
    if (!clearance(x, z, r + 0.5)) continue;
    add('rock', rng.int(0, 2), x, z, { scale, blockRadius: r }, r + 0.4);
  }

  // ---- Trees -------------------------------------------------------------
  const spacing = 2.3;
  for (let gz = -ISLAND_RADIUS * 1.2; gz < ISLAND_RADIUS * 1.2; gz += spacing) {
    for (let gx = -ISLAND_RADIUS * 1.2; gx < ISLAND_RADIUS * 1.2; gx += spacing) {
      const x = gx + rng.range(-0.9, 0.9) * spacing * 0.5;
      const z = gz + rng.range(-0.9, 0.9) * spacing * 0.5;
      const h = terrain.heightAt(x, z);
      if (h < 0.45) continue;
      if (terrain.isWater(x, z) || nearPond(x, z, 1.5)) continue;
      const s = terrain.slopeAt(x, z);
      if (s > 0.85) continue;
      const m = terrain.moistureAt(x, z);
      let p: number;
      let variant: number = TreeVariant.Broadleaf;
      if (h < 2.0) {
        // Beach band: sparse palms.
        p = h > 0.6 && s < 0.4 ? 0.09 : 0;
        variant = TreeVariant.Palm;
      } else {
        const forest = smoothstep(0.44, 0.62, m);
        p = 0.03 + forest * 0.85;
        if (h > 7.5 || (forest > 0.3 && rng.chance(0.28))) variant = TreeVariant.Pine;
        if (h > 12) p *= 0.5;
      }
      const ds = distStart(x, z);
      if (ds < 11) p = 0;
      else if (ds < 20) p *= 0.35;
      if (!rng.chance(p)) continue;
      if (!clearance(x, z, 1.05)) continue;
      const scale = variant === TreeVariant.Palm ? rng.range(0.85, 1.15) : rng.range(0.8, 1.25);
      const wood = variant === TreeVariant.Palm ? rng.int(2, 3) : variant === TreeVariant.Pine ? rng.int(3, 4) : rng.int(4, 5);
      add('tree', variant, x, z, { scale, blockRadius: 0.4, amount: wood, max: wood }, 1.05);
    }
  }

  // ---- Berry patches -------------------------------------------------------
  const patchCenters: V2[] = [];
  const tryPatch = (minD: number, maxD: number): boolean => {
    for (let k = 0; k < 400; k++) {
      const a = rng.range(0, TAU);
      const d = rng.range(minD, maxD);
      const x = start.x + Math.cos(a) * d;
      const z = start.z + Math.sin(a) * d;
      const h = terrain.heightAt(x, z);
      if (h < 1.5 || h > 10 || terrain.slopeAt(x, z) > 0.4 || terrain.isWater(x, z) || nearPond(x, z, 2)) continue;
      if (Math.hypot(x, z) > ISLAND_RADIUS * 0.95) continue;
      if (patchCenters.some((p) => Math.hypot(p.x - x, p.z - z) < 15)) continue;
      patchCenters.push({ x, z });
      return true;
    }
    return false;
  };
  // A couple of patches within easy reach of camp, the rest scattered.
  tryPatch(13, 24);
  tryPatch(18, 32);
  for (let i = 0; i < 14; i++) tryPatch(20, ISLAND_RADIUS * 1.6);

  for (const c of patchCenters) {
    const count = rng.int(3, 6);
    let placed = 0;
    for (let k = 0; k < 40 && placed < count; k++) {
      const a = rng.range(0, TAU);
      const d = rng.range(0, 4.5);
      const x = c.x + Math.cos(a) * d;
      const z = c.z + Math.sin(a) * d;
      if (terrain.heightAt(x, z) < 1.2 || terrain.isWater(x, z) || terrain.slopeAt(x, z) > 0.5) continue;
      if (!clearance(x, z, 0.8)) continue;
      const max = rng.int(4, 6);
      add('berryBush', rng.int(0, 1), x, z, { scale: rng.range(0.85, 1.15), amount: max, max, blockRadius: 0 }, 0.8);
      placed++;
    }
  }

  // ---- Fruit trees ---------------------------------------------------------
  const fruit: V2[] = [];
  for (let k = 0; k < 2000 && fruit.length < 6; k++) {
    const a = rng.range(0, TAU);
    const d = Math.sqrt(rng.next()) * ISLAND_RADIUS * 0.9;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const h = terrain.heightAt(x, z);
    if (h < 2 || h > 9 || terrain.slopeAt(x, z) > 0.35 || terrain.isWater(x, z) || nearPond(x, z, 2)) continue;
    if (distStart(x, z) < 22) continue;
    if (fruit.some((p) => Math.hypot(p.x - x, p.z - z) < 24)) continue;
    if (!clearance(x, z, 1.4)) continue;
    fruit.push({ x, z });
    const max = rng.int(5, 7);
    add('fruitTree', 0, x, z, { scale: rng.range(0.95, 1.15), amount: max, max, blockRadius: 0.4 }, 1.4);
  }

  return out;
}
