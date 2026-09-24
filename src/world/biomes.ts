/** Distinct regions of the world. Each has its own terrain, vegetation, resources and mood. */
export const Biome = {
  Ocean: 0,
  Coast: 1,
  Greenheart: 2,
  Elderwood: 3,
  Highlands: 4,
  CrystalWilds: 5,
  Ashen: 6,
  Isles: 7,
} as const;
export type BiomeId = (typeof Biome)[keyof typeof Biome];

export interface BiomeDef {
  id: BiomeId;
  /** Generic name used in descriptions ("the highlands"). */
  noun: string;
  /** Short flavour line for UI tooltips. */
  blurb: string;
  /** Terrain colours (sRGB hex): low/lush, high/dry, forest floor, rock. */
  grass: [number, number];
  forest: number;
  rock: [number, number];
  /** Why a civilization would care about this land. */
  value: string;
}

export const BIOMES: Record<BiomeId, BiomeDef> = {
  [Biome.Ocean]: { id: Biome.Ocean, noun: 'sea', blurb: 'Open water.', grass: [0x9bcf5a, 0x74b147], forest: 0x3f7a33, rock: [0x77726b, 0xb8b2a6], value: '' },
  [Biome.Coast]: {
    id: Biome.Coast,
    noun: 'coast',
    blurb: 'Warm beaches and windswept dunes.',
    grass: [0xa9cf62, 0x86b84c],
    forest: 0x4f8a3a,
    rock: [0x8a8479, 0xc2baa8],
    value: 'Palms and open sky',
  },
  [Biome.Greenheart]: {
    id: Biome.Greenheart,
    noun: 'valley',
    blurb: 'Fertile river meadows, wildflowers and old oaks. The gentlest land in the world.',
    grass: [0x9fd35c, 0x6fb046],
    forest: 0x3f7a33,
    rock: [0x8f8a80, 0xbab4a8],
    value: 'Rich soil, fruit and fresh water',
  },
  [Biome.Elderwood]: {
    id: Biome.Elderwood,
    noun: 'forest',
    blurb: 'An ancient forest of giant trees and hidden ruins. The air hums with something old.',
    grass: [0x6ea447, 0x4f8a3c],
    forest: 0x33632c,
    rock: [0x6f7466, 0x9aa290],
    value: 'Endless timber, mushrooms and forgotten things',
  },
  [Biome.Highlands]: {
    id: Biome.Highlands,
    noun: 'highlands',
    blurb: 'Stony ridges, pine slopes and cold clear tarns under the peaks.',
    grass: [0x9bb866, 0x7d9c55],
    forest: 0x3d6b44,
    rock: [0x7c7a78, 0xc9c5bd],
    value: 'Stone, pine and far views',
  },
  [Biome.CrystalWilds]: {
    id: Biome.CrystalWilds,
    noun: 'wilds',
    blurb: 'A strange plateau where crystals grow from the stone and rocks drift in the air.',
    grass: [0x8fc9a0, 0x6fa98f],
    forest: 0x4a7f72,
    rock: [0x7d7890, 0xc0bad4],
    value: 'Crystal, and wonders nobody understands',
  },
  [Biome.Ashen]: {
    id: Biome.Ashen,
    noun: 'ashlands',
    blurb: 'Old volcanic land of black rock and warm springs. Harsh, but rich in stone.',
    grass: [0x8f9a5a, 0x6f7648],
    forest: 0x4c5a38,
    rock: [0x3f3a3a, 0x6e6560],
    value: 'Stone and warm water, little food',
  },
  [Biome.Isles]: {
    id: Biome.Isles,
    noun: 'isles',
    blurb: 'Small green islands off the coast.',
    grass: [0xa6d160, 0x80bb4e],
    forest: 0x4a8a3a,
    rock: [0x8a8479, 0xc2baa8],
    value: 'Solitude',
  },
};

export interface Region {
  id: number;
  biome: BiomeId;
  name: string;
  x: number;
  z: number;
  radius: number;
}

export interface River {
  id: number;
  name: string;
  /** Centre line from source to mouth with the water surface height and channel half-width. */
  points: Array<{ x: number; z: number; level: number; width: number }>;
}

export type LandmarkKind =
  | 'greatTree'
  | 'stoneCircle'
  | 'ruinedTower'
  | 'temple'
  | 'floatingRocks'
  | 'crystalSpire'
  | 'titanBones'
  | 'spring'
  | 'volcano'
  | 'statue';

export interface Landmark {
  id: number;
  kind: LandmarkKind;
  name: string;
  x: number;
  z: number;
  rot: number;
  /** Footprint radius that blocks navigation (0 = walk-through). */
  block: number;
  /** How far away people notice it. */
  sight: number;
  region: number;
}

export const LANDMARK_INFO: Record<LandmarkKind, { title: string; lore: string; effect: string }> = {
  greatTree: { title: 'Great Tree', lore: 'A tree older than memory, wide as a house at the root.', effect: 'Visitors feel awe; the people who know it call it sacred.' },
  stoneCircle: { title: 'Stone Circle', lore: 'Standing stones raised by hands long gone.', effect: 'Praying here strengthens faith.' },
  ruinedTower: { title: 'Ruined Tower', lore: 'A broken watchtower of fitted stone, still taller than any tree.', effect: 'A lookout: explorers who climb it see far across the land.' },
  temple: { title: 'Forgotten Temple', lore: 'Mossy columns around an empty altar deep in the forest.', effect: 'Those who find it feel watched, and start to believe.' },
  floatingRocks: { title: 'Drifting Stones', lore: 'Boulders that hang in the air, turning slowly, rooted to nothing.', effect: 'A wonder. Seeing it inspires awe and faith.' },
  crystalSpire: { title: 'Crystal Spire', lore: 'A spire of living crystal that glows faintly at night.', effect: 'Crystal gathered nearby regrows.' },
  titanBones: { title: "Titan's Bones", lore: 'The ribs of something enormous, half-buried in black ash.', effect: 'Frightening. Bold people come back braver.' },
  spring: { title: 'Moonwell', lore: 'A clear pool that glimmers even on moonless nights.', effect: 'Its water heals wounds.' },
  volcano: { title: 'Fire Mountain', lore: 'A sleeping volcano. The ground is warm for miles around.', effect: 'Warm ground, hard rock, and rumblings now and then.' },
  statue: { title: 'Watcher Statue', lore: 'A giant stone figure staring out to sea.', effect: 'Who carved it, and what were they waiting for?' },
};
