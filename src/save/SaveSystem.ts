import { Agent, type AgentStats, type Appearance, type DecisionEntry, type Needs } from '../agents/Agent';
import type { ResourceMemory, WaterMemory } from '../agents/Memory';
import type { TraitId } from '../agents/traits';
import { STATE_CODE, World } from '../sim/World';
import { BLUEPRINTS } from '../sim/blueprints';
import type { FeedEvent } from '../sim/events';
import type { Drought, FogBank, RainCloud } from '../sim/weather';
import type { DangerZone, Inventory, ResourceKind, ResourceNode, ScorchMark, Structure } from '../sim/types';
import type { TribeStats } from '../sim/World';
import { Civilization, setObjectiveCounter, type CivEffect, type CivSpeed, type CivStats, type DivineMemory, type GodRequest, type HistoryEntry, type LeaderMind, type Objective, type Relation, type Reputation, type Settlement } from '../civ/Civilization';
import type { CultureId } from '../civ/cultures';
import type { PersonaTrait } from '../civ/persona';
import { emptyInventory } from '../sim/types';

export const SAVE_VERSION = 2;
const PREFIX = 'kaoe.save.';

interface AgentSave {
  id: number;
  name: string;
  traits: TraitId[];
  look: Appearance;
  age: number;
  x: number;
  z: number;
  heading: number;
  needs: Needs;
  inventory: Inventory;
  homeId: number | null;
  alive: boolean;
  deathCause: string;
  diedAt: number;
  buried: boolean;
  knocked: number;
  relations: Array<[number, number]>;
  stats: AgentStats;
  log: DecisionEntry[];
  thought: string;
  faith: number;
  parents: number[];
  bornAt: number;
  civId: number;
  settlementId: number;
  persona: PersonaTrait[];
  news: Agent['news'];
  seen: number[];
  blessedUntil: number;
  cursedUntil: number;
  protectedUntil: number;
  /** Compact memory: [id, kind, x, z, amount, seenAt, avoidUntil, told]. */
  mem: Array<[number, number, number, number, number, number, number, number]>;
  water: WaterMemory[];
  explored: string;
}

interface CivSave {
  id: number;
  name: string;
  culture: CultureId;
  speed: CivSpeed;
  clock: number;
  acc: number;
  home: { x: number; z: number };
  leaderId: number | null;
  leaders: Civilization['leaders'];
  map: string;
  landmarks: number[];
  regions: number[];
  knownCivs: number[];
  prospects: Civilization['knowledge']['prospects'];
  relations: Relation[];
  rep: Reputation;
  godView: string;
  divine: DivineMemory[];
  history: HistoryEntry[];
  objectives: Objective[];
  effects: CivEffect[];
  requests: GodRequest[];
  mind: LeaderMind;
  stats: CivStats;
  timers: Array<[string, number]>;
}

/** Changed or added resource (anything not identical to the freshly generated world). */
type ResourceDelta = Pick<ResourceNode, 'id' | 'state' | 'amount' | 'max' | 'regrow' | 'growth' | 'burning' | 'blessed' | 'lastUse'> & Partial<ResourceNode>;

export interface SaveFile {
  version: number;
  savedAt: number;
  seed: number;
  worldTime: number;
  startTime: number;
  idState: number;
  rng: number;
  weather: { rng: number; nextNatural: number; windX: number; windZ: number; clouds: RainCloud[]; fogs: FogBank[]; droughts: Drought[] };
  resources: ResourceDelta[];
  structures: Structure[];
  agents: AgentSave[];
  civs: CivSave[];
  settlements: Settlement[];
  territory: number[];
  landmarkFinder: Array<[number, number]>;
  dangers: DangerZone[];
  scorches: ScorchMark[];
  wear: string;
  feed: FeedEvent[];
  chronicle: FeedEvent[];
  stats: TribeStats;
}

export interface SaveMeta {
  slot: string;
  savedAt: number;
  day: number;
  clock: string;
  population: number;
  civs: number;
  seed: number;
}

const KINDS: ResourceKind[] = ['tree', 'berryBush', 'fruitTree', 'rock', 'mushroom', 'crystal'];

// ---- binary helpers --------------------------------------------------------

function floatsToB64(arr: ArrayLike<number>, scale = 255): string {
  const bytes = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) bytes[i] = Math.max(0, Math.min(255, Math.round(arr[i]! * scale)));
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(s);
}

function b64ToFloats(b64: string, out: { length: number; [i: number]: number }, scale = 255): void {
  const s = atob(b64);
  for (let i = 0; i < out.length && i < s.length; i++) out[i] = s.charCodeAt(i) / scale;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

// ---- serialize -------------------------------------------------------------

export function serialize(w: World): SaveFile {
  const gen = w.generated;
  const resources: ResourceDelta[] = [];
  for (const r of w.resources.values()) {
    const known = r.id < gen.state.length;
    if (known && gen.state[r.id] === STATE_CODE[r.state] && gen.amount[r.id] === r.amount && gen.max[r.id] === r.max && r.burning === 0 && !r.blessed && r.growth === 1) continue;
    if (known) resources.push({ id: r.id, state: r.state, amount: r.amount, max: r.max, regrow: r.regrow, growth: r.growth, burning: r.burning, blessed: r.blessed, lastUse: r.lastUse });
    else resources.push({ ...r, claims: 0 });
  }
  return {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    seed: w.seed,
    worldTime: w.worldTime,
    startTime: w.startTime,
    idState: w.idState,
    rng: w.rng.state,
    weather: {
      rng: w.weather.rngState,
      nextNatural: w.weather.nextNatural,
      windX: w.weather.windX,
      windZ: w.weather.windZ,
      clouds: w.weather.clouds.map((c) => ({ ...c })),
      fogs: w.weather.fogs.map((f) => ({ ...f })),
      droughts: w.weather.droughts.map((d) => ({ ...d })),
    },
    resources,
    structures: w.structures.map((s) => ({ ...s, incoming: {}, delivered: { ...s.delivered }, stored: { ...s.stored }, residents: [...s.residents], builders: [...s.builders] })),
    agents: w.agents
      .filter((a) => !a.buried || w.structures.some((s) => s.kind === 'grave' && s.foundedBy === a.id))
      .map((a) => ({
        id: a.id,
        name: a.name,
        traits: [...a.traits],
        look: { ...a.look },
        age: a.age,
        x: a.x,
        z: a.z,
        heading: a.heading,
        needs: { ...a.needs },
        inventory: { ...a.inventory },
        homeId: a.homeId,
        alive: a.alive,
        deathCause: a.deathCause,
        diedAt: a.diedAt,
        buried: a.buried,
        knocked: a.knocked,
        relations: [...a.relations.entries()].map(([k, v]) => [k, Math.round(v * 1000) / 1000] as [number, number]),
        stats: { ...a.stats },
        log: a.buried ? [] : a.log.slice(-20),
        thought: a.thought,
        faith: a.faith,
        parents: [...a.parents],
        bornAt: a.bornAt,
        civId: a.civId,
        settlementId: a.settlementId,
        persona: [...a.persona],
        news: a.news.map((n) => ({ ...n })),
        seen: [...a.seenLandmarks],
        blessedUntil: a.blessedUntil,
        cursedUntil: a.cursedUntil,
        protectedUntil: a.protectedUntil,
        mem: a.buried ? [] : [...a.memory.resources.values()].map((m) => [m.id, KINDS.indexOf(m.kind), r1(m.x), r1(m.z), m.amount, Math.round(m.seenAt), Math.round(m.avoidUntil), m.source === 'told' ? 1 : 0]),
        water: a.buried ? [] : [...a.memory.water.values()].map((m) => ({ ...m })),
        explored: floatsToB64(Array.from(a.memory.explored, (t) => (t > 0 ? 1 : 0)), 1),
      })),
    civs: w.civs.map((c) => ({
      id: c.id,
      name: c.name,
      culture: c.culture,
      speed: c.speed,
      clock: c.clock,
      acc: c.acc,
      home: { ...c.home },
      leaderId: c.leaderId,
      leaders: c.leaders.map((l) => ({ ...l, persona: [...l.persona] })),
      map: floatsToB64(c.knowledge.map, 1),
      landmarks: [...c.knowledge.landmarks],
      regions: [...c.knowledge.regions],
      knownCivs: [...c.knowledge.civs],
      prospects: c.knowledge.prospects.map((p) => ({ ...p })),
      relations: [...c.relations.values()].map((r) => ({ ...r })),
      rep: { ...c.rep },
      godView: c.godView,
      divine: c.divine.map((d) => ({ ...d })),
      history: c.history.map((h) => ({ ...h })),
      objectives: c.objectives.map((o) => ({ ...o })),
      effects: c.effects.map((e) => ({ ...e })),
      requests: c.requests.map((r) => ({ ...r })),
      mind: { ...c.mind, memories: [...c.mind.memories], commands: c.mind.commands.map((x) => ({ ...x })) },
      stats: { ...c.stats },
      timers: [...c.timers.entries()],
    })),
    settlements: w.settlements.map((s) => ({ ...s })),
    territory: Array.from(w.territory),
    landmarkFinder: [...w.landmarkFinder.entries()],
    dangers: w.dangers.map((d) => ({ ...d })),
    scorches: w.scorches.map((s) => ({ ...s })),
    wear: floatsToB64(w.wear),
    feed: w.feed.slice(-30),
    chronicle: w.chronicle.slice(-400),
    stats: { ...w.stats },
  };
}

// ---- deserialize -----------------------------------------------------------

export function deserialize(data: SaveFile): World {
  if (!data || typeof data !== 'object') throw new Error('Not a save file');
  if (data.version !== SAVE_VERSION) throw new Error(data.version === 1 ? 'This save is from the old single-island version and cannot be loaded into the new world' : 'Incompatible save file');
  const w = new World(data.seed);
  w.worldTime = data.worldTime;
  w.time = data.worldTime;
  w.startTime = data.startTime ?? data.worldTime;
  w.rng.state = data.rng;
  w.weather.rngState = data.weather.rng;
  w.weather.nextNatural = data.weather.nextNatural;
  w.weather.windX = data.weather.windX;
  w.weather.windZ = data.weather.windZ;
  w.weather.clouds.push(...data.weather.clouds);
  w.weather.fogs.push(...(data.weather.fogs ?? []));
  w.weather.droughts.push(...(data.weather.droughts ?? []));
  // Resources: re-apply changes over the regenerated world, keeping nav blockers consistent.
  for (const d of data.resources) {
    const r = w.resources.get(d.id);
    if (!r) {
      w.insertResource({ ...(d as ResourceNode), claims: 0 });
      continue;
    }
    const before = w.blocksNav(r);
    Object.assign(r, d, { claims: 0 });
    const after = w.blocksNav(r);
    if (before && !after) w.nav.removeBlocker(r.x, r.z, r.blockRadius);
    if (!before && after) w.nav.addBlocker(r.x, r.z, r.blockRadius);
  }
  for (const s of data.structures) {
    const st: Structure = { ...s, incoming: {}, stored: { ...emptyInventory(), ...s.stored } };
    w.structures.push(st);
    const bp = BLUEPRINTS[st.kind];
    if (bp.blockRadius > 0) w.nav.addBlocker(st.x, st.z, bp.blockRadius);
  }
  for (const d of data.dangers) w.dangers.push(d);
  for (const s of data.scorches) w.scorches.push(s);
  b64ToFloats(data.wear, w.wear);
  w.territory.set(data.territory);
  w.territoryVersion++;
  for (const [k, v] of data.landmarkFinder ?? []) w.landmarkFinder.set(k, v);
  for (const s of data.settlements) w.settlements.push({ ...s });
  // Civilizations.
  let maxObjective = 0;
  for (const cs of data.civs) {
    const c = new Civilization(cs.id, cs.culture, cs.name, cs.home, cs.clock);
    c.speed = cs.speed;
    c.acc = cs.acc;
    c.leaderId = cs.leaderId;
    c.leaders.push(...cs.leaders);
    b64ToFloats(cs.map, c.knowledge.map, 1);
    for (const id of cs.landmarks) c.knowledge.landmarks.add(id);
    for (const id of cs.regions) c.knowledge.regions.add(id);
    for (const id of cs.knownCivs) c.knowledge.civs.add(id);
    c.knowledge.prospects.push(...cs.prospects);
    for (const r of cs.relations) c.relations.set(r.civId, { ...r });
    c.rep = { ...cs.rep };
    c.godView = cs.godView;
    c.divine.push(...cs.divine);
    c.history.push(...cs.history);
    c.objectives.push(...cs.objectives);
    for (const o of cs.objectives) maxObjective = Math.max(maxObjective, o.id);
    c.effects.push(...cs.effects);
    c.requests.push(...cs.requests);
    Object.assign(c.mind, cs.mind);
    Object.assign(c.stats, cs.stats);
    for (const [k, v] of cs.timers) c.timers.set(k, v);
    for (const s of w.settlements) if (s.civId === c.id) c.settlements.push(s);
    w.civs.push(c);
  }
  setObjectiveCounter(maxObjective + 1);
  for (const as of data.agents) {
    const a = new Agent(as.id, as.name, as.x, as.z, as.traits, as.look, as.age);
    a.heading = a.prevHeading = as.heading;
    Object.assign(a.needs, as.needs);
    Object.assign(a.inventory, emptyInventory(), as.inventory);
    a.homeId = as.homeId;
    a.alive = as.alive;
    a.deathCause = as.deathCause;
    a.diedAt = as.diedAt;
    a.buried = as.buried;
    a.knocked = as.knocked;
    a.relations = new Map(as.relations);
    Object.assign(a.stats, as.stats);
    a.log = as.log;
    a.thought = as.thought;
    a.faith = as.faith ?? 0;
    a.parents = as.parents ?? [];
    a.bornAt = as.bornAt ?? 0;
    a.civId = as.civId;
    a.settlementId = as.settlementId;
    a.persona = as.persona ?? [];
    a.news = as.news ?? [];
    a.seenLandmarks = new Set(as.seen ?? []);
    a.blessedUntil = as.blessedUntil ?? 0;
    a.cursedUntil = as.cursedUntil ?? 0;
    a.protectedUntil = as.protectedUntil ?? 0;
    const clock = w.civs[a.civId]?.clock ?? w.worldTime;
    for (const [id, k, x, z, amount, seenAt, avoidUntil, told] of as.mem) {
      const m: ResourceMemory = { id, kind: KINDS[k] ?? 'tree', x, z, amount, seenAt, avoidUntil, source: told ? 'told' : 'seen' };
      a.memory.resources.set(id, m);
    }
    for (const m of as.water) a.memory.water.set(m.pondId, m);
    const explored = new Float32Array(a.memory.explored.length);
    b64ToFloats(as.explored, explored, 1);
    for (let i = 0; i < explored.length; i++) a.memory.explored[i] = explored[i]! > 0 ? clock : 0;
    if (!a.alive) a.setAnim('dead');
    // Anyone saved mid-sleep starts outside; they'll decide to go back to bed.
    if (!w.nav.walkable(a.x, a.z)) {
      const p = w.nav.nearestWalkable(a.x, a.z, 8);
      if (p) {
        a.x = a.prevX = p.x;
        a.z = a.prevZ = p.z;
      }
    }
    w.agents.push(a);
    const civ = w.civs[a.civId];
    if (civ && !a.buried) civ.members.push(a);
    if (!a.buried) w.agentHash.insert(a);
  }
  w.idState = Math.max(data.idState, w.idState);
  for (const e of data.feed) w.feed.push(e);
  for (const e of data.chronicle ?? []) w.chronicle.push(e);
  Object.assign(w.stats, data.stats);
  return w;
}

// ---- storage ---------------------------------------------------------------

export function saveToSlot(w: World, slot: string): { ok: true; meta: SaveMeta } | { ok: false; error: string } {
  try {
    const data = serialize(w);
    const json = JSON.stringify(data);
    const meta: SaveMeta = { slot, savedAt: data.savedAt, day: w.worldDay, clock: w.clockString(w.worldTime), population: w.living.length, civs: w.civs.length, seed: w.seed };
    try {
      localStorage.setItem(PREFIX + slot, json);
    } catch {
      // Out of space: make room by dropping the other slot, then try once more.
      for (const other of ['auto', 'quick']) if (other !== slot) localStorage.removeItem(PREFIX + other);
      localStorage.setItem(PREFIX + slot, json);
    }
    localStorage.setItem(PREFIX + slot + '.meta', JSON.stringify(meta));
    return { ok: true, meta };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function loadFromSlot(slot: string): World | null {
  const json = localStorage.getItem(PREFIX + slot);
  if (!json) return null;
  return deserialize(JSON.parse(json) as SaveFile);
}

export function slotMeta(slot: string): SaveMeta | null {
  try {
    const m = localStorage.getItem(PREFIX + slot + '.meta');
    return m ? (JSON.parse(m) as SaveMeta) : null;
  } catch {
    return null;
  }
}
