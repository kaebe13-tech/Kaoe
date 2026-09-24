import { Emitter } from '../core/events';
import { Rng } from '../core/rng';
import { SpatialHash } from '../core/spatialHash';
import { TAU, type V2 } from '../core/math';
import { Agent, randomAppearance, randomTraits } from '../agents/Agent';
import { makeName } from '../agents/names';
import { generateTerrain } from '../world/generateTerrain';
import { populateResources } from '../world/populate';
import type { Terrain } from '../world/Terrain';
import { DAY_LENGTH, HOUR, WORLD_HALF, WORLD_SIZE } from '../world/config';
import { NavGrid } from '../nav/NavGrid';
import { PathService } from '../nav/PathService';
import { Weather } from './weather';
import type { FeedEvent, FeedIcon, SimEvents } from './events';
import { BLUEPRINTS } from './blueprints';
import { emptyInventory, type DangerZone, type DrinkSpot, type ResourceNode, type ScorchMark, type Structure, type StructureKind, type WaterBody } from './types';

export const START_HOUR = 7;

export interface TribeStats {
  births: number;
  deaths: number;
  built: number;
  lightningStrikes: number;
}

/** All simulation state. Pure data + helpers; systems live in their own modules. */
export class World {
  readonly seed: number;
  readonly terrain: Terrain;
  readonly start: V2;
  readonly mountain: V2;
  readonly rng: Rng;
  readonly events = new Emitter<SimEvents>();
  readonly nav: NavGrid;
  readonly paths: PathService;
  readonly weather: Weather;

  /** Game seconds since the world began (day 1, 00:00). */
  time = START_HOUR * HOUR;
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
  /** Recent navigation trouble spots, for debugging and the soak test. */
  readonly stuckLog: Array<{ id: number; x: number; z: number; wx: number; wz: number; time: number; final: boolean }> = [];
  readonly stats: TribeStats = { births: 0, deaths: 0, built: 0, lightningStrikes: 0 };

  constructor(seed: number, options: { skipResources?: boolean } = {}) {
    this.seed = seed;
    this.rng = new Rng(seed ^ 0x51a7);
    const gen = generateTerrain(seed);
    this.terrain = gen.terrain;
    this.start = gen.start;
    this.mountain = gen.mountain;
    this.nav = new NavGrid(this.terrain);
    this.paths = new PathService(this.nav);
    this.weather = new Weather(seed);
    this.wear = new Float32Array(WORLD_SIZE * WORLD_SIZE);
    if (!options.skipResources) {
      for (const r of populateResources(this.terrain, seed, this.start)) this.insertResource(r);
    }
    // Resource ids come from the generator; keep new ids above them.
    let maxId = 0;
    for (const id of this.resources.keys()) maxId = Math.max(maxId, id);
    this.idCounter = maxId + 1;
    this.buildWater();
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

  get day(): number {
    return Math.floor(this.time / DAY_LENGTH) + 1;
  }

  get hour(): number {
    return (this.time % DAY_LENGTH) / HOUR;
  }

  get isNight(): boolean {
    const h = this.hour;
    return h < 5.5 || h >= 20.5;
  }

  /** 1 at midday, 0 at night, smooth at dawn/dusk. */
  get daylight(): number {
    const h = this.hour;
    if (h < 5 || h > 21) return 0;
    if (h < 7) return (h - 5) / 2;
    if (h > 19) return (21 - h) / 2;
    return 1;
  }

  clockString(time = this.time): string {
    const h = (time % DAY_LENGTH) / HOUR;
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    return `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
  }

  // ---- Feed ---------------------------------------------------------------

  log(text: string, icon: FeedIcon, importance: 1 | 2 | 3, at?: V2 | null, agentId?: number): void {
    const e: FeedEvent = { text, icon, importance, time: this.time };
    if (at) {
      e.x = at.x;
      e.z = at.z;
    }
    if (agentId !== undefined) e.agentId = agentId;
    this.feed.push(e);
    if (this.feed.length > 80) this.feed.shift();
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

  createStructure(kind: StructureKind, x: number, z: number, rot: number, founder: number): Structure {
    const bp = BLUEPRINTS[kind];
    const s: Structure = {
      id: this.nextId(),
      kind,
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

  addAgent(a: Agent): void {
    this.agents.push(a);
    this.agentHash.insert(a);
    this.events.emit('agentAdded', a);
  }

  spawnAgent(x: number, z: number, rng = this.rng): Agent {
    const taken = new Set(this.agents.map((a) => a.name));
    const a = new Agent(this.nextId(), makeName(rng, taken), x, z, randomTraits(rng), randomAppearance(rng), rng.int(17, 42));
    a.heading = rng.range(0, TAU);
    a.prevHeading = a.heading;
    this.addAgent(a);
    return a;
  }

  spawnTribe(count: number): void {
    const rng = this.rng;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + rng.range(-0.3, 0.3);
      const d = rng.range(1.5, 4);
      const p = this.nav.nearestWalkable(this.start.x + Math.cos(a) * d, this.start.z + Math.sin(a) * d, 8) ?? this.start;
      const agent = this.spawnAgent(p.x, p.z, rng);
      agent.needs.hunger = rng.range(0.55, 0.8);
      agent.needs.thirst = rng.range(0.5, 0.75);
      agent.needs.energy = rng.range(0.8, 0.95);
      agent.needs.social = rng.range(0.5, 0.8);
    }
    // Everyone arrived together: they start as acquaintances.
    for (const a of this.agents) for (const b of this.agents) if (a !== b) a.relations.set(b.id, rng.range(0.3, 0.5));
  }

  // ---- Water --------------------------------------------------------------

  private buildWater(): void {
    let spotId = 1;
    for (const p of this.terrain.ponds) {
      const spots: DrinkSpot[] = [];
      for (let k = 0; k < 36; k++) {
        const a = (k / 36) * TAU;
        const dx = Math.cos(a);
        const dz = Math.sin(a);
        for (let r = p.radius * 0.6; r < p.radius * 2.2; r += 0.3) {
          const x = p.x + dx * r;
          const z = p.z + dz * r;
          if (this.nav.walkable(x, z)) {
            // Only keep spots right at the water's edge.
            if (this.terrain.pondAt(x - dx * 1.4, z - dz * 1.4)) spots.push({ id: spotId++, pondId: p.id, x, z });
            break;
          }
        }
      }
      this.water.push({ id: p.id, x: p.x, z: p.z, radius: p.radius, level: p.level, spots });
    }
  }

  // ---- Environment helpers ---------------------------------------------------

  rainAt(x: number, z: number): number {
    return this.weather.rainAt(x, z);
  }

  addWear(x: number, z: number, amount: number): void {
    const cx = Math.floor(x + WORLD_HALF);
    const cz = Math.floor(z + WORLD_HALF);
    if (cx < 0 || cz < 0 || cx >= WORLD_SIZE || cz >= WORLD_SIZE) return;
    const i = cz * WORLD_SIZE + cx;
    this.wear[i] = Math.min(1, this.wear[i]! + amount);
    this.wearDirty = true;
  }

  heightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }
}
