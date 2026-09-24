import type { Rng } from '../core/rng';
import { Biome, type BiomeId } from '../world/biomes';
import type { TraitId } from '../agents/traits';

export type CultureId = 'vale' | 'grove' | 'stone' | 'ember' | 'glass';

/** What a civilization cares about. Weights around 1 = ordinary; they scale goal utilities. */
export interface Priorities {
  build: number;
  expand: number;
  gather: number;
  explore: number;
  faith: number;
  social: number;
  defend: number;
}

export type RoofStyle = 'thatch' | 'moss' | 'slate' | 'hide' | 'glass';
export type Garment = 'tunic' | 'robe' | 'wrap' | 'vest';
export type Headwear = 'none' | 'hood' | 'band' | 'cap' | 'feather' | 'strawhat' | 'circlet';

export interface CultureDef {
  id: CultureId;
  /** The people ("the Valefolk"). */
  people: string;
  /** Civilization names to choose from. */
  names: string[];
  homeBiome: BiomeId;
  /** One-line identity shown in the civ panel. */
  identity: string;
  /** Banner colour (UI, territory, markers) and a secondary accent. */
  banner: number;
  accent: number;
  priorities: Priorities;
  /** Villager traits this culture raises more often. */
  favoured: TraitId[];
  /** Clothing palette: body cloth, trims, and hair tones that are common here. */
  cloth: number[];
  trim: number[];
  hair: number[];
  skin: number[];
  garments: Garment[];
  headwear: Headwear[];
  /** Architecture. */
  roof: RoofStyle;
  roofColor: number;
  wallColor: number;
  woodColor: number;
  /** Name syllables. */
  onset: string[];
  mid: string[];
  coda: string[];
  /** How they speak of the watcher above, before they have a name for it. */
  godName: string;
}

export const CULTURES: Record<CultureId, CultureDef> = {
  vale: {
    id: 'vale',
    people: 'Valefolk',
    names: ['the Hearthkin', 'the Vale Clans', 'the Meadowkin'],
    homeBiome: Biome.Greenheart,
    identity: 'Farmers and builders of the river meadows. Patient, warm, proud of their homes.',
    banner: 0xe8b04a,
    accent: 0x6f9a3c,
    priorities: { build: 1.25, expand: 0.9, gather: 1.15, explore: 0.8, faith: 1, social: 1.15, defend: 0.8 },
    favoured: ['industrious', 'sociable', 'kind'],
    cloth: [0xd9a441, 0xb86b3a, 0x8aa44e, 0xe8d6b0, 0xc9803e],
    trim: [0x6b4a2a, 0x8a5a2b, 0xf1e3c2],
    hair: [0x3d2a1c, 0x5b3b24, 0x8a5a2b, 0xc98d3e, 0xe0c07a],
    skin: [0xf6d2b0, 0xeec19a, 0xdca47a, 0xc68a5e],
    garments: ['tunic', 'tunic', 'vest', 'robe'],
    headwear: ['none', 'none', 'strawhat', 'band'],
    roof: 'thatch',
    roofColor: 0xd8b25e,
    wallColor: 0xe9dcc0,
    woodColor: 0x8a5a34,
    onset: ['Ma', 'Te', 'Ro', 'Li', 'Be', 'Wi', 'Ha', 'Ce', 'Do', 'Fa', 'Mi', 'Pe'],
    mid: ['la', 'ri', 'ren', 'wy', 'lo', 'ma', 'bel', 'dri'],
    coda: ['', 'n', 'a', 'el', 'is', 'y', 'ra', 'on'],
    godName: 'the Sky Keeper',
  },
  grove: {
    id: 'grove',
    people: 'Mossborn',
    names: ['the Mossborn', 'the Rootkin', 'the Children of the Elder'],
    homeBiome: Biome.Elderwood,
    identity: 'Quiet gatherers of the old forest. Cautious, spiritual, slow to trust outsiders.',
    banner: 0x5fae7a,
    accent: 0x3b5d34,
    priorities: { build: 0.85, expand: 0.7, gather: 1.3, explore: 0.9, faith: 1.35, social: 1, defend: 0.9 },
    favoured: ['kind', 'timid', 'curious'],
    cloth: [0x4f7a3a, 0x6b8f4e, 0x7a5a3a, 0x8f9a6a, 0x5b6b4a],
    trim: [0x3a2a1c, 0xb5a07a, 0x6b4a2a],
    hair: [0x2b1d14, 0x3d2a1c, 0x5b3b24, 0x6f4a2e, 0x1a1a1a],
    skin: [0xeec19a, 0xdca47a, 0xc68a5e, 0xa46a44],
    garments: ['wrap', 'robe', 'tunic'],
    headwear: ['hood', 'hood', 'none', 'circlet'],
    roof: 'moss',
    roofColor: 0x5e7f3d,
    wallColor: 0x7a5a3a,
    woodColor: 0x5a3b24,
    onset: ['Ae', 'Fa', 'Syl', 'Or', 'Ny', 'El', 'Thi', 'Qui', 'Ro', 'Ve', 'Il'],
    mid: ['la', 'wen', 'ri', 'ae', 'lo', 'thi', 'mi', 'nel'],
    coda: ['', 'n', 'wen', 'is', 'el', 'a', 'ith'],
    godName: 'the Green Watcher',
  },
  stone: {
    id: 'stone',
    people: 'Cairnfolk',
    names: ['the Cairnfolk', 'the Highborn', 'the Greystone Clans'],
    homeBiome: Biome.Highlands,
    identity: 'Stubborn stoneworkers of the high valleys. Hardy, guarded, fiercely loyal.',
    banner: 0x7fa0c8,
    accent: 0x44546a,
    priorities: { build: 1.2, expand: 0.85, gather: 1, explore: 1, faith: 0.85, social: 0.9, defend: 1.35 },
    favoured: ['brave', 'industrious'],
    cloth: [0x5a7090, 0x6f7a86, 0x8a6f5a, 0x3f5a6b, 0x9a8a78],
    trim: [0xdcd4c4, 0x3a3030, 0x8a3a2a],
    hair: [0x5b3b24, 0xa3402a, 0xc98d3e, 0x3d2a1c, 0x9a9a9a],
    skin: [0xf6d2b0, 0xeec19a, 0xf0c8a8, 0xdca47a],
    garments: ['tunic', 'vest', 'tunic'],
    headwear: ['cap', 'none', 'cap', 'band'],
    roof: 'slate',
    roofColor: 0x5d6470,
    wallColor: 0xa9a49a,
    woodColor: 0x6a4a30,
    onset: ['Bra', 'Dun', 'Gor', 'Ka', 'Tor', 'Hal', 'Bor', 'Ey', 'Sig', 'Ul', 'Ker'],
    mid: ['a', 'ra', 'gar', 'dun', 'va', 'ri', 'ol'],
    coda: ['', 'n', 'd', 'k', 'ra', 'ek', 'a'],
    godName: 'the Mountain Father',
  },
  ember: {
    id: 'ember',
    people: 'Emberfolk',
    names: ['the Cinder Clans', 'the Emberfolk', 'the Ashborn'],
    homeBiome: Biome.Ashen,
    identity: 'Restless explorers from the black-rock coast. Bold, ambitious, quick to take offence.',
    banner: 0xd8543a,
    accent: 0x2e2626,
    priorities: { build: 1, expand: 1.4, gather: 0.95, explore: 1.35, faith: 0.8, social: 0.9, defend: 1.1 },
    favoured: ['brave', 'curious', 'glutton'],
    cloth: [0x8e2f24, 0x3a2e2e, 0xb5522e, 0x5a3a2e, 0xc4893a],
    trim: [0xd9a441, 0x1a1a1a, 0xb87333],
    hair: [0x1a1a1a, 0x2b1d14, 0xa3402a, 0x3d2a1c],
    skin: [0xc68a5e, 0xa46a44, 0x7f4f33, 0xdca47a, 0x5f3a25],
    garments: ['vest', 'wrap', 'tunic'],
    headwear: ['band', 'feather', 'none', 'band'],
    roof: 'hide',
    roofColor: 0xa8492f,
    wallColor: 0x4a3d38,
    woodColor: 0x3f2c22,
    onset: ['Za', 'Ke', 'Ra', 'Sha', 'Tu', 'Ar', 'Ish', 'Ko', 'Vu', 'Na', 'Da'],
    mid: ['ka', 'ra', 'zu', 'ri', 'sha', 'ko', 'ya'],
    coda: ['', 'r', 'n', 'ka', 'ri', 'sh', 'ya'],
    godName: 'the Burning Eye',
  },
  glass: {
    id: 'glass',
    people: 'Lumen',
    names: ['the Lumen', 'the Glasskin', 'the Starwatchers'],
    homeBiome: Biome.CrystalWilds,
    identity: 'Pale-robed mystics of the crystal plateau. Curious, strange, devoted to the sky.',
    banner: 0xa98fe0,
    accent: 0x6fd0d8,
    priorities: { build: 0.95, expand: 0.75, gather: 0.95, explore: 1.2, faith: 1.5, social: 1, defend: 0.8 },
    favoured: ['curious', 'kind'],
    cloth: [0xdcd8ee, 0xb8c8e8, 0x9a8ac0, 0xe8e2d0, 0x8fb8c8],
    trim: [0x6fd0d8, 0x5a4a8a, 0xf1e3c2],
    hair: [0xe0c07a, 0xf0e0c0, 0x9a9a9a, 0x2b1d14, 0xc98d3e],
    skin: [0xf6d2b0, 0xeec19a, 0xdca47a, 0xa46a44],
    garments: ['robe', 'robe', 'wrap'],
    headwear: ['circlet', 'hood', 'none'],
    roof: 'glass',
    roofColor: 0x8f7fc0,
    wallColor: 0xd8d4e4,
    woodColor: 0x9a8a78,
    onset: ['Li', 'Se', 'Ae', 'Ori', 'Ve', 'Ly', 'Ci', 'Io', 'Ela', 'Mi'],
    mid: ['ra', 'el', 'lu', 'si', 'vy', 'ne', 'ae'],
    coda: ['', 'l', 'a', 'e', 'n', 'is', 'ra'],
    godName: 'the Bright One',
  },
};

export const CULTURE_ORDER: CultureId[] = ['vale', 'grove', 'stone', 'ember', 'glass'];

export function cultureName(rng: Rng, c: CultureDef, taken: Set<string>): string {
  for (let i = 0; i < 80; i++) {
    const parts = [rng.pick(c.onset), rng.chance(0.45) ? rng.pick(c.mid) : '', rng.pick(c.coda)];
    let n = parts.join('');
    n = n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
    if (n.length >= 3 && n.length <= 8 && !taken.has(n)) return n;
  }
  return `${rng.pick(c.onset)}${taken.size}`;
}
