import type { ResourceKind } from '../sim/types';
import { ISLAND_RADIUS } from '../world/config';

export interface ResourceMemory {
  id: number;
  kind: ResourceKind;
  x: number;
  z: number;
  /** Amount when last seen. */
  amount: number;
  seenAt: number;
  /** Time until which this entry is ignored (unreachable, found empty...). */
  avoidUntil: number;
  /** How the knowledge was obtained, shown in the inspector. */
  source: 'seen' | 'told';
}

export interface WaterMemory {
  pondId: number;
  x: number;
  z: number;
  seenAt: number;
  avoidUntil: number;
}

export interface DangerMemory {
  x: number;
  z: number;
  at: number;
  kind: 'lightning' | 'fire' | 'death';
}

/** Coarse exploration grid: 10x10 unit cells covering the island. */
export const EXPLORE_CELL = 10;
export const EXPLORE_N = Math.ceil((ISLAND_RADIUS * 2.4) / EXPLORE_CELL);
export const EXPLORE_ORIGIN = -(EXPLORE_N * EXPLORE_CELL) / 2;

export class Memory {
  readonly resources = new Map<number, ResourceMemory>();
  readonly water = new Map<number, WaterMemory>();
  readonly dangers: DangerMemory[] = [];
  /** Time each coarse cell was last seen (0 = never). */
  readonly explored = new Float32Array(EXPLORE_N * EXPLORE_N);
  static readonly MAX_RESOURCES = 90;

  rememberResource(entry: Omit<ResourceMemory, 'avoidUntil'> & { avoidUntil?: number }): boolean {
    const prev = this.resources.get(entry.id);
    if (prev) {
      prev.amount = entry.amount;
      prev.seenAt = Math.max(prev.seenAt, entry.seenAt);
      prev.x = entry.x;
      prev.z = entry.z;
      if (entry.source === 'seen') prev.source = 'seen';
      return false;
    }
    if (this.resources.size >= Memory.MAX_RESOURCES) this.forgetOne();
    this.resources.set(entry.id, { avoidUntil: 0, ...entry });
    return true;
  }

  /** Forget the least useful memory: trees are plentiful, food is precious. */
  private forgetOne(): void {
    let worst: ResourceMemory | null = null;
    let worstScore = Infinity;
    for (const m of this.resources.values()) {
      const value = (m.kind === 'tree' ? 0.4 : m.kind === 'rock' ? 0.1 : 1) * (1 + m.amount * 0.2);
      const score = value * 1e6 + m.seenAt;
      if (score < worstScore) {
        worstScore = score;
        worst = m;
      }
    }
    if (worst) this.resources.delete(worst.id);
  }

  exploreIndex(x: number, z: number): number {
    const cx = Math.floor((x - EXPLORE_ORIGIN) / EXPLORE_CELL);
    const cz = Math.floor((z - EXPLORE_ORIGIN) / EXPLORE_CELL);
    if (cx < 0 || cz < 0 || cx >= EXPLORE_N || cz >= EXPLORE_N) return -1;
    return cz * EXPLORE_N + cx;
  }

  markExplored(x: number, z: number, radius: number, time: number): number {
    let fresh = 0;
    const r = Math.ceil(radius / EXPLORE_CELL);
    const cx0 = Math.floor((x - EXPLORE_ORIGIN) / EXPLORE_CELL);
    const cz0 = Math.floor((z - EXPLORE_ORIGIN) / EXPLORE_CELL);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = cx0 + dx;
        const cz = cz0 + dz;
        if (cx < 0 || cz < 0 || cx >= EXPLORE_N || cz >= EXPLORE_N) continue;
        const wx = EXPLORE_ORIGIN + (cx + 0.5) * EXPLORE_CELL;
        const wz = EXPLORE_ORIGIN + (cz + 0.5) * EXPLORE_CELL;
        if ((wx - x) ** 2 + (wz - z) ** 2 > (radius + 4) ** 2) continue;
        const i = cz * EXPLORE_N + cx;
        if (this.explored[i] === 0) fresh++;
        this.explored[i] = Math.max(time, 1e-3);
      }
    }
    return fresh;
  }

  addDanger(d: DangerMemory): void {
    this.dangers.push(d);
    if (this.dangers.length > 8) this.dangers.shift();
  }

  knownFoodCount(): number {
    let n = 0;
    for (const m of this.resources.values()) if (m.kind === 'berryBush' || m.kind === 'fruitTree') n++;
    return n;
  }
}
