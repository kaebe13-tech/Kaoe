import type { V2 } from '../core/math';
import type { NavGrid } from './NavGrid';

const SQRT2 = Math.SQRT2;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

export interface PathStats {
  searches: number;
  expanded: number;
  failures: number;
}

/**
 * A* over the nav grid (8-connected, no corner cutting) with generation-stamped typed arrays
 * so searches allocate nothing, followed by line-of-sight string pulling.
 */
export class Pathfinder {
  private readonly g: Float32Array;
  private readonly f: Float32Array;
  private readonly parent: Int32Array;
  private readonly openGen: Uint32Array;
  private readonly closedGen: Uint32Array;
  private readonly heap: Int32Array;
  private heapSize = 0;
  private gen = 0;
  readonly stats: PathStats = { searches: 0, expanded: 0, failures: 0 };

  constructor(private readonly grid: NavGrid) {
    const n = grid.size * grid.size;
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.openGen = new Uint32Array(n);
    this.closedGen = new Uint32Array(n);
    this.heap = new Int32Array(n);
  }

  /** Returns world-space waypoints (excluding the start) or null if unreachable. */
  find(from: V2, to: V2, maxExpansions = 60000): V2[] | null {
    const grid = this.grid;
    this.stats.searches++;
    const start = grid.walkable(from.x, from.z) ? from : grid.nearestWalkable(from.x, from.z, 6);
    const goalExact = grid.walkable(to.x, to.z);
    const goal = goalExact ? to : grid.nearestWalkable(to.x, to.z, 6);
    if (!start || !goal) {
      this.stats.failures++;
      return null;
    }
    const size = grid.size;
    const sx = grid.cellX(start.x);
    const sz = grid.cellZ(start.z);
    const gx = grid.cellX(goal.x);
    const gz = grid.cellZ(goal.z);
    const sIdx = sz * size + sx;
    const gIdx = gz * size + gx;
    if (sIdx === gIdx) return [{ x: goal.x, z: goal.z }];

    this.gen++;
    if (this.gen >= 0xfffffff0) {
      this.openGen.fill(0);
      this.closedGen.fill(0);
      this.gen = 1;
    }
    const gen = this.gen;
    this.heapSize = 0;
    this.g[sIdx] = 0;
    this.f[sIdx] = this.h(sx, sz, gx, gz);
    this.parent[sIdx] = -1;
    this.openGen[sIdx] = gen;
    this.push(sIdx);

    let expanded = 0;
    let found = false;
    const cost = grid.cost;
    while (this.heapSize > 0) {
      const cur = this.pop();
      if (this.closedGen[cur] === gen) continue;
      this.closedGen[cur] = gen;
      if (cur === gIdx) {
        found = true;
        break;
      }
      if (++expanded > maxExpansions) break;
      const cx = cur % size;
      const cz = (cur - cx) / size;
      const gc = this.g[cur]!;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k]!;
        const nz = cz + DZ[k]!;
        if (!grid.walkableCell(nx, nz)) continue;
        const diag = k >= 4;
        if (diag && (!grid.walkableCell(cx + DX[k]!, cz) || !grid.walkableCell(cx, cz + DZ[k]!))) continue;
        const ni = nz * size + nx;
        if (this.closedGen[ni] === gen) continue;
        const step = (diag ? SQRT2 : 1) * (cost[cur]! + cost[ni]!) * 0.5;
        const ng = gc + step;
        if (this.openGen[ni] === gen && ng >= this.g[ni]!) continue;
        this.g[ni] = ng;
        this.f[ni] = ng + this.h(nx, nz, gx, gz);
        this.parent[ni] = cur;
        this.openGen[ni] = gen;
        this.push(ni);
      }
    }
    this.stats.expanded += expanded;
    if (!found) {
      this.stats.failures++;
      return null;
    }

    const cells: number[] = [];
    for (let c = gIdx; c !== -1; c = this.parent[c]!) cells.push(c);
    cells.reverse();
    const pts: V2[] = cells.map((c) => {
      const cx = c % size;
      return { x: grid.toWorld(cx), z: grid.toWorld((c - cx) / size) };
    });
    pts[0] = { x: start.x, z: start.z };
    pts[pts.length - 1] = { x: goal.x, z: goal.z };
    return this.smooth(pts).slice(1);
  }

  private h(ax: number, az: number, bx: number, bz: number): number {
    const dx = Math.abs(ax - bx);
    const dz = Math.abs(az - bz);
    return (dx + dz + (SQRT2 - 2) * Math.min(dx, dz)) * 1.001;
  }

  /** Greedy string pulling: skip waypoints while there is clear line of sight. */
  private smooth(pts: V2[]): V2[] {
    if (pts.length <= 2) return pts;
    const out: V2[] = [pts[0]!];
    let anchor = 0;
    while (anchor < pts.length - 1) {
      let next = anchor + 1;
      // Look ahead as far as visible (bounded so we don't cut across very long detours).
      for (let j = Math.min(pts.length - 1, anchor + 40); j > anchor + 1; j--) {
        if (this.grid.lineOfSight(pts[anchor]!.x, pts[anchor]!.z, pts[j]!.x, pts[j]!.z)) {
          next = j;
          break;
        }
      }
      out.push(pts[next]!);
      anchor = next;
    }
    return out;
  }

  private push(i: number): void {
    const heap = this.heap;
    const f = this.f;
    let n = this.heapSize++;
    heap[n] = i;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (f[heap[p]!]! <= f[i]!) break;
      heap[n] = heap[p]!;
      heap[p] = i;
      n = p;
    }
  }

  private pop(): number {
    const heap = this.heap;
    const f = this.f;
    const top = heap[0]!;
    const last = heap[--this.heapSize]!;
    if (this.heapSize > 0) {
      heap[0] = last;
      let n = 0;
      const size = this.heapSize;
      for (;;) {
        const l = n * 2 + 1;
        const r = l + 1;
        let m = n;
        if (l < size && f[heap[l]!]! < f[heap[m]!]!) m = l;
        if (r < size && f[heap[r]!]! < f[heap[m]!]!) m = r;
        if (m === n) break;
        const t = heap[m]!;
        heap[m] = heap[n]!;
        heap[n] = t;
        n = m;
      }
    }
    return top;
  }
}
