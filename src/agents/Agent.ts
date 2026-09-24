import type { Rng } from '../core/rng';
import { emptyInventory, type Inventory } from '../sim/types';
import { Memory } from './Memory';
import { TRAITS, TRAIT_IDS, type TraitId } from './traits';
import type { V2 } from '../core/math';
import { newBrain, type BrainState } from '../ai/brainCore';
import { CULTURES, type CultureId } from '../civ/cultures';
import type { PersonaTrait } from '../civ/persona';

export interface Needs {
  hunger: number;
  thirst: number;
  energy: number;
  health: number;
  safety: number;
  social: number;
}
export type NeedKey = keyof Needs;

export interface Appearance {
  skin: number;
  hair: number;
  /** 0 short, 1 long, 2 bun, 3 ponytail, 4 braids, 5 shaved, 6 curly. */
  hairStyle: number;
  shirt: number;
  pants: number;
  /** Trim / belt / accent colour. */
  trim: number;
  /** 0 tunic, 1 robe, 2 wrap, 3 vest. */
  garment: number;
  /** 0 none, 1 hood, 2 band, 3 cap, 4 feather, 5 straw hat, 6 circlet. */
  headwear: number;
  /** 0 none, 1 satchel, 2 scarf, 3 necklace. */
  accessory: number;
  beard: boolean;
  /** Face variant (brows/eyes). */
  face: number;
  height: number;
  build: number;
}

export const GARMENTS = ['tunic', 'robe', 'wrap', 'vest'] as const;
export const HEADWEAR = ['none', 'hood', 'band', 'cap', 'feather', 'strawhat', 'circlet'] as const;

export type AnimState =
  | 'idle'
  | 'walk'
  | 'run'
  | 'gather'
  | 'chop'
  | 'eat'
  | 'drink'
  | 'sleep'
  | 'build'
  | 'sit'
  | 'talk'
  | 'sitTalk'
  | 'cower'
  | 'dead'
  | 'celebrate'
  | 'knocked'
  | 'tend'
  | 'pray'
  | 'look'
  | 'catchRain'
  | 'play'
  | 'stargaze'
  | 'carry'
  | 'mine'
  | 'wade'
  | 'wave'
  | 'threaten'
  | 'hidden';

export type NavStatus = 'idle' | 'pending' | 'moving' | 'arrived' | 'failed';

export interface NavState {
  status: NavStatus;
  path: V2[];
  idx: number;
  dest: V2 | null;
  arrive: number;
  run: boolean;
  /** Seconds without progress toward the current waypoint. */
  stuck: number;
  bestDist: number;
  repaths: number;
  failReason: string;
  /** Total distance travelled on this leg (for anim + stats). */
  travelled: number;
  requestedAt: number;
}

export type LogKind = 'decide' | 'done' | 'fail' | 'switch' | 'event' | 'learn';

export interface DecisionEntry {
  time: number;
  kind: LogKind;
  text: string;
}

export interface AgentStats {
  foodEaten: number;
  woodChopped: number;
  workDone: number;
  conversations: number;
  helped: number;
  discoveries: number;
  distance: number;
}

export const ADULT_AGE = 15;

const SKINS = [0xf6d2b0, 0xeec19a, 0xdca47a, 0xc68a5e, 0xa46a44, 0x7f4f33, 0x5f3a25];
const HAIRS = [0x2b1d14, 0x3d2a1c, 0x5b3b24, 0x8a5a2b, 0xc98d3e, 0xe0c07a, 0xa3402a, 0x1a1a1a, 0x9a9a9a];
const SHIRTS = [0xc0583a, 0x3c6e9f, 0xd9a441, 0x6c8e3f, 0x8e5aa8, 0xe07a5f, 0x3f8f86, 0xb84a6b, 0xe8d6b0, 0x5a7bd0];
const PANTS = [0x5a4632, 0x3f4a5a, 0x6b5a3a, 0x4a3a4a, 0x7a6a50, 0x35524a];

export class Agent {
  readonly id: number;
  name: string;
  traits: TraitId[];
  look: Appearance;
  /** Age in years. Children (under ADULT_AGE) don't work and grow a few years per day. */
  age: number;
  /** 0..1 belief that someone watches over the island; grows when miracles are witnessed. */
  faith = 0;
  /** Ids of the parents for children born in the world. */
  parents: number[] = [];
  bornAt = 0;
  /** Civilization and settlement this person belongs to. */
  civId = -1;
  settlementId = -1;
  /** Leader-level personality (matters most if they come to lead). */
  persona: PersonaTrait[] = [];
  /** Things seen far from home, to tell the others about on return. */
  news: Array<{ kind: 'landmark' | 'region' | 'prospect'; id: number; at?: V2; score?: number; note?: string }> = [];
  /** Landmarks this person has seen with their own eyes. */
  seenLandmarks = new Set<number>();
  /** Divine blessing/curse/protection (world time it wears off). */
  blessedUntil = 0;
  cursedUntil = 0;
  protectedUntil = 0;

  x: number;
  z: number;
  heading: number;
  prevX: number;
  prevZ: number;
  prevHeading: number;
  /** Current ground speed (units/s), used by animation. */
  speed = 0;
  walkPhase = 0;

  needs: Needs = { hunger: 0.85, thirst: 0.8, energy: 0.9, health: 1, safety: 1, social: 0.7 };
  inventory: Inventory = emptyInventory();
  memory = new Memory();
  homeId: number | null = null;

  alive = true;
  deathCause = '';
  diedAt = 0;
  /** Laid to rest in a grave (no longer rendered). */
  buried = false;
  /** Inside a hut (hidden from view). */
  inside: number | null = null;
  /** Seconds remaining of being knocked down (lightning etc). */
  knocked = 0;
  /** Exhausted: fell asleep where they stood. */
  collapsed = false;

  anim: AnimState = 'idle';
  animTime = 0;
  /** Point the agent is looking at while working (for facing). */
  focus: V2 | null = null;

  nav: NavState = {
    status: 'idle',
    path: [],
    idx: 0,
    dest: null,
    arrive: 0.5,
    run: false,
    stuck: 0,
    bestDist: Infinity,
    repaths: 0,
    failReason: '',
    travelled: 0,
    requestedAt: 0,
  };

  /** Affinity toward other agents (0..1). */
  relations = new Map<number, number>();
  stats: AgentStats = { foodEaten: 0, woodChopped: 0, workDone: 0, conversations: 0, helped: 0, discoveries: 0, distance: 0 };
  log: DecisionEntry[] = [];
  /** Short first-person line describing what they're thinking right now. */
  thought = '';
  /** Transient emote icon shown above the head (e.g. '!' when startled). */
  emote: { icon: string; until: number } | null = null;
  brain: BrainState = newBrain();

  constructor(id: number, name: string, x: number, z: number, traits: TraitId[], look: Appearance, age: number) {
    this.id = id;
    this.name = name;
    this.x = this.prevX = x;
    this.z = this.prevZ = z;
    this.heading = this.prevHeading = 0;
    this.traits = traits;
    this.look = look;
    this.age = age;
  }

  get isChild(): boolean {
    return this.age < ADULT_AGE;
  }

  has(t: TraitId): boolean {
    return this.traits.includes(t);
  }

  setAnim(anim: AnimState): void {
    if (this.anim !== anim) {
      this.anim = anim;
      this.animTime = 0;
    }
  }

  affinity(otherId: number): number {
    return this.relations.get(otherId) ?? 0.3;
  }

  bond(otherId: number, delta: number): void {
    const v = Math.min(1, Math.max(0, this.affinity(otherId) + delta));
    this.relations.set(otherId, v);
  }

  addLog(time: number, kind: LogKind, text: string): void {
    const last = this.log[this.log.length - 1];
    if (last && last.text === text && time - last.time < 30) return;
    this.log.push({ time, kind, text });
    if (this.log.length > 40) this.log.shift();
  }

  get awake(): boolean {
    return this.alive && this.anim !== 'sleep' && this.knocked <= 0 && !this.collapsed;
  }
}

export function randomTraits(rng: Rng): TraitId[] {
  const out: TraitId[] = [];
  const pool = [...TRAIT_IDS];
  rng.shuffle(pool);
  for (const t of pool) {
    if (out.length >= 2) break;
    if (out.some((o) => TRAITS[o].conflicts?.includes(t) || TRAITS[t].conflicts?.includes(o))) continue;
    out.push(t);
  }
  return out;
}

export function randomAppearance(rng: Rng, culture?: CultureId): Appearance {
  const c = culture ? CULTURES[culture] : null;
  const garments = c ? c.garments : (['tunic', 'robe', 'wrap', 'vest'] as const);
  const heads = c ? c.headwear : (['none'] as const);
  const garment = GARMENTS.indexOf(rng.pick(garments));
  const headwear = HEADWEAR.indexOf(rng.pick(heads));
  const long = rng.chance(0.5);
  return {
    skin: rng.pick(c ? c.skin : SKINS),
    hair: rng.chance(0.85) && c ? rng.pick(c.hair) : rng.pick(HAIRS),
    hairStyle: long ? rng.pick([1, 2, 3, 4, 6]) : rng.pick([0, 0, 5, 6]),
    shirt: rng.pick(c ? c.cloth : SHIRTS),
    pants: rng.pick(PANTS),
    trim: rng.pick(c ? c.trim : [0x6b4a2a, 0xf1e3c2]),
    garment: garment < 0 ? 0 : garment,
    headwear: headwear < 0 ? 0 : headwear,
    accessory: rng.chance(0.55) ? rng.int(1, 3) : 0,
    beard: !long && rng.chance(0.3),
    face: rng.int(0, 3),
    height: rng.range(0.92, 1.08),
    build: rng.range(0.9, 1.12),
  };
}
