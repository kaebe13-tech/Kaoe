import type { V2 } from '../core/math';

export type ItemType = 'berries' | 'fruit' | 'wood';
export const ITEM_TYPES: readonly ItemType[] = ['berries', 'fruit', 'wood'];
export const FOOD_ITEMS: readonly ItemType[] = ['fruit', 'berries'];

export interface ItemDef {
  label: string;
  plural: string;
  /** Carry weight; agents can carry CARRY_CAPACITY weight units. */
  weight: number;
  /** Satiety restored per item (0 = not edible). */
  food: number;
}

export const ITEMS: Record<ItemType, ItemDef> = {
  berries: { label: 'berry', plural: 'berries', weight: 0.25, food: 0.1 },
  fruit: { label: 'fruit', plural: 'fruit', weight: 0.5, food: 0.22 },
  wood: { label: 'log', plural: 'logs', weight: 1, food: 0 },
};

export const CARRY_CAPACITY = 6;

export type Inventory = Record<ItemType, number>;

export function emptyInventory(): Inventory {
  return { berries: 0, fruit: 0, wood: 0 };
}

export function inventoryWeight(inv: Inventory): number {
  let w = 0;
  for (const k of ITEM_TYPES) w += inv[k] * ITEMS[k].weight;
  return w;
}

export function foodCount(inv: Inventory): number {
  return inv.berries + inv.fruit;
}

export function describeItems(inv: Partial<Inventory>): string {
  const parts: string[] = [];
  for (const k of ITEM_TYPES) {
    const n = inv[k] ?? 0;
    if (n > 0) parts.push(`${n} ${n === 1 ? ITEMS[k].label : ITEMS[k].plural}`);
  }
  return parts.length ? parts.join(', ') : 'nothing';
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export type ResourceKind = 'tree' | 'berryBush' | 'fruitTree' | 'rock';

/** Visual/behavioural variants of trees. */
export const TreeVariant = { Broadleaf: 0, Pine: 1, Palm: 2 } as const;

export type ResourceState = 'grown' | 'stump' | 'sapling' | 'burnt';

export interface ResourceNode {
  id: number;
  kind: ResourceKind;
  variant: number;
  x: number;
  z: number;
  rot: number;
  scale: number;
  /** Radius that blocks navigation (trunk / boulder). 0 = walk-through. */
  blockRadius: number;
  amount: number;
  max: number;
  /** Accumulates toward the next regrown unit / growth stage. */
  regrow: number;
  state: ResourceState;
  /** 0..1 growth for saplings; 1 when grown. */
  growth: number;
  /** Seconds of burning left (0 = not burning). */
  burning: number;
  /** Agents currently heading here (soft reservation). */
  claims: number;
  /** Spawned by a god power. */
  blessed: boolean;
  /** Time the resource was last touched by an agent (for feedback effects). */
  lastUse: number;
}

export function resourceLabel(r: ResourceNode): string {
  switch (r.kind) {
    case 'tree':
      if (r.state === 'stump') return 'Tree stump';
      if (r.state === 'sapling') return 'Sapling';
      if (r.state === 'burnt') return 'Burnt tree';
      return r.variant === TreeVariant.Pine ? 'Pine tree' : r.variant === TreeVariant.Palm ? 'Palm tree' : 'Oak tree';
    case 'berryBush':
      return r.blessed ? 'Blessed berry bush' : 'Berry bush';
    case 'fruitTree':
      return r.blessed ? 'Blessed fruit tree' : 'Fruit tree';
    case 'rock':
      return 'Boulder';
  }
}

export function resourceYield(r: ResourceNode): ItemType | null {
  switch (r.kind) {
    case 'tree':
      return 'wood';
    case 'berryBush':
      return 'berries';
    case 'fruitTree':
      return 'fruit';
    default:
      return null;
  }
}

export function isHarvestable(r: ResourceNode): boolean {
  return r.state === 'grown' && r.amount > 0 && r.burning <= 0;
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

export type StructureKind = 'campfire' | 'hut' | 'storage' | 'garden' | 'grave';

export interface Structure {
  id: number;
  kind: StructureKind;
  x: number;
  z: number;
  rot: number;
  /** 0..1 construction work progress. 1 = complete. */
  progress: number;
  complete: boolean;
  delivered: Partial<Inventory>;
  /** Materials promised by agents currently hauling for this site. */
  incoming: Partial<Inventory>;
  stored: Inventory;
  residents: number[];
  /** Campfire fuel 0..1. */
  fuel: number;
  lit: boolean;
  /** Seconds of burning left. */
  burning: number;
  /** 0..1 damage from fire; 1 = destroyed. */
  damage: number;
  foundedBy: number;
  foundedAt: number;
  completedAt: number;
  builders: number[];
  /** Free-form label (e.g. name on a grave). */
  label: string;
}

// ---------------------------------------------------------------------------
// Misc world data
// ---------------------------------------------------------------------------

export interface DrinkSpot extends V2 {
  id: number;
  pondId: number;
}

export interface WaterBody {
  id: number;
  x: number;
  z: number;
  radius: number;
  level: number;
  spots: DrinkSpot[];
}

export interface DangerZone {
  id: number;
  x: number;
  z: number;
  radius: number;
  /** Seconds remaining. */
  ttl: number;
  kind: 'lightning' | 'fire';
}

export interface ScorchMark {
  id: number;
  x: number;
  z: number;
  radius: number;
  age: number;
}
