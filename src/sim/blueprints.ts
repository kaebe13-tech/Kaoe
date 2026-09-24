import type { Inventory, StructureKind } from './types';

export interface Blueprint {
  kind: StructureKind;
  name: string;
  cost: Partial<Inventory>;
  /** Seconds of work for one builder. */
  work: number;
  /** Clearance radius needed to place it. */
  radius: number;
  /** Radius blocking navigation once placed. */
  blockRadius: number;
  /** Residents (huts). */
  capacity: number;
  /** Item storage capacity. */
  storage: number;
  description: string;
}

export const BLUEPRINTS: Record<StructureKind, Blueprint> = {
  campfire: {
    kind: 'campfire',
    name: 'Campfire',
    cost: { wood: 5 },
    work: 14,
    radius: 1.6,
    blockRadius: 0.7,
    capacity: 0,
    storage: 16,
    description: 'Warmth and light after dark. The heart of the camp.',
  },
  hut: {
    kind: 'hut',
    name: 'Hut',
    cost: { wood: 14 },
    work: 55,
    radius: 2.6,
    blockRadius: 1.8,
    capacity: 2,
    storage: 0,
    description: 'A thatched shelter for two. Better sleep, dry in the rain.',
  },
  storage: {
    kind: 'storage',
    name: 'Storehouse',
    cost: { wood: 10 },
    work: 32,
    radius: 2.0,
    blockRadius: 1.3,
    capacity: 0,
    storage: 60,
    description: 'A raised granary keeping food and wood for the whole tribe.',
  },
  garden: {
    kind: 'garden',
    name: 'Berry garden',
    cost: { wood: 5, berries: 6 },
    work: 30,
    radius: 3.0,
    blockRadius: 0,
    capacity: 0,
    storage: 0,
    description: 'A fenced plot of tended berry bushes close to home.',
  },
  grave: {
    kind: 'grave',
    name: 'Grave',
    cost: {},
    work: 0,
    radius: 0.9,
    blockRadius: 0,
    capacity: 0,
    storage: 0,
    description: 'Here lies a member of the tribe.',
  },
};
