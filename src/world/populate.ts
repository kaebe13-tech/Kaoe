import { Rng } from '../core/rng';
import { SpatialHash } from '../core/spatialHash';
import { Simplex2 } from '../core/noise';
import { smoothstep, TAU, type V2 } from '../core/math';
import { WORLD_HALF } from './config';
import type { Terrain } from './Terrain';
import { Biome, type BiomeId } from './biomes';
import { RockVariant, TreeVariant, type ResourceKind, type ResourceNode } from '../sim/types';

interface Placed {
  id: number;
  x: number;
  z: number;
  r: number;
}

/**
 * Places trees, food, stone and crystal with believable ecology per biome: oak groves and
 * fruit in the valley, giant elders and mushrooms in the old forest, pines and boulders in
 * the highlands, silverbark and crystal on the plateau, charred snags on the ashlands, palms
 * along the beaches. Clearings are kept around civilization homelands and landmarks.
 */
export function populateResources(terrain: Terrain, seed: number, homes: V2 | V2[]): ResourceNode[] {
  const sites = Array.isArray(homes) ? homes : [homes];
  const rng = new Rng(seed ^ 0x7ee5);
  const groves = new Simplex2(seed ^ 0x6a0e);
  const out: ResourceNode[] = [];
  const hash = new SpatialHash<Placed>(6);
  let nextId = 1;

  const clearance = (x: number, z: number, r: number): boolean => {
    let ok = true;
    hash.query(x, z, r + 4, (p, d2) => {
      const need = r + p.r;
      if (d2 < need * need) {
        ok = false;
        return true;
      }
      return false;
    });
    return ok;
  };
  const nearWater = (x: number, z: number, margin: number): boolean => {
    for (const p of terrain.ponds) if (Math.hypot(x - p.x, z - p.z) < p.radius * 1.25 + margin) return true;
    return terrain.isWater(x, z) || terrain.isWater(x + margin, z) || terrain.isWater(x - margin, z) || terrain.isWater(x, z + margin) || terrain.isWater(x, z - margin);
  };
  const nearLandmark = (x: number, z: number, margin: number): boolean => {
    for (const l of terrain.landmarks) {
      const keep = l.kind === 'volcano' ? 0 : l.kind === 'greatTree' ? 9 : l.kind === 'temple' || l.kind === 'stoneCircle' || l.kind === 'titanBones' ? 10 : 6;
      if (keep && Math.hypot(x - l.x, z - l.z) < keep + margin) return true;
    }
    return false;
  };
  const distHome = (x: number, z: number): number => {
    let d = Infinity;
    for (const s of sites) d = Math.min(d, Math.hypot(x - s.x, z - s.z));
    return d;
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

  const L = WORLD_HALF - 8;

  // ---- Boulders first (they shape where trees can go) ----------------------
  for (let i = 0; i < 26000; i++) {
    const x = rng.range(-L, L);
    const z = rng.range(-L, L);
    const h = terrain.heightAt(x, z);
    if (h < 0.4 || nearWater(x, z, 1.5) || nearLandmark(x, z, 2)) continue;
    const s = terrain.slopeAt(x, z);
    const b = terrain.biomeAt(x, z);
    let p = b === Biome.Highlands ? (s > 0.45 ? 0.5 : 0.18) : b === Biome.Ashen ? 0.28 : b === Biome.CrystalWilds ? 0.12 : s > 0.5 ? 0.22 : h < 1.4 ? 0.08 : 0.025;
    if (h > 34) p *= 0.4;
    if (!rng.chance(p)) continue;
    if (distHome(x, z) < 13) continue;
    const scale = rng.range(0.7, 1.7) * (b === Biome.Highlands ? 1.15 : 1);
    const r = 0.75 * scale;
    if (!clearance(x, z, r + 0.5)) continue;
    const variant = b === Biome.Ashen ? RockVariant.Slab : rng.int(0, 2);
    const stone = Math.round(2 + scale * 3);
    add('rock', variant, x, z, { scale, blockRadius: r, amount: stone, max: stone }, r + 0.4);
  }

  // ---- Crystal clusters (the plateau only) ------------------------------------
  for (let i = 0; i < 9000; i++) {
    const x = rng.range(-L, L);
    const z = rng.range(-L, L);
    if (terrain.biomeAt(x, z) !== Biome.CrystalWilds) continue;
    const h = terrain.heightAt(x, z);
    if (h < 2 || nearWater(x, z, 1.5) || nearLandmark(x, z, 1)) continue;
    if (!rng.chance(0.08)) continue;
    const scale = rng.range(0.7, 1.35);
    if (!clearance(x, z, 0.9 * scale)) continue;
    const amt = rng.int(3, 5);
    add('crystal', rng.int(0, 1), x, z, { scale, blockRadius: 0.55 * scale, amount: amt, max: amt }, 0.9 * scale);
  }

  // ---- Trees -------------------------------------------------------------
  const spacing = 2.35;
  for (let gz = -L; gz < L; gz += spacing) {
    for (let gx = -L; gx < L; gx += spacing) {
      const x = gx + rng.range(-0.9, 0.9) * spacing * 0.5;
      const z = gz + rng.range(-0.9, 0.9) * spacing * 0.5;
      const h = terrain.heightAt(x, z);
      if (h < 0.45) continue;
      if (nearWater(x, z, 1.3) || nearLandmark(x, z, 0)) continue;
      const s = terrain.slopeAt(x, z);
      if (s > 0.9) continue;
      const m = terrain.moistureAt(x, z);
      const b = terrain.biomeAt(x, z);
      const grove = groves.fbm(x * 0.018, z * 0.018, 3) * 0.5 + 0.5;
      let p = 0;
      let variant: number = TreeVariant.Broadleaf;
      const roll = rng.next();
      switch (b as BiomeId) {
        case Biome.Coast:
          p = h > 0.6 && s < 0.4 ? 0.08 : 0;
          variant = TreeVariant.Palm;
          break;
        case Biome.Isles:
          p = h < 2.2 ? 0.1 : 0.3 * grove;
          variant = h < 2.2 ? TreeVariant.Palm : TreeVariant.Broadleaf;
          break;
        case Biome.Greenheart:
          p = h < 1.8 ? 0.05 : 0.015 + smoothstep(0.5, 0.72, grove * 0.6 + m * 0.5) * 0.75;
          variant = h < 1.8 ? TreeVariant.Palm : roll < 0.18 ? TreeVariant.Birch : roll < 0.24 && h > 9 ? TreeVariant.Pine : TreeVariant.Broadleaf;
          break;
        case Biome.Elderwood:
          p = 0.3 + smoothstep(0.35, 0.65, grove * 0.7 + m * 0.3) * 0.5;
          variant = roll < 0.1 ? TreeVariant.Elder : roll < 0.3 ? TreeVariant.Pine : roll < 0.38 ? TreeVariant.Birch : TreeVariant.Broadleaf;
          break;
        case Biome.Highlands:
          p = h > 30 ? 0.02 : (0.05 + smoothstep(0.45, 0.7, grove) * 0.55) * (1 - smoothstep(20, 30, h));
          variant = roll < 0.88 ? TreeVariant.Pine : TreeVariant.Birch;
          break;
        case Biome.CrystalWilds:
          p = 0.05 + smoothstep(0.55, 0.75, grove) * 0.3;
          variant = roll < 0.75 ? TreeVariant.Silverbark : TreeVariant.Pine;
          break;
        case Biome.Ashen:
          p = h > 22 ? 0 : 0.025 + smoothstep(0.62, 0.8, grove) * 0.2;
          variant = roll < 0.65 ? TreeVariant.Deadwood : TreeVariant.Pine;
          break;
        default:
          p = 0;
      }
      if (terrain.isRiver(x, z)) p = 0;
      const ds = distHome(x, z);
      if (ds < 11) p = 0;
      else if (ds < 22) p *= 0.3;
      if (!rng.chance(p)) continue;
      const elder = variant === TreeVariant.Elder;
      const r = elder ? 2.4 : 1.05;
      if (!clearance(x, z, r)) continue;
      if (elder && (s > 0.35 || nearWater(x, z, 3))) continue;
      const scale = variant === TreeVariant.Palm ? rng.range(0.85, 1.15) : elder ? rng.range(0.9, 1.2) : rng.range(0.8, 1.25);
      const wood =
        variant === TreeVariant.Palm ? rng.int(2, 3) : elder ? rng.int(10, 14) : variant === TreeVariant.Deadwood ? 2 : variant === TreeVariant.Pine ? rng.int(3, 4) : rng.int(4, 5);
      add('tree', variant, x, z, { scale, blockRadius: elder ? 1.05 * scale : 0.4, amount: wood, max: wood }, r);
    }
  }

  // ---- Food patches --------------------------------------------------------
  const patchCenters: V2[] = [];
  const tryPatch = (center: V2, minD: number, maxD: number, biomes: BiomeId[] | null, kind: 'berryBush' | 'mushroom'): boolean => {
    for (let k = 0; k < 300; k++) {
      const a = rng.range(0, TAU);
      const d = rng.range(minD, maxD);
      const x = center.x + Math.cos(a) * d;
      const z = center.z + Math.sin(a) * d;
      if (Math.abs(x) > L || Math.abs(z) > L) continue;
      const h = terrain.heightAt(x, z);
      if (h < 1.5 || terrain.slopeAt(x, z) > 0.45 || nearWater(x, z, 2) || nearLandmark(x, z, 2)) continue;
      if (biomes && !biomes.includes(terrain.biomeAt(x, z))) continue;
      if (patchCenters.some((p) => Math.hypot(p.x - x, p.z - z) < 14)) continue;
      patchCenters.push({ x, z });
      const count = kind === 'mushroom' ? rng.int(2, 4) : rng.int(3, 6);
      let placed = 0;
      for (let q = 0; q < 40 && placed < count; q++) {
        const aa = rng.range(0, TAU);
        const dd = rng.range(0, 4.5);
        const px = x + Math.cos(aa) * dd;
        const pz = z + Math.sin(aa) * dd;
        if (terrain.heightAt(px, pz) < 1.2 || terrain.isWater(px, pz) || terrain.slopeAt(px, pz) > 0.5) continue;
        if (!clearance(px, pz, 0.8)) continue;
        const max = kind === 'mushroom' ? rng.int(3, 5) : rng.int(4, 6);
        add(kind, rng.int(0, 1), px, pz, { scale: rng.range(0.85, 1.15), amount: max, max, blockRadius: 0 }, 0.8);
        placed++;
      }
      return true;
    }
    return false;
  };
  const regionCenter = (b: BiomeId): V2 => {
    const r = terrain.regions.find((g) => g.biome === b);
    return r ? { x: r.x, z: r.z } : { x: 0, z: 0 };
  };
  // Every homeland gets a couple of patches within easy reach.
  for (const s of sites) {
    tryPatch(s, 13, 26, null, 'berryBush');
    tryPatch(s, 18, 34, null, 'berryBush');
  }
  const spread: Array<[BiomeId, number, 'berryBush' | 'mushroom', number]> = [
    [Biome.Greenheart, 34, 'berryBush', 160],
    [Biome.Elderwood, 7, 'berryBush', 130],
    [Biome.Elderwood, 30, 'mushroom', 130],
    [Biome.Highlands, 12, 'berryBush', 200],
    [Biome.Highlands, 6, 'mushroom', 200],
    [Biome.CrystalWilds, 5, 'berryBush', 60],
    [Biome.Ashen, 5, 'berryBush', 120],
    [Biome.Coast, 6, 'berryBush', 320],
    [Biome.Isles, 3, 'berryBush', 60],
  ];
  for (const [b, n, kind, radius] of spread) {
    const c = regionCenter(b);
    for (let i = 0; i < n; i++) tryPatch(c, 0, radius, [b], kind);
  }

  // ---- Fruit trees ---------------------------------------------------------
  const fruit: V2[] = [];
  const tryFruit = (center: V2, minD: number, maxD: number, biomes: BiomeId[] | null): void => {
    for (let k = 0; k < 400; k++) {
      const a = rng.range(0, TAU);
      const d = rng.range(minD, maxD);
      const x = center.x + Math.cos(a) * d;
      const z = center.z + Math.sin(a) * d;
      if (Math.abs(x) > L || Math.abs(z) > L) continue;
      const h = terrain.heightAt(x, z);
      if (h < 2 || h > 18 || terrain.slopeAt(x, z) > 0.35 || nearWater(x, z, 2) || nearLandmark(x, z, 2)) continue;
      if (biomes && !biomes.includes(terrain.biomeAt(x, z))) continue;
      if (fruit.some((p) => Math.hypot(p.x - x, p.z - z) < 20)) continue;
      if (distHome(x, z) < 16) continue;
      if (!clearance(x, z, 1.4)) continue;
      fruit.push({ x, z });
      const max = rng.int(5, 7);
      add('fruitTree', 0, x, z, { scale: rng.range(0.95, 1.15), amount: max, max, blockRadius: 0.4 }, 1.4);
      return;
    }
  };
  for (const s of sites) tryFruit(s, 20, 42, null);
  const fruitSpread: Array<[BiomeId, number, number]> = [
    [Biome.Greenheart, 16, 150],
    [Biome.Elderwood, 3, 120],
    [Biome.CrystalWilds, 2, 50],
    [Biome.Isles, 2, 50],
    [Biome.Ashen, 1, 110],
    [Biome.Highlands, 2, 180],
  ];
  for (const [b, n, radius] of fruitSpread) {
    const c = regionCenter(b);
    for (let i = 0; i < n; i++) tryFruit(c, 0, radius, [b]);
  }

  return out;
}
