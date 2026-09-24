import { Simplex2 } from '../core/noise';
import { Rng } from '../core/rng';
import { clamp01, lerp, smoothstep, TAU, type V2 } from '../core/math';
import { HEIGHT_RES, ISLAND_RADIUS, WORLD_HALF, WORLD_SIZE } from './config';
import { Terrain, type Pond } from './Terrain';

export interface TerrainGenResult {
  terrain: Terrain;
  /** Where the tribe starts: a flat clearing near the main pond. */
  start: V2;
  mountain: V2;
}

/**
 * Generates a stylized island: warped coastline with beaches and a few cliffs,
 * rolling hills, one ridged mountain, and freshwater ponds carved into the interior.
 */
export function generateTerrain(seed: number): TerrainGenResult {
  const rng = new Rng(seed ^ 0x5eed1234);
  const nHills = new Simplex2(seed ^ 0xa11ce);
  const nWarp = new Simplex2(seed ^ 0xb0b);
  const nMoist = new Simplex2(seed ^ 0xc0ffee);
  const nRidge = new Simplex2(seed ^ 0xd00d);
  const nCoast = new Simplex2(seed ^ 0xe1e1);

  const res = HEIGHT_RES;
  const cell = WORLD_SIZE / (res - 1);
  const heights = new Float32Array(res * res);
  const moisture = new Float32Array(res * res);
  const coastDist = new Float32Array(res * res);

  const mAngle = rng.range(0, TAU);
  const mDist = ISLAND_RADIUS * rng.range(0.3, 0.42);
  const mountain = { x: Math.cos(mAngle) * mDist, z: Math.sin(mAngle) * mDist };

  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const x = ix * cell - WORLD_HALF;
      const z = iz * cell - WORLD_HALF;
      const i = iz * res + ix;

      // Warped radial distance gives an organic coastline with bays and headlands.
      const wx = x + 18 * nWarp.fbm(x * 0.011, z * 0.011, 3);
      const wz = z + 18 * nWarp.fbm(x * 0.011 + 41.3, z * 0.011 - 17.9, 3);
      const r = Math.hypot(wx, wz) / ISLAND_RADIUS;
      const c = (1 - r) * ISLAND_RADIUS; // approx. distance inland from the coast
      coastDist[i] = c;

      const coastN = nCoast.fbm(x * 0.03, z * 0.03, 2) * 0.5 + 0.5;
      const dm = Math.hypot(x - mountain.x, z - mountain.z);
      const mMask = 1 - smoothstep(8, 48, dm);
      // Cliffs are more likely on the mountain side of the island.
      const cliff = smoothstep(0.62, 0.8, coastN + mMask * 0.35);
      const beachWidth = lerp(lerp(3.5, 9.5, coastN), 1.2, cliff);

      const hills = nHills.fbm(x * 0.017, z * 0.017, 4) * 0.5 + 0.5;
      const ridge = nRidge.ridged(x * 0.024, z * 0.024, 4);
      const land = 1.1 + hills * 4.8 + mMask * mMask * (7 + ridge * 15);

      let h: number;
      if (c < 0) {
        // Shallow turquoise shelf that drops off to deep water well before the map edge.
        const off = -c;
        h = -2.4 * smoothstep(0, 11, off) - 9.6 * smoothstep(7, 30, off);
        h += nHills.noise(x * 0.05, z * 0.05) * 0.35 * clamp01(off / 10) * (1 - smoothstep(20, 30, off));
      } else {
        const beach = Math.min(c, beachWidth) * lerp(0.12, 0.5, cliff);
        const inlandT = smoothstep(beachWidth * 0.5, beachWidth + lerp(24, 8, cliff), c);
        h = beach + inlandT * land;
      }
      heights[i] = h;

      const m = nMoist.fbm(x * 0.021 + 7.7, z * 0.021 - 3.1, 3) * 0.5 + 0.5;
      moisture[i] = clamp01(m * smoothstep(-2, 14, c) * (1 - smoothstep(9, 16, h) * 0.6));
    }
  }

  const sampleH = (x: number, z: number): number => {
    const ix = Math.round((x + WORLD_HALF) / cell);
    const iz = Math.round((z + WORLD_HALF) / cell);
    if (ix < 0 || iz < 0 || ix >= res || iz >= res) return -10;
    return heights[iz * res + ix]!;
  };
  const sampleC = (x: number, z: number): number => {
    const ix = Math.round((x + WORLD_HALF) / cell);
    const iz = Math.round((z + WORLD_HALF) / cell);
    if (ix < 0 || iz < 0 || ix >= res || iz >= res) return -99;
    return coastDist[iz * res + ix]!;
  };

  // ---- Ponds -------------------------------------------------------------
  const ponds: Pond[] = [];
  const wanted = 3;
  for (let attempt = 0; attempt < 600 && ponds.length < wanted; attempt++) {
    const a = rng.range(0, TAU);
    const d = rng.range(0, ISLAND_RADIUS * (ponds.length === 0 ? 0.35 : 0.62));
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const h = sampleH(x, z);
    const c = sampleC(x, z);
    if (c < 26 || h < 1.6 || h > 7.5) continue;
    if (Math.hypot(x - mountain.x, z - mountain.z) < 26) continue;
    let ok = true;
    for (const p of ponds) if (Math.hypot(p.x - x, p.z - z) < 38) ok = false;
    if (!ok) continue;
    // Require fairly flat surroundings so the pond sits naturally.
    let maxDev = 0;
    for (let k = 0; k < 12; k++) {
      const aa = (k / 12) * TAU;
      maxDev = Math.max(maxDev, Math.abs(sampleH(x + Math.cos(aa) * 10, z + Math.sin(aa) * 10) - h));
    }
    if (maxDev > 3.2) continue;
    const radius = ponds.length === 0 ? rng.range(7, 8.5) : rng.range(5, 7.5);
    ponds.push({ id: ponds.length, x, z, radius, level: h - 0.35 });
  }

  for (const p of ponds) carvePond(p, heights, res, cell, rng.int(0, 1_000_000));

  // Moisture is higher around ponds (lush reeds, bushes).
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const x = ix * cell - WORLD_HALF;
      const z = iz * cell - WORLD_HALF;
      let boost = 0;
      for (const p of ponds) {
        const d = Math.hypot(x - p.x, z - p.z);
        boost = Math.max(boost, 1 - smoothstep(p.radius, p.radius * 3, d));
      }
      const i = iz * res + ix;
      moisture[i] = clamp01(moisture[i]! + boost * 0.3);
    }
  }

  const terrain = new Terrain(heights, moisture, ponds);

  // ---- Start location: flat, dry clearing a short walk from the main pond --------
  let start: V2 = { x: 0, z: 0 };
  const main = ponds[0];
  if (main) {
    let best = -Infinity;
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * TAU;
      for (const dd of [main.radius + 7, main.radius + 10, main.radius + 13]) {
        const x = main.x + Math.cos(a) * dd;
        const z = main.z + Math.sin(a) * dd;
        const s = terrain.slopeAt(x, z);
        const h = terrain.heightAt(x, z);
        if (h < 1.2) continue;
        // Prefer flat ground, facing toward the island center (more to explore).
        const score = -s * 8 - Math.hypot(x, z) * 0.02 - Math.abs(dd - main.radius - 10) * 0.1;
        if (score > best) {
          best = score;
          start = { x, z };
        }
      }
    }
  }

  return { terrain, start, mountain };
}

function carvePond(p: Pond, heights: Float32Array, res: number, cell: number, noiseSeed: number): void {
  const n = new Simplex2(noiseSeed);
  const outer = p.radius * 2.4;
  const ix0 = Math.max(0, Math.floor((p.x - outer + WORLD_HALF) / cell));
  const ix1 = Math.min(res - 1, Math.ceil((p.x + outer + WORLD_HALF) / cell));
  const iz0 = Math.max(0, Math.floor((p.z - outer + WORLD_HALF) / cell));
  const iz1 = Math.min(res - 1, Math.ceil((p.z + outer + WORLD_HALF) / cell));
  const depth = 1.6 + p.radius * 0.08;
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = ix * cell - WORLD_HALF;
      const z = iz * cell - WORLD_HALF;
      const dx = x - p.x;
      const dz = z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > outer) continue;
      const ang = Math.atan2(dz, dx);
      const rn = p.radius * (1 + 0.2 * n.noise(Math.cos(ang) * 1.3, Math.sin(ang) * 1.3));
      const i = iz * res + ix;
      const h = heights[i]!;
      if (d < rn) {
        const t = d / rn;
        heights[i] = p.level - depth * (1 - t * t) - 0.05;
      } else {
        // Gentle shore that rises out of the water, blended back into natural terrain.
        const shore = p.level + 0.12 + (d - rn) * 0.16;
        const w = 1 - smoothstep(rn * 1.15, outer, d);
        let nh = lerp(h, Math.max(shore, Math.min(h, shore + 1.5)), w);
        // Never let the ground around the pond dip below the water surface (no floating water).
        if (d < p.radius * 1.75) nh = Math.max(nh, p.level + 0.1 + (d - rn) * 0.05);
        heights[i] = nh;
      }
    }
  }
}
