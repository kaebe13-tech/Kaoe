import { Agent, type AgentStats, type Appearance, type DecisionEntry, type Needs } from '../agents/Agent';
import type { ResourceMemory, WaterMemory } from '../agents/Memory';
import type { TraitId } from '../agents/traits';
import { World } from '../sim/World';
import { BLUEPRINTS } from '../sim/blueprints';
import type { FeedEvent } from '../sim/events';
import type { RainCloud } from '../sim/weather';
import type { DangerZone, Inventory, ResourceNode, ScorchMark, Structure } from '../sim/types';
import type { TribeStats } from '../sim/World';

export const SAVE_VERSION = 1;
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
  memory: { resources: ResourceMemory[]; water: WaterMemory[]; explored: string };
}

export interface SaveFile {
  version: number;
  savedAt: number;
  seed: number;
  time: number;
  startTime: number;
  idState: number;
  rng: number;
  weather: { rng: number; nextNatural: number; windX: number; windZ: number; clouds: RainCloud[] };
  resources: ResourceNode[];
  structures: Structure[];
  agents: AgentSave[];
  dangers: DangerZone[];
  scorches: ScorchMark[];
  wear: string;
  feed: FeedEvent[];
  stats: TribeStats;
}

export interface SaveMeta {
  slot: string;
  savedAt: number;
  day: number;
  clock: string;
  population: number;
  seed: number;
}

// ---- binary helpers --------------------------------------------------------

function floatsToB64(arr: Float32Array, scale = 255): string {
  const bytes = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) bytes[i] = Math.max(0, Math.min(255, Math.round(arr[i]! * scale)));
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(s);
}

function b64ToFloats(b64: string, out: Float32Array, scale = 255): void {
  const s = atob(b64);
  for (let i = 0; i < out.length && i < s.length; i++) out[i] = s.charCodeAt(i) / scale;
}

// ---- serialize -------------------------------------------------------------

export function serialize(w: World): SaveFile {
  return {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    seed: w.seed,
    time: w.time,
    startTime: w.startTime,
    idState: w.idState,
    rng: w.rng.state,
    weather: { rng: w.weather.rngState, nextNatural: w.weather.nextNatural, windX: w.weather.windX, windZ: w.weather.windZ, clouds: w.weather.clouds.map((c) => ({ ...c })) },
    resources: [...w.resources.values()].map((r) => ({ ...r, claims: 0 })),
    structures: w.structures.map((s) => ({ ...s, incoming: {}, delivered: { ...s.delivered }, stored: { ...s.stored }, residents: [...s.residents], builders: [...s.builders] })),
    agents: w.agents.map((a) => ({
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
      relations: [...a.relations.entries()],
      stats: { ...a.stats },
      log: a.log.slice(-24),
      thought: a.thought,
      memory: {
        resources: [...a.memory.resources.values()].map((m) => ({ ...m })),
        water: [...a.memory.water.values()].map((m) => ({ ...m })),
        explored: floatsToB64(new Float32Array(a.memory.explored.map((t) => (t > 0 ? 1 : 0))), 1),
      },
    })),
    dangers: w.dangers.map((d) => ({ ...d })),
    scorches: w.scorches.map((s) => ({ ...s })),
    wear: floatsToB64(w.wear),
    feed: w.feed.slice(-30),
    stats: { ...w.stats },
  };
}

// ---- deserialize -----------------------------------------------------------

export function deserialize(data: SaveFile): World {
  if (!data || typeof data !== 'object' || data.version !== SAVE_VERSION) throw new Error('Incompatible save file');
  const w = new World(data.seed, { skipResources: true });
  w.time = data.time;
  w.startTime = data.startTime ?? data.time;
  w.rng.state = data.rng;
  w.weather.rngState = data.weather.rng;
  w.weather.nextNatural = data.weather.nextNatural;
  w.weather.windX = data.weather.windX;
  w.weather.windZ = data.weather.windZ;
  w.weather.clouds.push(...data.weather.clouds);
  for (const r of data.resources) w.insertResource({ ...r, claims: 0 });
  for (const s of data.structures) {
    const st: Structure = { ...s, incoming: {} };
    w.structures.push(st);
    const bp = BLUEPRINTS[st.kind];
    if (bp.blockRadius > 0) w.nav.addBlocker(st.x, st.z, bp.blockRadius);
  }
  for (const d of data.dangers) w.dangers.push(d);
  for (const s of data.scorches) w.scorches.push(s);
  b64ToFloats(data.wear, w.wear);
  for (const as of data.agents) {
    const a = new Agent(as.id, as.name, as.x, as.z, as.traits, as.look, as.age);
    a.heading = a.prevHeading = as.heading;
    Object.assign(a.needs, as.needs);
    Object.assign(a.inventory, as.inventory);
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
    for (const m of as.memory.resources) a.memory.resources.set(m.id, m);
    for (const m of as.memory.water) a.memory.water.set(m.pondId, m);
    const explored = new Float32Array(a.memory.explored.length);
    b64ToFloats(as.memory.explored, explored, 1);
    for (let i = 0; i < explored.length; i++) a.memory.explored[i] = explored[i]! > 0 ? w.time : 0;
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
    if (!a.buried) w.agentHash.insert(a);
  }
  w.idState = Math.max(data.idState, w.idState);
  for (const e of data.feed) w.feed.push(e);
  Object.assign(w.stats, data.stats);
  return w;
}

// ---- storage ---------------------------------------------------------------

export function saveToSlot(w: World, slot: string): { ok: true; meta: SaveMeta } | { ok: false; error: string } {
  try {
    const data = serialize(w);
    const json = JSON.stringify(data);
    const meta: SaveMeta = { slot, savedAt: data.savedAt, day: w.day, clock: w.clockString(), population: w.living.length, seed: w.seed };
    localStorage.setItem(PREFIX + slot, json);
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
