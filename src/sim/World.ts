import { Emitter } from '../core/events';
import { Rng } from '../core/rng';
import { SpatialHash } from '../core/spatialHash';
import { TAU, type V2 } from '../core/math';
import { Agent, randomAppearance, randomTraits } from '../agents/Agent';
import { TRAITS } from '../agents/traits';
import { generateTerrain, type CivSite } from '../world/generateTerrain';
import { populateResources } from '../world/populate';
import type { Terrain } from '../world/Terrain';
import { DAY_LENGTH, HOUR, MAP_CELL, MAP_N, WORLD_HALF, WORLD_SIZE } from '../world/config';
import { EXPLORE_CELL, EXPLORE_N, EXPLORE_ORIGIN } from '../agents/Memory';
import { Civilization, type Settlement } from '../civ/Civilization';
import { CULTURES, CULTURE_ORDER, cultureName, type CultureId } from '../civ/cultures';
import { randomPersona } from '../civ/persona';
import { Biome } from '../world/biomes';
import { NavGrid } from '../nav/NavGrid';
import { PathService } from '../nav/PathService';
import { Weather } from './weather';
import type { FeedEvent, FeedIcon, SimEvents } from './events';
import { BLUEPRINTS } from './blueprints';
import { emptyInventory, type DangerZone, type DrinkSpot, type ResourceNode, type ScorchMark, type Structure, type StructureKind, type WaterBody } from './types';
import { daylightAt } from './time';
import type { TerrainEdit } from './terrainEdit';
import type { WorldEventRecord } from './worldEvents';
import type { Pond } from '../world/Terrain';

export const START_HOUR = 7.75;

export const STATE_CODE: Record<ResourceNode['state'], number> = { grown: 0, stump: 1, sapling: 2, burnt: 3 };

export interface TribeStats {
  births: number;
  deaths: number;
  built: number;
  lightningStrikes: number;
  friendships: number;
}

/** Wear (foot traffic) is tracked on a coarser grid than navigation. */
export const WEAR_CELL = 2;
export const WEAR_N = WORLD_SIZE / WEAR_CELL;

/** All simulation state. Pure data + helpers; systems live in their own modules. */
export class World {
  readonly seed: number;
  readonly terrain: Terrain;
  readonly start: V2;
  readonly mountain: V2;
  /** Candidate homelands (one per potential civilization). */
  readonly sites: CivSite[];
  readonly civs: Civilization[] = [];
  readonly settlements: Settlement[] = [];
  /** Territory owner per coarse map cell (civ id, or -1). */
  readonly territory: Int8Array = new Int8Array(MAP_N * MAP_N).fill(-1);
  territoryVersion = 0;
  /** Which landmarks each civilization has seen is stored per civ; this tracks the first finder. */
  readonly landmarkFinder = new Map<number, number>();
  readonly rng: Rng;
  readonly events = new Emitter<SimEvents>();
  readonly nav: NavGrid;
  readonly paths: PathService;
  readonly weather: Weather;

  /**
   * The clock of whoever is being simulated right now. Outside civilization updates this is
   * world time; while a civilization's members are stepped it is that civilization's own clock,
   * so everything agents do (timers, cooldowns, plans, the hour they sleep) runs in their time.
   */
  time = START_HOUR * HOUR;
  /** Global clock: sun, weather, wild plants, fire. */
  worldTime = START_HOUR * HOUR;
  /** Civilization currently being stepped (null in world context). */
  activeCiv: Civilization | null = null;
  /** When this world began (after load this is the original start). */
  startTime = START_HOUR * HOUR;
  private idCounter = 1;

  readonly agents: Agent[] = [];
  readonly agentHash = new SpatialHash<Agent>(8);
  readonly resources = new Map<number, ResourceNode>();
  readonly resourceHash = new SpatialHash<ResourceNode>(8);
  readonly structures: Structure[] = [];
  readonly water: WaterBody[] = [];
  readonly dangers: DangerZone[] = [];
  readonly scorches: ScorchMark[] = [];
  /** Foot traffic per nav cell; renders as worn dirt paths. */
  readonly wear: Float32Array;
  wearDirty = false;
  readonly feed: FeedEvent[] = [];
  /** Notable events kept for the tribe's history book. */
  readonly chronicle: FeedEvent[] = [];
  /** Recent navigation trouble spots, for debugging and the soak test. */
  readonly stuckLog: Array<{ id: number; x: number; z: number; wx: number; wz: number; time: number; final: boolean }> = [];
  readonly stats: TribeStats = { births: 0, deaths: 0, built: 0, lightningStrikes: 0, friendships: 0 };
  /** Resource state as generated (index = resource id). */
  readonly generated: { state: Uint8Array; amount: Uint8Array; max: Uint8Array };
  /** Changes the god made to the land, in order (saved and replayed on load). */
  readonly terrainEdits: TerrainEdit[] = [];
  /** Divine acts waiting to land (a meteor falling, a quake building). World times. */
  readonly scheduled: Array<{ at: number; kind: string; x: number; z: number; r: number; data?: number }> = [];
  /** Natural world events so far, and when the next one may come. */
  readonly worldEventLog: WorldEventRecord[] = [];
  nextWorldEvent = DAY_LENGTH * 1.2;
  /** The god's visible presence in the world, if manifested (world time it fades). */
  presence: { x: number; z: number; until: number; since: number } | null = null;
  /** Walkable spots along the sea shore (for strolls and watching the waves). */
  readonly beachSpots: V2[] = [];
  /** Which coarse exploration cells are land (to measure how much has been explored). */
  readonly exploreLand: Uint8Array;
  readonly exploreLandCount: number;

  constructor(seed: number, options: { skipResources?: boolean } = {}) {
    this.seed = seed;
    this.rng = new Rng(seed ^ 0x51a7);
    const gen = generateTerrain(seed);
    this.terrain = gen.terrain;
    this.start = gen.start;
    this.mountain = gen.mountain;
    this.sites = gen.sites;
    this.nav = new NavGrid(this.terrain);
    this.paths = new PathService(this.nav);
    this.weather = new Weather(seed);
    this.wear = new Float32Array(WEAR_N * WEAR_N);
    if (!options.skipResources) {
      for (const r of populateResources(this.terrain, seed, this.sites)) this.insertResource(r);
    }
    for (const l of this.terrain.landmarks) if (l.block > 0) this.nav.addBlocker(l.x, l.z, l.block);
    // Resource ids come from the generator; keep new ids above them.
    let maxId = 0;
    for (const id of this.resources.keys()) maxId = Math.max(maxId, id);
    this.idCounter = maxId + 1;
    // Remember how the generator left every resource, so saves only store what changed.
    this.generated = { state: new Uint8Array(maxId + 1), amount: new Uint8Array(maxId + 1), max: new Uint8Array(maxId + 1) };
    for (const r of this.resources.values()) {
      this.generated.state[r.id] = STATE_CODE[r.state];
      this.generated.amount[r.id] = r.amount;
      this.generated.max[r.id] = r.max;
    }
    this.buildWater();
    this.buildBeach();
    this.exploreLand = new Uint8Array(EXPLORE_N * EXPLORE_N);
    let land = 0;
    for (let cz = 0; cz < EXPLORE_N; cz++) {
      for (let cx = 0; cx < EXPLORE_N; cx++) {
        const x = EXPLORE_ORIGIN + (cx + 0.5) * EXPLORE_CELL;
        const z = EXPLORE_ORIGIN + (cz + 0.5) * EXPLORE_CELL;
        if (this.nav.nearestWalkable(x, z, 4)) {
          this.exploreLand[cz * EXPLORE_N + cx] = 1;
          land++;
        }
      }
    }
    this.exploreLandCount = land;
  }

  private buildBeach(): void {
    const rng = new Rng(this.seed ^ 0xbeac);
    for (let k = 0; k < 4000 && this.beachSpots.length < 260; k++) {
      const x = rng.range(-WORLD_HALF + 10, WORLD_HALF - 10);
      const z = rng.range(-WORLD_HALF + 10, WORLD_HALF - 10);
      const h = this.terrain.heightAt(x, z);
      if (h < 0.5 || h > 1.6 || this.terrain.slopeAt(x, z) > 0.3 || !this.nav.walkable(x, z)) continue;
      // Must look out over the sea.
      let sea = false;
      for (let a = 0; a < 8 && !sea; a++) {
        const ang = (a / 8) * TAU;
        if (this.terrain.heightAt(x + Math.cos(ang) * 8, z + Math.sin(ang) * 8) < -0.2) sea = true;
      }
      if (sea) this.beachSpots.push({ x, z });
    }
  }

  /** Fraction (0..1) of the world's land this agent has seen. */
  exploredFraction(a: Agent): number {
    let seen = 0;
    for (let i = 0; i < this.exploreLand.length; i++) if (this.exploreLand[i] && a.memory.explored[i]! > 0) seen++;
    return seen / Math.max(1, this.exploreLandCount);
  }

  nextId(): number {
    return this.idCounter++;
  }

  get idState(): number {
    return this.idCounter;
  }

  set idState(v: number) {
    this.idCounter = v;
  }

  // ---- Time ---------------------------------------------------------------

  /** Day number of the context clock. */
  get day(): number {
    return Math.floor(this.time / DAY_LENGTH) + 1;
  }

  /** Hour of the context clock (a civilization's own hour while it is being stepped). */
  get hour(): number {
    return (this.time % DAY_LENGTH) / HOUR;
  }

  get isNight(): boolean {
    const h = this.hour;
    return h < 5.5 || h >= 20.5;
  }

  /** 1 at midday, 0 at night, smooth at dawn/dusk (context clock). */
  get daylight(): number {
    return daylightAt(this.hour);
  }

  get worldDay(): number {
    return Math.floor(this.worldTime / DAY_LENGTH) + 1;
  }

  get worldHour(): number {
    return (this.worldTime % DAY_LENGTH) / HOUR;
  }

  get worldNight(): boolean {
    const h = this.worldHour;
    return h < 5.5 || h >= 20.5;
  }

  /** The clock an agent lives by (their civilization's). */
  now(a: { civId: number }): number {
    const c = this.civs[a.civId];
    return c ? c.clock : this.worldTime;
  }

  /** Hour of day for a civilization (world hour for none). */
  hourOf(civId: number): number {
    const c = this.civs[civId];
    return ((c ? c.clock : this.worldTime) % DAY_LENGTH) / HOUR;
  }

  /** Run `fn` in a civilization's time context. */
  withCiv<T>(civ: Civilization, fn: () => T): T {
    const prevT = this.time;
    const prevC = this.activeCiv;
    this.time = civ.clock;
    this.activeCiv = civ;
    try {
      return fn();
    } finally {
      this.time = prevT;
      this.activeCiv = prevC;
    }
  }

  clockString(time = this.time): string {
    const h = (time % DAY_LENGTH) / HOUR;
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    return `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
  }

  // ---- Feed ---------------------------------------------------------------

  log(text: string, icon: FeedIcon, importance: 1 | 2 | 3, at?: V2 | null, agentId?: number): void {
    const e: FeedEvent = { text, icon, importance, time: this.worldTime };
    if (this.activeCiv) e.civId = this.activeCiv.id;
    if (at) {
      e.x = at.x;
      e.z = at.z;
    }
    if (agentId !== undefined) e.agentId = agentId;
    this.feed.push(e);
    if (this.feed.length > 80) this.feed.shift();
    if (importance >= 2) {
      this.chronicle.push(e);
      if (this.chronicle.length > 400) this.chronicle.shift();
    }
    this.events.emit('log', e);
  }

  // ---- Resources ----------------------------------------------------------

  insertResource(r: ResourceNode): void {
    this.resources.set(r.id, r);
    this.resourceHash.insert(r);
    if (r.blockRadius > 0 && this.blocksNav(r)) this.nav.addBlocker(r.x, r.z, r.blockRadius);
  }

  addResource(r: ResourceNode): void {
    this.insertResource(r);
    this.events.emit('resourceAdded', r);
  }

  /** Whether a resource in its current state blocks movement. */
  blocksNav(r: ResourceNode): boolean {
    if (r.blockRadius <= 0) return false;
    if (r.kind === 'rock') return true;
    if (r.kind === 'tree' || r.kind === 'fruitTree') return r.state === 'grown' || r.state === 'burnt' || (r.state === 'sapling' && r.growth > 0.5);
    return false;
  }

  /** Change a resource state, keeping the nav grid consistent. */
  setResourceState(r: ResourceNode, state: ResourceNode['state'], growth = r.growth): void {
    const before = this.blocksNav(r);
    r.state = state;
    r.growth = growth;
    const after = this.blocksNav(r);
    if (before && !after) this.nav.removeBlocker(r.x, r.z, r.blockRadius);
    if (!before && after) this.nav.addBlocker(r.x, r.z, r.blockRadius);
    this.events.emit('resourceChanged', r);
  }

  // ---- Structures -----------------------------------------------------------

  createStructure(kind: StructureKind, x: number, z: number, rot: number, founder: number, civId?: number, settlementId?: number): Structure {
    const bp = BLUEPRINTS[kind];
    const f = this.agent(founder);
    const s: Structure = {
      id: this.nextId(),
      kind,
      civId: civId ?? f?.civId ?? -1,
      settlementId: settlementId ?? f?.settlementId ?? -1,
      x,
      z,
      rot,
      progress: 0,
      complete: false,
      delivered: {},
      incoming: {},
      stored: emptyInventory(),
      residents: [],
      fuel: 0,
      lit: false,
      burning: 0,
      damage: 0,
      foundedBy: founder,
      foundedAt: this.time,
      completedAt: 0,
      builders: [],
      label: '',
    };
    this.structures.push(s);
    if (bp.blockRadius > 0) this.nav.addBlocker(x, z, bp.blockRadius);
    this.events.emit('structureAdded', s);
    return s;
  }

  removeStructure(s: Structure): void {
    const i = this.structures.indexOf(s);
    if (i < 0) return;
    this.structures.splice(i, 1);
    const bp = BLUEPRINTS[s.kind];
    if (bp.blockRadius > 0) this.nav.removeBlocker(s.x, s.z, bp.blockRadius);
    for (const a of this.agents) {
      if (a.homeId === s.id) a.homeId = null;
      if (a.inside === s.id) a.inside = null;
    }
    this.events.emit('structureRemoved', s);
  }

  structure(id: number | null | undefined): Structure | undefined {
    if (id == null) return undefined;
    return this.structures.find((s) => s.id === id);
  }

  // ---- Agents -------------------------------------------------------------

  agent(id: number | null | undefined): Agent | undefined {
    if (id == null) return undefined;
    return this.agents.find((a) => a.id === id);
  }

  get living(): Agent[] {
    return this.agents.filter((a) => a.alive);
  }

  /** Living members of a settlement. */
  settlers(settlementId: number): Agent[] {
    return this.agents.filter((a) => a.alive && a.settlementId === settlementId);
  }

  addAgent(a: Agent): void {
    this.agents.push(a);
    this.agentHash.insert(a);
    const civ = this.civs[a.civId];
    if (civ && !civ.members.includes(a)) civ.members.push(a);
    this.events.emit('agentAdded', a);
  }

  civOf(a: { civId: number } | null | undefined): Civilization | undefined {
    return a ? this.civs[a.civId] : undefined;
  }

  settlement(id: number | null | undefined): Settlement | undefined {
    if (id == null || id < 0) return undefined;
    return this.settlements.find((s) => s.id === id);
  }

  /** Names already used by anyone (living or remembered). */
  takenNames(): Set<string> {
    return new Set(this.agents.map((a) => a.name));
  }

  spawnAgent(x: number, z: number, rng = this.rng, civ?: Civilization): Agent {
    const culture: CultureId = civ?.culture ?? 'vale';
    const name = cultureName(rng, CULTURES[culture], this.takenNames());
    const traits = randomTraits(rng);
    // Cultures raise some temperaments more often (never contradicting the other trait).
    if (civ && rng.chance(0.45)) {
      const fav = rng.pick(CULTURES[culture].favoured);
      const keep = traits[0]!;
      const clash = TRAITS[keep].conflicts?.includes(fav) || TRAITS[fav].conflicts?.includes(keep);
      if (!traits.includes(fav) && !clash) traits[traits.length - 1] = fav;
    }
    const a = new Agent(this.nextId(), name, x, z, traits.filter((t, i, arr) => arr.indexOf(t) === i), randomAppearance(rng, culture), rng.int(17, 42));
    a.heading = rng.range(0, TAU);
    a.prevHeading = a.heading;
    a.persona = randomPersona(rng);
    if (civ) {
      a.civId = civ.id;
      a.settlementId = civ.capital?.id ?? -1;
    }
    this.addAgent(a);
    return a;
  }

  /** Found a new civilization at a homeland with `count` people. */
  addCivilization(culture: CultureId, site: V2, count: number): Civilization {
    const rng = this.rng;
    const def = CULTURES[culture];
    const taken = new Set(this.civs.map((c) => c.name));
    const name = def.names.find((n) => !taken.has(n)) ?? def.names[0]!;
    const civ = new Civilization(this.civs.length, culture, name, site, this.worldTime);
    this.civs.push(civ);
    this.foundSettlement(civ, site, true, def.people);
    const members: Agent[] = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + rng.range(-0.3, 0.3);
      const d = rng.range(1.5, 4);
      const p = this.nav.nearestWalkable(site.x + Math.cos(a) * d, site.z + Math.sin(a) * d, 8) ?? site;
      const agent = this.spawnAgent(p.x, p.z, rng, civ);
      agent.needs.hunger = rng.range(0.55, 0.8);
      agent.needs.thirst = rng.range(0.5, 0.75);
      agent.needs.energy = rng.range(0.8, 0.95);
      agent.needs.social = rng.range(0.5, 0.8);
      members.push(agent);
    }
    // Everyone arrived together: they start as acquaintances.
    for (const a of members) for (const b of members) if (a !== b) a.relations.set(b.id, rng.range(0.3, 0.5));
    // They chose this place for its water: everyone knows where to drink.
    for (const wb of this.water) {
      if (Math.hypot(wb.x - site.x, wb.z - site.z) - wb.radius > 45) continue;
      for (const a of members) a.memory.water.set(wb.id, { pondId: wb.id, x: wb.x, z: wb.z, seenAt: civ.clock, avoidUntil: 0 });
    }
    // They know the land they stand on.
    const r = 2;
    const cx = Math.floor((site.x + WORLD_HALF) / MAP_CELL);
    const cz = Math.floor((site.z + WORLD_HALF) / MAP_CELL);
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      const z = cz + dz;
      if (x >= 0 && z >= 0 && x < MAP_N && z < MAP_N) civ.knowledge.map[z * MAP_N + x] = 1;
    }
    const region = this.terrain.regionAt(site.x, site.z);
    if (region) civ.knowledge.regions.add(region.id);
    return civ;
  }

  foundSettlement(civ: Civilization, at: V2, capital: boolean, name?: string): Settlement {
    const region = this.terrain.regionAt(at.x, at.z);
    const s: Settlement = {
      id: this.settlements.length ? Math.max(...this.settlements.map((x) => x.id)) + 1 : 1,
      civId: civ.id,
      name: name ?? `${civ.def.onset[this.settlements.length % civ.def.onset.length]}${civ.def.coda[(this.settlements.length * 3) % civ.def.coda.length]}${region ? '' : ''}`,
      x: at.x,
      z: at.z,
      foundedAt: civ.clock,
      capital,
    };
    this.settlements.push(s);
    civ.settlements.push(s);
    return s;
  }

  /** Spawn the standard set of civilizations (at most one per homeland). */
  spawnCivilizations(count: number, perCiv: number): void {
    const order: CultureId[] = [...CULTURE_ORDER];
    const n = Math.max(1, Math.min(count, this.sites.length, order.length));
    for (let i = 0; i < n; i++) {
      const site = this.sites[i]!;
      const culture = order.find((c) => CULTURES[c].homeBiome === site.biome) ?? order[i]!;
      this.addCivilization(culture, site, perCiv);
    }
    void Biome;
  }

  /** Legacy single-tribe spawn (tests): one civilization at the first homeland. */
  spawnTribe(count: number): void {
    this.spawnCivilizations(1, count);
  }

  // ---- Water --------------------------------------------------------------

  private spotId = 1;

  /** Drinking spots around a lake (also used for springs the god creates). */
  addPondWater(p: Pond, name?: string): void {
    const t = this.terrain;
    const spots: DrinkSpot[] = [];
    for (let k = 0; k < 40; k++) {
      const a = (k / 40) * TAU;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      for (let r = p.radius * 0.6; r < p.radius * 2.2; r += 0.3) {
        const x = p.x + dx * r;
        const z = p.z + dz * r;
        if (this.nav.walkable(x, z) && !this.nav.wade[this.nav.index(this.nav.cellX(x), this.nav.cellZ(z))]) {
          // Only keep spots right at the water's edge.
          if (t.pondAt(x - dx * 1.4, z - dz * 1.4)) spots.push({ id: this.spotId++, pondId: p.id, x, z, wx: x - dx * 1.2, wz: z - dz * 1.2 });
          break;
        }
      }
    }
    const region = t.regionAt(p.x, p.z);
    const label = name ?? (p.magic ? 'the Moonwell' : p.radius > 11 ? `the great lake of ${region?.name ?? 'the valley'}` : `a lake in ${region?.name ?? 'the wilds'}`);
    const existing = this.water.findIndex((wb) => wb.id === p.id);
    const body: WaterBody = { id: p.id, kind: p.magic ? 'spring' : 'lake', name: label, x: p.x, z: p.z, radius: p.radius, level: p.level, spots };
    if (existing >= 0) this.water[existing] = body;
    else this.water.push(body);
  }

  private buildWater(): void {
    const t = this.terrain;
    for (const p of t.ponds) this.addPondWater(p);
    // Rivers: split into reaches of ~24 m, each with drinking spots on both banks.
    for (const river of t.rivers) {
      const pts = river.points;
      let seg: DrinkSpot[] = [];
      let segStart = 0;
      let acc = 0;
      let reach = 0;
      const flush = (endIdx: number) => {
        const id = 1000 + river.id * 100 + reach++;
        const mid = pts[Math.floor((segStart + endIdx) / 2)]!;
        if (seg.length) {
          for (const sp of seg) sp.pondId = id;
          this.water.push({ id, kind: 'river', name: river.name, x: mid.x, z: mid.z, radius: 14, level: mid.level, spots: seg });
        }
        seg = [];
        segStart = endIdx;
        acc = 0;
      };
      for (let k = 1; k < pts.length; k++) {
        const p = pts[k]!;
        const q = pts[k - 1]!;
        if (p.level < 0.1) break;
        acc += Math.hypot(p.x - q.x, p.z - q.z);
        if (k % 2 === 0) {
          const tx = p.x - q.x;
          const tz = p.z - q.z;
          const tl = Math.hypot(tx, tz) || 1;
          const nx = -tz / tl;
          const nz = tx / tl;
          for (const side of [1, -1]) {
            for (let r = p.width; r < p.width + 5; r += 0.4) {
              const x = p.x + nx * r * side;
              const z = p.z + nz * r * side;
              if (!this.nav.walkable(x, z)) continue;
              if (this.nav.wade[this.nav.index(this.nav.cellX(x), this.nav.cellZ(z))]) continue;
              if (this.terrain.heightAt(x, z) > p.level + 1.4) break;
              seg.push({ id: this.spotId++, pondId: -1, x, z, wx: p.x + nx * (p.width * 0.4) * side, wz: p.z + nz * (p.width * 0.4) * side });
              break;
            }
          }
        }
        if (acc > 24) flush(k);
      }
      flush(pts.length - 1);
    }
  }

  waterBody(id: number): WaterBody | undefined {
    return this.water.find((w) => w.id === id);
  }

  // ---- Environment helpers ---------------------------------------------------

  rainAt(x: number, z: number): number {
    return this.weather.rainAt(x, z);
  }

  addWear(x: number, z: number, amount: number): void {
    const cx = Math.floor((x + WORLD_HALF) / WEAR_CELL);
    const cz = Math.floor((z + WORLD_HALF) / WEAR_CELL);
    if (cx < 0 || cz < 0 || cx >= WEAR_N || cz >= WEAR_N) return;
    const i = cz * WEAR_N + cx;
    this.wear[i] = Math.min(1, this.wear[i]! + amount * 0.5);
    this.wearDirty = true;
  }

  heightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }
}
