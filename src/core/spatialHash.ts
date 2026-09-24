/**
 * Uniform-grid spatial hash for point-like entities on the XZ plane.
 * Supports insert/remove/move and radius queries without allocation on the hot path.
 */
export interface SpatialItem {
  id: number;
  x: number;
  z: number;
}

export class SpatialHash<T extends SpatialItem> {
  private readonly cells = new Map<number, T[]>();
  private readonly where = new Map<number, number>();

  constructor(readonly cellSize: number) {}

  private key(cx: number, cz: number): number {
    // Pack two signed 16-bit cell coords into one int.
    return ((cx + 32768) << 16) | (cz + 32768);
  }

  private cellOf(x: number, z: number): number {
    return this.key(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize));
  }

  insert(item: T): void {
    const k = this.cellOf(item.x, item.z);
    let list = this.cells.get(k);
    if (!list) {
      list = [];
      this.cells.set(k, list);
    }
    list.push(item);
    this.where.set(item.id, k);
  }

  remove(item: T): void {
    const k = this.where.get(item.id);
    if (k === undefined) return;
    const list = this.cells.get(k);
    if (list) {
      const i = list.indexOf(item);
      if (i >= 0) {
        list[i] = list[list.length - 1]!;
        list.pop();
      }
      if (list.length === 0) this.cells.delete(k);
    }
    this.where.delete(item.id);
  }

  /** Call after changing item.x/z. Cheap when the item stays in its cell. */
  update(item: T): void {
    const k = this.cellOf(item.x, item.z);
    const old = this.where.get(item.id);
    if (old === k) return;
    if (old !== undefined) this.remove(item);
    this.insert(item);
  }

  has(item: T): boolean {
    return this.where.has(item.id);
  }

  clear(): void {
    this.cells.clear();
    this.where.clear();
  }

  /** Visit items within radius. Return true from the visitor to stop early. */
  query(x: number, z: number, radius: number, visit: (item: T, d2: number) => boolean | void): void {
    const cs = this.cellSize;
    const r2 = radius * radius;
    const x0 = Math.floor((x - radius) / cs);
    const x1 = Math.floor((x + radius) / cs);
    const z0 = Math.floor((z - radius) / cs);
    const z1 = Math.floor((z + radius) / cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this.cells.get(this.key(cx, cz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const it = list[i]!;
          const dx = it.x - x;
          const dz = it.z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 <= r2 && visit(it, d2) === true) return;
        }
      }
    }
  }

  /** Nearest item within maxRadius that passes the filter. */
  nearest(x: number, z: number, maxRadius: number, filter?: (item: T) => boolean): T | null {
    let best: T | null = null;
    let bestD2 = Infinity;
    this.query(x, z, maxRadius, (it, d2) => {
      if (d2 < bestD2 && (!filter || filter(it))) {
        best = it;
        bestD2 = d2;
      }
    });
    return best;
  }

  collect(x: number, z: number, radius: number, out: T[] = []): T[] {
    out.length = 0;
    this.query(x, z, radius, (it) => {
      out.push(it);
    });
    return out;
  }
}
