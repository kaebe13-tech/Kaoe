import type { V2 } from '../core/math';
import type { Agent } from '../agents/Agent';
import { DAY_LENGTH, HOUR, MAP_N } from '../world/config';
import { CULTURES, type CultureDef, type CultureId, type Priorities } from './cultures';
import { PERSONAS, type PersonaTrait } from './persona';

export const CIV_SPEEDS = [0, 0.25, 0.5, 1, 2, 4, 8] as const;
export type CivSpeed = (typeof CIV_SPEEDS)[number];

export type RelationState = 'unknown' | 'friendly' | 'neutral' | 'tense' | 'hostile';

export interface Relation {
  civId: number;
  state: RelationState;
  /** -1 (hatred) .. 1 (friendship). State follows opinion with some hysteresis. */
  opinion: number;
  metAt: number;
  lastContact: number;
  /** Rolling count of notable incidents (for the UI). */
  gifts: number;
  quarrels: number;
  /** Divine peace or other forced calm until this world time. */
  truceUntil: number;
}

/** How a people feel about the watcher in the sky. All 0..1. */
export interface Reputation {
  faith: number;
  fear: number;
  trust: number;
  anger: number;
  awe: number;
}

export type DivineKind =
  | 'lightning'
  | 'rain'
  | 'storm'
  | 'food'
  | 'forest'
  | 'heal'
  | 'bless'
  | 'curse'
  | 'meteor'
  | 'quake'
  | 'fire'
  | 'wind'
  | 'fog'
  | 'drought'
  | 'clear'
  | 'resurrect'
  | 'spring'
  | 'fertile'
  | 'harvest'
  | 'sanctuary'
  | 'revelation'
  | 'knowledge'
  | 'inspire'
  | 'peace'
  | 'wrath'
  | 'manifest'
  | 'teleport'
  | 'timeFreeze'
  | 'timeRush'
  | 'answered'
  | 'ignored'
  | 'refused'
  | 'spoke'
  | 'landmark'
  | 'deposit'
  | 'raise'
  | 'animal';

export interface DivineMemory {
  time: number;
  kind: DivineKind;
  text: string;
  /** -1 harmful .. +1 helpful, as they experienced it. */
  valence: number;
}

export interface HistoryEntry {
  /** World time. */
  time: number;
  /** Civ-local day number when it happened (their own calendar). */
  day: number;
  text: string;
  kind: 'founding' | 'discovery' | 'contact' | 'divine' | 'disaster' | 'leader' | 'building' | 'growth' | 'relation' | 'death' | 'objective';
  importance: 1 | 2 | 3;
}

export type ObjectiveKind =
  | 'EXPAND'
  | 'ESTABLISH_SETTLEMENT'
  | 'EXPLORE_REGION'
  | 'PRIORITIZE_FOOD'
  | 'PRIORITIZE_BUILDING'
  | 'GATHER_MATERIALS'
  | 'MIGRATE'
  | 'SEEK_PEACE'
  | 'AVOID_CIVILIZATION'
  | 'TRADE'
  | 'PREPARE_DEFENSE'
  | 'HONOR_GOD'
  | 'REST';

export interface Objective {
  id: number;
  kind: ObjectiveKind;
  reason: string;
  source: 'leader' | 'god' | 'council';
  /** Optional target: a place, a region id, another civ. */
  target?: V2;
  region?: number;
  civ?: number;
  /** World times. */
  since: number;
  until: number;
  /** Free-form progress note for the UI. */
  status: string;
}

export interface Settlement {
  id: number;
  civId: number;
  name: string;
  x: number;
  z: number;
  /** Civ-clock time it was founded. */
  foundedAt: number;
  capital: boolean;
}

export type CivEffectKind = 'blessed' | 'cursed' | 'inspireExplore' | 'inspireBuild' | 'peace' | 'harvest' | 'wrath' | 'fertile';

export interface CivEffect {
  kind: CivEffectKind;
  /** World time it wears off. */
  until: number;
  strength: number;
}

export type RequestKind = 'rain' | 'food' | 'protection' | 'sign' | 'heal' | 'blessing' | 'peace' | 'guidance';

export interface GodRequest {
  id: number;
  kind: RequestKind;
  text: string;
  /** Who asked (usually the leader). */
  by: number;
  time: number;
  /** World time after which an unanswered request counts as ignored. */
  expires: number;
  status: 'open' | 'granted' | 'ignored' | 'refused';
  x: number;
  z: number;
}

export interface LeaderMind {
  /** Compact long-term memories (most important first). */
  memories: string[];
  /** Summary of older memories that were compressed. */
  summary: string;
  /** Last thing they said to the god, and their current stance. */
  lastSpeech: string;
  mood: string;
  /** Civ-clock time of the last strategic review. */
  lastPlan: number;
  /** Where the last plan came from. */
  planSource: 'local' | 'ai';
  /** God commands they remember (text + whether they agreed). */
  commands: Array<{ time: number; text: string; accepted: boolean }>;
  /** Promises the god made them (kept when a matching act comes in time). */
  promises: GodPromise[];
  /** Reasons queued for the next strategic review. */
  pending?: string[];
}

export interface GodPromise {
  kind: RequestKind;
  text: string;
  time: number;
  until: number;
  status: 'open' | 'kept' | 'broken';
}

export interface CivKnowledge {
  /** Explored coarse map cells (MAP_N x MAP_N). */
  map: Uint8Array;
  landmarks: Set<number>;
  regions: Set<number>;
  civs: Set<number>;
  /** Places explorers reported as worth settling (resource-rich, watered). */
  prospects: Array<{ x: number; z: number; score: number; note: string; foundAt: number }>;
}

export interface CivStats {
  births: number;
  deaths: number;
  built: number;
  peak: number;
  discoveries: number;
}

export type Era = 'Camp' | 'Village' | 'Town';

let OBJECTIVE_ID = 1;
export function nextObjectiveId(): number {
  return OBJECTIVE_ID++;
}
export function setObjectiveCounter(v: number): void {
  OBJECTIVE_ID = Math.max(OBJECTIVE_ID, v);
}

/**
 * A people with its own clock, homeland, knowledge, leader and view of the world. Its members
 * are ordinary agents; the civilization is the shared layer above them.
 */
export class Civilization {
  readonly id: number;
  name: string;
  readonly culture: CultureId;
  /** Time scale: 0 = frozen, 1 = normal. */
  speed: CivSpeed = 1;
  /** Local clock (seconds). Starts equal to world time; runs at `speed`. */
  clock: number;
  /** Fractional substep accumulator. */
  acc = 0;
  /** Substeps taken in the last world step (debug/UI). */
  lastSubsteps = 0;
  readonly home: V2;
  readonly settlements: Settlement[] = [];
  /** Living and dead members (dead are removed when buried). */
  readonly members: Agent[] = [];
  leaderId: number | null = null;
  readonly leaders: Array<{ id: number; name: string; from: number; to: number; persona: PersonaTrait[] }> = [];
  readonly knowledge: CivKnowledge;
  readonly relations = new Map<number, Relation>();
  rep: Reputation = { faith: 0.15, fear: 0.05, trust: 0.25, anger: 0, awe: 0.1 };
  /** How they have come to see their god (a short phrase, evolves with experience). */
  godView = 'a distant, silent watcher';
  readonly divine: DivineMemory[] = [];
  readonly history: HistoryEntry[] = [];
  readonly objectives: Objective[] = [];
  readonly effects: CivEffect[] = [];
  readonly requests: GodRequest[] = [];
  readonly mind: LeaderMind = { memories: [], summary: '', lastSpeech: '', mood: 'hopeful', lastPlan: -1e9, planSource: 'local', commands: [], promises: [] };
  readonly stats: CivStats = { births: 0, deaths: 0, built: 0, peak: 0, discoveries: 0 };
  /** Cooldowns for civ-level systems (keyed, civ-clock times). */
  readonly timers = new Map<string, number>();

  constructor(id: number, culture: CultureId, name: string, home: V2, clock: number) {
    this.id = id;
    this.culture = culture;
    this.name = name;
    this.home = { x: home.x, z: home.z };
    this.clock = clock;
    this.knowledge = { map: new Uint8Array(MAP_N * MAP_N), landmarks: new Set(), regions: new Set(), civs: new Set(), prospects: [] };
  }

  get def(): CultureDef {
    return CULTURES[this.culture];
  }

  get people(): string {
    return this.def.people;
  }

  get color(): number {
    return this.def.banner;
  }

  get living(): Agent[] {
    return this.members.filter((a) => a.alive);
  }

  get population(): number {
    let n = 0;
    for (const a of this.members) if (a.alive) n++;
    return n;
  }

  get capital(): Settlement | undefined {
    return this.settlements.find((s) => s.capital) ?? this.settlements[0];
  }

  /** Their own calendar: day number on the civ clock. */
  get day(): number {
    return Math.floor(this.clock / DAY_LENGTH) + 1;
  }

  get hour(): number {
    return (this.clock % DAY_LENGTH) / HOUR;
  }

  /** Current leader's personality (empty without a leader). */
  leaderPersona(leader: Agent | undefined): PersonaTrait[] {
    return leader?.persona ?? [];
  }

  /** Effective priorities: culture × leader × objectives × divine effects. */
  focus(leader: Agent | undefined, worldTime: number): Priorities {
    const p: Priorities = { ...this.def.priorities };
    for (const t of this.leaderPersona(leader)) {
      const w = PERSONAS[t].weights;
      for (const k of Object.keys(w) as Array<keyof Priorities>) p[k] *= w[k]!;
    }
    for (const o of this.objectives) {
      switch (o.kind) {
        case 'EXPAND':
        case 'ESTABLISH_SETTLEMENT':
          p.expand *= 1.5;
          break;
        case 'EXPLORE_REGION':
          p.explore *= 1.6;
          break;
        case 'PRIORITIZE_FOOD':
          p.gather *= 1.45;
          break;
        case 'PRIORITIZE_BUILDING':
        case 'GATHER_MATERIALS':
          p.build *= 1.4;
          break;
        case 'PREPARE_DEFENSE':
          p.defend *= 1.5;
          break;
        case 'HONOR_GOD':
          p.faith *= 1.6;
          break;
        case 'REST':
          p.build *= 0.8;
          p.social *= 1.3;
          break;
        default:
          break;
      }
    }
    for (const e of this.effects) {
      if (e.until < worldTime) continue;
      if (e.kind === 'inspireExplore') p.explore *= 1 + 0.6 * e.strength;
      if (e.kind === 'inspireBuild') {
        p.build *= 1 + 0.5 * e.strength;
        p.expand *= 1 + 0.3 * e.strength;
      }
      if (e.kind === 'cursed') {
        p.build *= 0.8;
        p.explore *= 0.7;
      }
    }
    return p;
  }

  hasEffect(kind: CivEffectKind, worldTime: number): CivEffect | undefined {
    return this.effects.find((e) => e.kind === kind && e.until > worldTime);
  }

  addEffect(kind: CivEffectKind, duration: number, strength: number, worldTime: number): void {
    const prev = this.hasEffect(kind, worldTime);
    if (prev) {
      prev.until = Math.max(prev.until, worldTime + duration);
      prev.strength = Math.max(prev.strength, strength);
    } else this.effects.push({ kind, until: worldTime + duration, strength });
  }

  relation(other: number): Relation {
    let r = this.relations.get(other);
    if (!r) {
      r = { civId: other, state: 'unknown', opinion: 0, metAt: -1, lastContact: -1, gifts: 0, quarrels: 0, truceUntil: 0 };
      this.relations.set(other, r);
    }
    return r;
  }

  knows(other: number): boolean {
    return this.relations.get(other)?.state !== undefined && this.relations.get(other)!.state !== 'unknown';
  }

  addHistory(e: HistoryEntry): void {
    const last = this.history[this.history.length - 1];
    if (last && last.text === e.text) return;
    this.history.push(e);
    if (this.history.length > 160) {
      // Keep the important entries; drop the oldest minor ones first.
      const i = this.history.findIndex((h) => h.importance === 1);
      this.history.splice(i >= 0 ? i : 0, 1);
    }
  }

  addDivine(m: DivineMemory): void {
    this.divine.push(m);
    if (this.divine.length > 40) this.divine.shift();
  }

  timerDue(key: string, now: number): boolean {
    return (this.timers.get(key) ?? -Infinity) <= now;
  }

  setTimer(key: string, until: number): void {
    this.timers.set(key, until);
  }
}

/** Relation state from opinion, with hysteresis so it doesn't flicker. */
export function stateFromOpinion(prev: RelationState, opinion: number): RelationState {
  const bands: Array<[RelationState, number, number]> = [
    ['hostile', -2, -0.55],
    ['tense', -0.55, -0.18],
    ['neutral', -0.18, 0.35],
    ['friendly', 0.35, 2],
  ];
  const cur = bands.find((b) => b[0] === prev);
  if (cur && opinion >= cur[1] - 0.06 && opinion < cur[2] + 0.06) return prev;
  for (const [s, lo, hi] of bands) if (opinion >= lo && opinion < hi) return s;
  return 'neutral';
}

export const RELATION_LABEL: Record<RelationState, string> = {
  unknown: 'Unknown',
  friendly: 'Friendly',
  neutral: 'Neutral',
  tense: 'Tense',
  hostile: 'Hostile',
};
