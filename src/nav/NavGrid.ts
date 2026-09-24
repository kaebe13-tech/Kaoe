import type { V2 } from '../core/math';
import type { Terrain } from '../world/Terrain';
import { WORLD_HALF, WORLD_SIZE } from '../world/config';

/**
 * Walkability grid (1 unit cells) derived from the terrain plus dynamic blockers
 * (tree trunks, boulders, buildings). Blockers are reference-counted so overlapping
 * obstacles can be added and removed independently.
 */
export class NavGrid {
  readonly size = WORLD_SIZE;
  readonly cellSize = 1;
  readonly terrainOk: Uint8Array;
  readonly blockers: Uint16Array;
  readonly cost: Float32Array;
  /** Cells that are shallow river water (walkable, slow). */
  readonly wade: Uint8Array;
  /** Connected land masses (terrain only, ignoring blockers); 0 = unwalkable. */
  readonly component: Int32Array;
  /** Incremented whenever walkability changes; paths computed earlier may be stale. */
  version = 0;

  constructor(terrain: Terrain) {
    const n = this.size * this.size;
    this.terrainOk = new Uint8Array(n);
    this.blockers = new Uint16Array(n);
    this.cost = new Float32Array(n);
    this.wade = new Uint8Array(n);
    for (let cz = 0; cz < this.size; cz++) {
      for (let cx = 0; cx < this.size; cx++) {
        const x = this.toWorld(cx);
        const z = this.toWorld(cz);
        const h = terrain.heightAt(x, z);
        const i = cz * this.size + cx;
        const slope = terrain.slopeAt(x, z);
        let ok = h > 0.22 && slope < 1.05;
        let cost = 1 + slope * 1.6 + (h < 0.7 ? 0.35 : 0);
        const depth = terrain.waterDepthAt(x, z);
        if (depth > 0.04) {
          // Rivers can be waded where they are shallow; lakes cannot.
          if (terrain.isRiver(x, z) && depth < 1.15) {
            cost += 3 + depth * 5;
            this.wade[i] = 1;
          } else ok = false;
        }
        this.terrainOk[i] = ok ? 1 : 0;
        // Steeper ground and wet sand are more tiring; humans prefer gentle routes.
        this.cost[i] = cost;
      }
    }
    // Keep a one-cell margin from lake water so agents don't wade along the shore.
    for (const p of terrain.ponds) {
      const r = Math.ceil(p.radius * 1.8);
      const pcx = this.cellX(p.x);
      const pcz = this.cellZ(p.z);
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const cx = pcx + dx;
          const cz = pcz + dz;
          if (!this.inside(cx, cz)) continue;
          const i = cz * this.size + cx;
          if (!this.terrainOk[i]) continue;
          const h = terrain.heightAt(this.toWorld(cx), this.toWorld(cz));
          if (h < p.level + 0.12) this.terrainOk[i] = 0;
        }
      }
    }
    // Label connected land so impossible trips (across the sea, onto cliffs) fail instantly.
    this.component = new Int32Array(n);
    const stack = new Int32Array(n);
    let label = 0;
    for (let i = 0; i < n; i++) {
      if (!this.terrainOk[i] || this.component[i]) continue;
      label++;
      let sp = 0;
      stack[sp++] = i;
      this.component[i] = label;
      while (sp > 0) {
        const c = stack[--sp]!;
        const cx = c % this.size;
        const cz = (c - cx) / this.size;
        for (let k = 0; k < 4; k++) {
          const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
          const nz = cz + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (nx < 0 || nz < 0 || nx >= this.size || nz >= this.size) continue;
          const j = nz * this.size + nx;
          if (!this.terrainOk[j] || this.component[j]) continue;
          this.component[j] = label;
          stack[sp++] = j;
        }
      }
    }
  }

  /** Whether two points are on the same connected land (ignoring temporary blockers). */
  connected(ax: number, az: number, bx: number, bz: number): boolean {
    const a = this.componentAt(ax, az);
    const b = this.componentAt(bx, bz);
    return a > 0 && a === b;
  }

  componentAt(x: number, z: number): number {
    const cx = this.cellX(x);
    const cz = this.cellZ(z);
    if (!this.inside(cx, cz)) return 0;
    return this.component[cz * this.size + cx]!;
  }

  inside(cx: number, cz: number): boolean {
    return cx >= 0 && cz >= 0 && cx < this.size && cz < this.size;
  }

  cellX(x: number): number {
    return Math.floor(x + WORLD_HALF);
  }

  cellZ(z: number): number {
    return Math.floor(z + WORLD_HALF);
  }

  /** World coordinate of a cell center. */
  toWorld(c: number): number {
    return c + 0.5 - WORLD_HALF;
  }

  index(cx: number, cz: number): number {
    return cz * this.size + cx;
  }

  walkableCell(cx: number, cz: number): boolean {
    if (!this.inside(cx, cz)) return false;
    const i = cz * this.size + cx;
    return this.terrainOk[i] === 1 && this.blockers[i] === 0;
  }

  walkable(x: number, z: number): boolean {
    return this.walkableCell(this.cellX(x), this.cellZ(z));
  }

  terrainWalkable(x: number, z: number): boolean {
    const cx = this.cellX(x);
    const cz = this.cellZ(z);
    return this.inside(cx, cz) && this.terrainOk[cz * this.size + cx] === 1;
  }

  private stamp(x: number, z: number, r: number, delta: number): void {
    const x0 = this.cellX(x - r);
    const x1 = this.cellX(x + r);
    const z0 = this.cellZ(z - r);
    const z1 = this.cellZ(z + r);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (!this.inside(cx, cz)) continue;
        // Cell overlaps circle if the closest point of the cell is within r.
        const wx = cx - WORLD_HALF;
        const wz = cz - WORLD_HALF;
        const px = Math.max(wx, Math.min(x, wx + 1));
        const pz = Math.max(wz, Math.min(z, wz + 1));
        if ((px - x) ** 2 + (pz - z) ** 2 > r * r) continue;
        const i = cz * this.size + cx;
        this.blockers[i] = Math.max(0, this.blockers[i]! + delta);
      }
    }
    this.version++;
  }

  addBlocker(x: number, z: number, r: number): void {
    this.stamp(x, z, r, 1);
  }

  removeBlocker(x: number, z: number, r: number): void {
    this.stamp(x, z, r, -1);
  }

  /** Nearest walkable cell center to (x, z) within maxR cells (spiral search). */
  nearestWalkable(x: number, z: number, maxR = 12): V2 | null {
    const cx0 = this.cellX(x);
    const cz0 = this.cellZ(z);
    if (this.walkableCell(cx0, cz0)) return { x: this.toWorld(cx0), z: this.toWorld(cz0) };
    let best: V2 | null = null;
    let bestD = Infinity;
    for (let r = 1; r <= maxR; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const cx = cx0 + dx;
          const cz = cz0 + dz;
          if (!this.walkableCell(cx, cz)) continue;
          const wx = this.toWorld(cx);
          const wz = this.toWorld(cz);
          const d = (wx - x) ** 2 + (wz - z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = { x: wx, z: wz };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Grid line-of-sight: every cell the segment passes through must be walkable. */
  lineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return this.walkable(ax, az);
    // Sample densely along the segment and at a small lateral offset for body width.
    const steps = Math.ceil(len / 0.25);
    const nx = (-dz / len) * 0.28;
    const nz = (dx / len) * 0.28;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = ax + dx * t;
      const z = az + dz * t;
      if (!this.walkable(x, z) || !this.walkable(x + nx, z + nz) || !this.walkable(x - nx, z - nz)) return false;
    }
    return true;
  }
}
