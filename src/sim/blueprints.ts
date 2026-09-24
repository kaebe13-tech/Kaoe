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
  /** Residents (homes). */
  capacity: number;
  /** Item storage capacity. */
  storage: number;
  /** Contribution to a settlement's development score. */
  value: number;
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
    value: 2,
    description: 'Warmth and light after dark. The heart of the camp.',
  },
  tent: {
    kind: 'tent',
    name: 'Tent',
    cost: { wood: 4 },
    work: 18,
    radius: 1.9,
    blockRadius: 1.2,
    capacity: 2,
    storage: 0,
    value: 1,
    description: 'Hides stretched over poles. Keeps two people out of the rain.',
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
    value: 4,
    description: 'A timber shelter for two. Better sleep, dry in the rain.',
  },
  house: {
    kind: 'house',
    name: 'House',
    cost: { wood: 16, stone: 10 },
    work: 95,
    radius: 3.2,
    blockRadius: 2.4,
    capacity: 4,
    storage: 8,
    value: 9,
    description: 'A proper family house with stone footings and a chimney.',
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
    value: 4,
    description: 'A raised granary keeping food and materials for everyone.',
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
    value: 3,
    description: 'A fenced plot of tended berry bushes close to home.',
  },
  shrine: {
    kind: 'shrine',
    name: 'Shrine',
    cost: { wood: 6 },
    work: 30,
    radius: 1.8,
    blockRadius: 0.8,
    capacity: 0,
    storage: 0,
    value: 3,
    description: 'A carved totem honouring whoever watches from above.',
  },
  workshop: {
    kind: 'workshop',
    name: 'Workshop',
    cost: { wood: 12, stone: 6 },
    work: 60,
    radius: 2.6,
    blockRadius: 1.7,
    capacity: 0,
    storage: 10,
    value: 6,
    description: 'Tools, a workbench and a kiln. Everyone builds and gathers faster.',
  },
  hall: {
    kind: 'hall',
    name: 'Longhall',
    cost: { wood: 24, stone: 12 },
    work: 130,
    radius: 4.2,
    blockRadius: 3.1,
    capacity: 0,
    storage: 20,
    value: 14,
    description: 'The great hall where the people meet, feast and hear their leader.',
  },
  well: {
    kind: 'well',
    name: 'Well',
    cost: { stone: 8, wood: 2 },
    work: 40,
    radius: 1.4,
    blockRadius: 0.8,
    capacity: 0,
    storage: 0,
    value: 4,
    description: 'Fresh water in the middle of the village.',
  },
  tower: {
    kind: 'tower',
    name: 'Watchtower',
    cost: { wood: 12, stone: 8 },
    work: 70,
    radius: 1.8,
    blockRadius: 1.2,
    capacity: 0,
    storage: 0,
    value: 5,
    description: 'A lookout over the land. Makes the people feel safe.',
  },
  monument: {
    kind: 'monument',
    name: 'Sky Altar',
    cost: { stone: 14, crystal: 4 },
    work: 110,
    radius: 2.4,
    blockRadius: 1.4,
    capacity: 0,
    storage: 0,
    value: 12,
    description: 'A great altar raised to the watcher above, set with glowing crystal.',
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
    value: 0,
    description: 'Here lies one of the people.',
  },
};
