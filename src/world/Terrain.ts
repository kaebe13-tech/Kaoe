import { clamp, type V2 } from '../core/math';
import { HEIGHT_RES, SEA_LEVEL, WORLD_HALF, WORLD_SIZE } from './config';
import { Biome, type BiomeId, type Landmark, type Region, type River } from './biomes';

export interface Pond {
  id: number;
  x: number;
  z: number;
  radius: number;
  /** Water surface height. */
  level: number;
  /** Magical spring (heals). */
  magic?: boolean;
}

/** No water surface at this cell. */
export const NO_WATER = -1e6;

/**
 * Heightfield + derived fields for the world. Pure data: no rendering dependencies,
 * so the simulation can run headless.
 */
export class Terrain {
  readonly res = HEIGHT_RES;
  readonly size = WORLD_SIZE;
  readonly cell = WORLD_SIZE / (HEIGHT_RES - 1);
  readonly heights: Float32Array;
  /** 0..1 moisture used for vegetation density and color variation. */
  readonly moisture: Float32Array;
  /** Biome id per heightmap sample. */
  readonly biome: Uint8Array;
  /** Surface height of inland water (lakes, rivers) per sample, NO_WATER where dry. */
  readonly waterLevel: Float32Array;
  /** 1 where the inland water is a river (flows, can be waded when shallow). */
  readonly riverMask: Uint8Array;
  /** Lakes (and the odd magical spring). Named "ponds" for older call sites. */
  readonly ponds: Pond[];
  rivers: River[] = [];
  regions: Region[] = [];
  landmarks: Landmark[] = [];

  constructor(heights: Float32Array, moisture: Float32Array, ponds: Pond[], biome?: Uint8Array, waterLevel?: Float32Array, riverMask?: Uint8Array) {
    const n = HEIGHT_RES * HEIGHT_RES;
    this.heights = heights;
    this.moisture = moisture;
    this.ponds = ponds;
    this.biome = biome ?? new Uint8Array(n).fill(Biome.Greenheart);
    this.waterLevel = waterLevel ?? new Float32Array(n).fill(NO_WATER);
    this.riverMask = riverMask ?? new Uint8Array(n);
  }

  /** Heightmap sample at integer grid coordinates (clamped). */
  sample(ix: number, iz: number): number {
    const r = this.res - 1;
    ix = ix < 0 ? 0 : ix > r ? r : ix;
    iz = iz < 0 ? 0 : iz > r ? r : iz;
    return this.heights[iz * this.res + ix]!;
  }

  toGrid(w: number): number {
    return (w + WORLD_HALF) / this.cell;
  }

  toWorld(g: number): number {
    return g * this.cell - WORLD_HALF;
  }

  /** Index of the nearest heightmap sample. */
  indexAt(x: number, z: number): number {
    const ix = Math.round(clamp(this.toGrid(x), 0, this.res - 1));
    const iz = Math.round(clamp(this.toGrid(z), 0, this.res - 1));
    return iz * this.res + ix;
  }

  /** Bilinear height at world position. */
  heightAt(x: number, z: number): number {
    const gx = clamp(this.toGrid(x), 0, this.res - 1.0001);
    const gz = clamp(this.toGrid(z), 0, this.res - 1.0001);
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const r = this.res;
    const h = this.heights;
    const i = iz * r + ix;
    const h00 = h[i]!;
    const h10 = h[i + 1]!;
    const h01 = h[i + r]!;
    const h11 = h[i + r + 1]!;
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  }

  moistureAt(x: number, z: number): number {
    return this.moisture[this.indexAt(x, z)]!;
  }

  biomeAt(x: number, z: number): BiomeId {
    return this.biome[this.indexAt(x, z)]! as BiomeId;
  }

  /** Slope as rise/run magnitude (0 = flat, 1 = 45 degrees). */
  slopeAt(x: number, z: number): number {
    const e = this.cell;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return Math.sqrt(dx * dx + dz * dz) / (2 * e);
  }

  normalAt(x: number, z: number, out: { x: number; y: number; z: number }): void {
    const e = this.cell;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const nx = -dx;
    const ny = 2 * e;
    const nz = -dz;
    const l = Math.hypot(nx, ny, nz);
    out.x = nx / l;
    out.y = ny / l;
    out.z = nz / l;
  }

  /** Inland water surface at a point (lake or river), or NO_WATER. */
  waterLevelAt(x: number, z: number): number {
    return this.waterLevel[this.indexAt(x, z)]!;
  }

  /** Depth of inland water at a point (0 when dry). */
  waterDepthAt(x: number, z: number): number {
    const l = this.waterLevelAt(x, z);
    if (l <= NO_WATER) return 0;
    return Math.max(0, l - this.heightAt(x, z));
  }

  isRiver(x: number, z: number): boolean {
    return this.riverMask[this.indexAt(x, z)] === 1 && this.waterDepthAt(x, z) > 0.02;
  }

  /** The lake covering a point, if any. */
  pondAt(x: number, z: number): Pond | null {
    for (const p of this.ponds) {
      const dx = x - p.x;
      const dz = z - p.z;
      if (dx * dx + dz * dz < (p.radius * 1.6) ** 2 && this.heightAt(x, z) < p.level) return p;
    }
    return null;
  }

  /** True if the point is under the sea, a lake or a river. */
  isWater(x: number, z: number): boolean {
    const h = this.heightAt(x, z);
    if (h < SEA_LEVEL + 0.05) return true;
    const l = this.waterLevelAt(x, z);
    return l > NO_WATER && h < l - 0.02;
  }

  inBounds(p: V2, margin = 0): boolean {
    return Math.abs(p.x) < WORLD_HALF - margin && Math.abs(p.z) < WORLD_HALF - margin;
  }

  regionAt(x: number, z: number): Region | null {
    const b = this.biomeAt(x, z);
    let best: Region | null = null;
    let bd = Infinity;
    for (const r of this.regions) {
      const d = Math.hypot(r.x - x, r.z - z) / Math.max(1, r.radius) - (r.biome === b ? 0.6 : 0);
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    return best;
  }
}
