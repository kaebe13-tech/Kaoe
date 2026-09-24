import { clamp, type V2 } from '../core/math';
import { HEIGHT_RES, SEA_LEVEL, WORLD_HALF, WORLD_SIZE } from './config';

export interface Pond {
  id: number;
  x: number;
  z: number;
  radius: number;
  /** Water surface height. */
  level: number;
}

/**
 * Heightfield + derived fields for the island. Pure data: no rendering dependencies,
 * so the simulation can run headless.
 */
export class Terrain {
  readonly res = HEIGHT_RES;
  readonly size = WORLD_SIZE;
  readonly cell = WORLD_SIZE / (HEIGHT_RES - 1);
  readonly heights: Float32Array;
  /** 0..1 moisture used for vegetation density and color variation. */
  readonly moisture: Float32Array;
  readonly ponds: Pond[];

  constructor(heights: Float32Array, moisture: Float32Array, ponds: Pond[]) {
    this.heights = heights;
    this.moisture = moisture;
    this.ponds = ponds;
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
    const ix = Math.round(clamp(this.toGrid(x), 0, this.res - 1));
    const iz = Math.round(clamp(this.toGrid(z), 0, this.res - 1));
    return this.moisture[iz * this.res + ix]!;
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

  pondAt(x: number, z: number): Pond | null {
    for (const p of this.ponds) {
      const dx = x - p.x;
      const dz = z - p.z;
      if (dx * dx + dz * dz < (p.radius * 1.6) ** 2 && this.heightAt(x, z) < p.level) return p;
    }
    return null;
  }

  /** True if the point is under the sea or a pond surface. */
  isWater(x: number, z: number): boolean {
    const h = this.heightAt(x, z);
    if (h < SEA_LEVEL + 0.05) return true;
    return this.pondAt(x, z) !== null;
  }

  inBounds(p: V2, margin = 0): boolean {
    return Math.abs(p.x) < WORLD_HALF - margin && Math.abs(p.z) < WORLD_HALF - margin;
  }
}
