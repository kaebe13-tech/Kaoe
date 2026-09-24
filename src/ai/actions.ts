import { clamp01, type V2 } from '../core/math';
import type { Agent, AnimState } from '../agents/Agent';
import type { World } from '../sim/World';
import { HOUR } from '../world/config';
import { BLUEPRINTS } from '../sim/blueprints';
import { deliverToSite, storeItems, takeItems, workOnSite } from '../sim/construction';
import { chooseSite, siteClear, storages } from '../sim/settlement';
import { adjustOpinion, civHistory } from '../civ/civSystem';
import { leaderMemory } from '../civ/leader';
import { LANDMARK_INFO } from '../world/biomes';
import { MATERIALS } from '../sim/types';
import {
  CARRY_CAPACITY,
  FOOD_ITEMS,
  ITEMS,
  describeItems,
  foodCount,
  inventoryWeight,
  isHarvestable,
  resourceLabel,
  resourceYield,
  type ItemType,
  type StructureKind,
} from '../sim/types';
import { Action, type ActionStatus } from './Action';
import { fulfilPromise, injectPlan, type Candidate } from './brainCore';
import { navigateTo, remainingDistance, stopNav } from './locomotion';
import { describePlace, plural, withArticle } from './describe';

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

export interface MoveOpts {
  arrive?: number;
  run?: boolean;
  /** Returns a failure reason if the trip should be abandoned. */
  valid?: () => string | null;
  /** Target moves (another agent): re-route when it drifts. */
  follow?: boolean;
}

export class MoveTo extends Action {
  private dest: V2 | null = null;
  private startDist = 1;
  private lastCheck = 0;

  constructor(
    private readonly where: () => V2 | null,
    private readonly what: string,
    private readonly opts: MoveOpts = {},
  ) {
    super();
  }

  get label(): string {
    return `${this.opts.run ? 'Running' : 'Walking'} to ${this.what}`;
  }

  override begin(a: Agent, w: World): ActionStatus | void {
    this.dest = this.where();
    if (!this.dest) return this.fail(`Couldn't locate ${this.what}`);
    navigateTo(a, w, this.dest, this.opts.arrive ?? 0.5, !!this.opts.run);
    this.startDist = Math.max(1, Math.hypot(this.dest.x - a.x, this.dest.z - a.z));
  }

  tick(a: Agent, w: World): ActionStatus {
    if (this.opts.valid) {
      const why = this.opts.valid();
      if (why) return this.fail(why);
    }
    if (this.opts.follow && w.time - this.lastCheck > 1.2) {
      this.lastCheck = w.time;
      const d = this.where();
      if (d && this.dest && Math.hypot(d.x - this.dest.x, d.z - this.dest.z) > 1.2) {
        this.dest = d;
        navigateTo(a, w, d, this.opts.arrive ?? 0.5, !!this.opts.run);
      }
    }
    const nav = a.nav;
    if (nav.status === 'arrived') return 'success';
    if (nav.status === 'failed') return this.fail(nav.failReason || 'Could not get there');
    if (nav.status === 'idle') {
      // Nav was reset externally (e.g. woken up); ask again.
      if (this.dest) navigateTo(a, w, this.dest, this.opts.arrive ?? 0.5, !!this.opts.run);
    }
    a.setAnim(a.speed > 2.8 ? 'run' : 'walk');
    this.progress = clamp01(1 - remainingDistance(a) / this.startDist);
    return 'running';
  }

  override finish(a: Agent, w: World, status: ActionStatus | 'aborted'): void {
    if (status !== 'success') stopNav(a, w);
    else a.nav.status = 'idle';
    if (a.anim === 'walk' || a.anim === 'run') a.setAnim('idle');
  }
}

/** Distance at which an agent can reach a resource. */
export function reachOf(kind: string, blockRadius: number): number {
  return (kind === 'tree' || kind === 'fruitTree' || kind === 'rock' || kind === 'crystal' ? blockRadius : 0.35) + 0.95;
}

/** Stand-off point next to a resource, on the side facing the agent. */
export function approachPoint(w: World, a: Agent, x: number, z: number, dist: number): V2 {
  const dx = a.x - x;
  const dz = a.z - z;
  const d = Math.hypot(dx, dz) || 1;
  for (let k = 0; k < 8; k++) {
    const ang = Math.atan2(dz / d, dx / d) + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 0.7;
    const px = x + Math.cos(ang) * dist;
    const pz = z + Math.sin(ang) * dist;
    if (w.nav.walkable(px, pz)) return { x: px, z: pz };
  }
  return w.nav.nearestWalkable(x, z, 5) ?? { x, z };
}

// ---------------------------------------------------------------------------
// Gathering & eating
// ---------------------------------------------------------------------------

export class Harvest extends Action {
  private timer = 0;
  private hits = 0;
  private count = 0;
  private readonly item: ItemType;

  constructor(
    private readonly resourceId: number,
    private readonly max: number,
    kindHint: ItemType,
  ) {
    super();
    this.item = kindHint;
  }

  get label(): string {
    if (this.item === 'wood') return `Chopping wood (${this.count}/${this.max})`;
    if (this.item === 'stone') return `Breaking stone (${this.count}/${this.max})`;
    if (this.item === 'crystal') return `Chipping crystal (${this.count}/${this.max})`;
    return `Picking ${ITEMS[this.item].plural} (${this.count}/${this.max})`;
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const r = w.resources.get(this.resourceId);
    if (!r) return this.fail('It was gone');
    if (r.burning > 0) return this.fail('It caught fire!');
    const mem = a.memory.resources.get(r.id);
    if (!isHarvestable(r)) {
      if (mem) {
        mem.amount = 0;
        mem.seenAt = w.time;
      }
      if (this.count > 0) return this.done(a);
      if (r.kind === 'tree') return this.fail(r.state === 'stump' ? 'Someone had already cut the tree down' : 'The tree could not be cut');
      if (r.kind === 'rock' || r.kind === 'crystal') return this.fail('There was nothing left to break off');
      return this.fail(r.claims > 1 ? 'Someone got there first — nothing left to pick' : 'Nothing left to pick');
    }
    const reach = reachOf(r.kind, r.blockRadius) + 0.35;
    if (Math.hypot(r.x - a.x, r.z - a.z) > reach) return this.fail('Could not reach it');
    const item = resourceYield(r)!;
    if (inventoryWeight(a.inventory) + ITEMS[item].weight > CARRY_CAPACITY + 1e-6) return this.done(a);
    a.focus = { x: r.x, z: r.z };
    const heavy = item === 'wood' || item === 'stone' || item === 'crystal';
    a.setAnim(item === 'wood' ? 'chop' : item === 'stone' || item === 'crystal' ? 'mine' : 'gather');
    const unit = item === 'wood' ? 2.6 : item === 'stone' ? 3.2 : item === 'crystal' ? 3.6 : item === 'fruit' ? 1.3 : 0.85;
    const tools = w.structures.some((s) => s.kind === 'workshop' && s.complete && s.settlementId === a.settlementId) ? 1.15 : 1;
    const pace = (a.has('industrious') ? 1.15 : 1) * (heavy ? tools : 1) * (a.blessedUntil > w.worldTime ? 1.25 : 1);
    this.timer += dt * pace;
    // Axe and pick swings land three times per unit; berries pop off one at a time.
    const swings = heavy ? 3 : 1;
    const hitAt = (unit / swings) * (this.hits + 1);
    if (this.timer >= hitAt) {
      this.hits++;
      r.lastUse = w.worldTime;
      w.events.emit('resourceHit', r);
      if (item === 'wood') {
        w.events.emit('sfx', { kind: 'chop', x: r.x, z: r.z });
        w.events.emit('fx', { kind: 'woodChips', x: r.x, z: r.z, y: 0.9 });
      } else if (item === 'stone' || item === 'crystal') {
        w.events.emit('sfx', { kind: 'mine', x: r.x, z: r.z });
        w.events.emit('fx', { kind: item === 'crystal' ? 'crystalShards' : 'stoneChips', x: r.x, z: r.z, y: 0.6 });
      } else {
        w.events.emit('sfx', { kind: 'gather', x: r.x, z: r.z });
        w.events.emit('fx', { kind: item === 'berries' ? 'berryPop' : 'leaves', x: r.x, z: r.z, y: item === 'fruit' ? 2.2 : 0.4 });
      }
    }
    if (this.timer >= unit) {
      this.timer -= unit;
      this.hits = 0;
      r.amount--;
      a.inventory[item]++;
      this.count++;
      if (item === 'wood') a.stats.woodChopped++;
      if (mem) {
        mem.amount = r.amount;
        mem.seenAt = w.time;
      }
      w.events.emit('resourceChanged', r);
      if (r.kind === 'tree' && r.amount <= 0) {
        const dx = r.x - a.x;
        const dz = r.z - a.z;
        const d = Math.hypot(dx, dz) || 1;
        r.regrow = 0;
        w.setResourceState(r, 'stump');
        w.events.emit('treeFelled', { resource: r, dirX: dx / d, dirZ: dz / d });
        w.events.emit('sfx', { kind: 'treeFall', x: r.x, z: r.z });
        a.addLog(w.time, 'event', `Felled ${withArticle(resourceLabel({ ...r, state: 'grown' }).toLowerCase())}.`);
      }
      if ((r.kind === 'rock' || r.kind === 'crystal') && r.amount <= 0) {
        r.regrow = 0;
        w.setResourceState(r, 'stump');
        w.events.emit('fx', { kind: r.kind === 'crystal' ? 'crystalShards' : 'dust', x: r.x, z: r.z, count: 10 });
      }
      if (this.count >= this.max || r.amount <= 0) return this.done(a);
    }
    this.progress = clamp01((this.count + this.timer / unit) / Math.max(1, this.max));
    return 'running';
  }

  private done(a: Agent): ActionStatus {
    this.summary = `Gathered ${plural(this.count, ITEMS[this.item].label, ITEMS[this.item].plural)}.`;
    a.setAnim('idle');
    return 'success';
  }
}

export class Eat extends Action {
  override interruptible = false;
  private timer = 0;
  private eaten: Partial<Record<ItemType, number>> = {};

  constructor(private readonly maxItems = 99) {
    super();
  }

  get label(): string {
    return 'Eating';
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const total = (this.eaten.berries ?? 0) + (this.eaten.fruit ?? 0) + (this.eaten.mushrooms ?? 0);
    if (a.needs.hunger >= 0.97 || total >= this.maxItems) return this.done();
    const deficit = 1 - a.needs.hunger;
    // Biggest item that doesn't waste much; otherwise whatever is left.
    let item: ItemType | null = null;
    for (const k of FOOD_ITEMS) if (a.inventory[k] > 0 && deficit >= ITEMS[k].food * 0.8) {
      item = k;
      break;
    }
    if (!item) for (const k of [...FOOD_ITEMS].reverse()) if (a.inventory[k] > 0) {
      item = k;
      break;
    }
    if (!item) return total > 0 ? this.done() : this.fail('Had no food to eat');
    a.setAnim('eat');
    this.timer += dt;
    if (this.timer >= 1.35) {
      this.timer = 0;
      a.inventory[item]--;
      a.needs.hunger = Math.min(1, a.needs.hunger + ITEMS[item].food);
      a.stats.foodEaten++;
      this.eaten[item] = (this.eaten[item] ?? 0) + 1;
      w.events.emit('sfx', { kind: 'eat', x: a.x, z: a.z, volume: 0.6 });
    }
    this.progress = a.needs.hunger;
    return 'running';
  }

  private done(): ActionStatus {
    this.summary = `Ate ${describeItems(this.eaten)}.`;
    return 'success';
  }
}

export class Drink extends Action {
  override interruptible = false;
  private splash = 0;

  constructor(
    private readonly pondCenter: V2,
    private readonly magic = false,
  ) {
    super();
  }

  get label(): string {
    return this.magic ? 'Drinking from the Moonwell' : 'Drinking';
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    a.focus = this.pondCenter;
    a.setAnim('drink');
    a.needs.thirst = Math.min(1, a.needs.thirst + dt * 0.24);
    if (this.magic) {
      // The Moonwell heals.
      a.needs.health = Math.min(1, a.needs.health + dt * 0.03);
      a.needs.safety = Math.min(1, a.needs.safety + dt * 0.02);
    }
    this.splash += dt;
    if (this.splash > 1.1) {
      this.splash = 0;
      const dx = this.pondCenter.x - a.x;
      const dz = this.pondCenter.z - a.z;
      const d = Math.hypot(dx, dz) || 1;
      w.events.emit('fx', { kind: 'splash', x: a.x + (dx / d) * 0.9, z: a.z + (dz / d) * 0.9 });
      w.events.emit('sfx', { kind: 'drink', x: a.x, z: a.z, volume: 0.5 });
    }
    this.progress = a.needs.thirst;
    if (a.needs.thirst >= 0.99) {
      this.summary = this.magic ? 'Drank from the Moonwell. It tasted of starlight.' : 'Drank until no longer thirsty.';
      if (this.magic) a.faith = Math.min(1, a.faith + 0.03);
      return 'success';
    }
    return 'running';
  }
}

export class CatchRain extends Action {
  override interruptible = false;
  get label(): string {
    return 'Drinking rainwater';
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const rain = w.rainAt(a.x, a.z);
    if (rain < 0.15) return a.needs.thirst > 0.6 ? 'success' : this.fail('The rain stopped');
    a.setAnim('catchRain');
    a.needs.thirst = Math.min(1, a.needs.thirst + dt * 0.1 * rain);
    this.progress = a.needs.thirst;
    if (a.needs.thirst >= 0.97) {
      this.summary = 'Drank rainwater from cupped hands.';
      return 'success';
    }
    return 'running';
  }
}

// ---------------------------------------------------------------------------
// Rest
// ---------------------------------------------------------------------------

export type SleepPlace = 'hut' | 'fire' | 'ground';

export class Sleep extends Action {
  private slept = 0;

  constructor(
    private readonly place: SleepPlace,
    private readonly structureId: number | null,
    private readonly collapse = false,
  ) {
    super();
    this.interruptible = false;
  }

  get label(): string {
    if (this.collapse) return 'Collapsed from exhaustion';
    return this.place === 'hut' ? 'Sleeping at home' : this.place === 'fire' ? 'Sleeping by the fire' : 'Sleeping on the ground';
  }

  override begin(a: Agent, w: World): void {
    if (this.place === 'hut' && this.structureId !== null && w.structure(this.structureId)) a.inside = this.structureId;
    if (this.collapse) {
      a.collapsed = true;
      w.log(`${a.name} collapsed from exhaustion!`, 'warning', 2, a, a.id);
    }
    a.setAnim('sleep');
    stopNav(a, w);
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    a.setAnim('sleep');
    const rain = a.inside !== null ? 0 : w.rainAt(a.x, a.z);
    const quality = (this.place === 'hut' && a.inside !== null ? 1 : this.place === 'fire' ? 0.8 : 0.62) * (1 - rain * 0.45);
    const hr = dt / HOUR;
    a.needs.energy = Math.min(1, a.needs.energy + hr * 0.115 * quality * (a.has('sleepy') ? 0.9 : 1));
    a.needs.health = Math.min(1, a.needs.health + hr * 0.03 * quality);
    this.slept += dt;
    this.progress = a.needs.energy;
    const h = w.hour;
    const daytime = h >= 6 && h < 20;
    if (this.collapse && a.needs.energy > 0.45) return this.wake(a, w);
    if (a.needs.energy >= 0.995 && h >= 5.8) return this.wake(a, w);
    if (daytime && a.needs.energy >= (a.has('sleepy') ? 0.85 : 0.72) && this.slept > HOUR * 0.5) return this.wake(a, w);
    return 'running';
  }

  private wake(a: Agent, w: World): ActionStatus {
    this.summary = `Woke up rested (energy ${Math.round(a.needs.energy * 100)}%).`;
    this.leave(a, w);
    return 'success';
  }

  private leave(a: Agent, w: World): void {
    if (a.inside !== null) {
      const hut = w.structure(a.inside);
      a.inside = null;
      if (hut) {
        const r = BLUEPRINTS[hut.kind].blockRadius + 0.6;
        const p = w.nav.nearestWalkable(hut.x + Math.sin(hut.rot) * r, hut.z + Math.cos(hut.rot) * r, 6);
        if (p) {
          a.x = a.prevX = p.x;
          a.z = a.prevZ = p.z;
          a.heading = hut.rot;
        }
      }
    }
    a.collapsed = false;
    a.setAnim('idle');
  }

  override finish(a: Agent, w: World): void {
    this.leave(a, w);
  }
}

export class Rest extends Action {
  private t = 0;

  constructor(
    private readonly duration: number,
    private readonly anim: AnimState = 'sit',
    private readonly text = 'Resting',
    private readonly facing: V2 | null = null,
  ) {
    super();
  }

  get label(): string {
    return this.text;
  }

  tick(a: Agent, _w: World, dt: number): ActionStatus {
    if (this.facing) a.focus = this.facing;
    a.setAnim(this.anim);
    this.t += dt;
    if (this.anim === 'sit') a.needs.energy = Math.min(1, a.needs.energy + (dt / HOUR) * 0.02);
    this.progress = clamp01(this.t / this.duration);
    return this.t >= this.duration ? 'success' : 'running';
  }

  override finish(a: Agent): void {
    if (a.anim === this.anim) a.setAnim('idle');
  }
}

export class SitByFire extends Action {
  private t = 0;
  private chatUntil = 0;
  private nextChat = 0;
  private chatWith: Agent | null = null;

  constructor(
    private readonly fireId: number,
    private readonly maxTime: number,
  ) {
    super();
  }

  get label(): string {
    return this.chatWith && this.t < this.chatUntil ? `Chatting with ${this.chatWith.name} by the fire` : 'Sitting by the campfire';
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const fire = w.structure(this.fireId);
    if (!fire) return this.fail('The campfire is gone');
    this.t += dt;
    if (this.nextChat === 0) this.nextChat = 4 + ((a.id * 13) % 11);
    // Now and then, turn to a neighbour and share a story.
    if (this.t >= this.nextChat) {
      this.nextChat = this.t + 12 + w.rng.range(0, 18);
      let neighbour: Agent | null = null;
      w.agentHash.query(a.x, a.z, 4, (o) => {
        if (o !== a && o.alive && (o.anim === 'sit' || o.anim === 'sitTalk') && !neighbour) neighbour = o;
      });
      if (neighbour) {
        const n: Agent = neighbour;
        this.chatWith = n;
        this.chatUntil = this.t + 4 + w.rng.range(0, 3);
        a.bond(n.id, 0.03);
        n.bond(a.id, 0.02);
        if (w.rng.chance(0.35)) {
          const told = shareKnowledge(w, a, n);
          if (told) n.addLog(w.time, 'learn', `${a.name} told me about ${told} by the fire.`);
        }
      }
    }
    if (this.chatWith && this.t < this.chatUntil) {
      a.focus = { x: this.chatWith.x, z: this.chatWith.z };
      a.setAnim('sitTalk');
    } else {
      a.focus = { x: fire.x, z: fire.z };
      a.setAnim('sit');
    }
    let company = 0;
    w.agentHash.query(fire.x, fire.z, 4.5, (o) => {
      if (o !== a && o.alive && (o.anim === 'sit' || o.anim === 'sitTalk')) company++;
    });
    const hr = dt / HOUR;
    a.needs.social = Math.min(1, a.needs.social + hr * (0.05 + Math.min(company, 4) * 0.06));
    a.needs.safety = Math.min(1, a.needs.safety + hr * 0.3);
    a.needs.energy = Math.min(1, a.needs.energy + hr * 0.015);
    this.progress = clamp01(this.t / this.maxTime);
    if (this.t >= this.maxTime) return 'success';
    if (!fire.lit && this.t > 8) {
      this.summary = 'The fire burned low, so left the circle.';
      return 'success';
    }
    return 'running';
  }

  override finish(a: Agent): void {
    if (a.anim === 'sit' || a.anim === 'sitTalk') a.setAnim('idle');
  }
}

// ---------------------------------------------------------------------------
// Settlement work
// ---------------------------------------------------------------------------

export class Deliver extends Action {
  override interruptible = false;
  private t = 0;
  constructor(
    private readonly siteId: number,
    private readonly item: ItemType,
  ) {
    super();
  }

  get label(): string {
    return `Delivering ${ITEMS[this.item].plural}`;
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const s = w.structure(this.siteId);
    if (!s) return this.fail('The building site is gone');
    a.focus = { x: s.x, z: s.z };
    a.setAnim('gather');
    this.t += dt;
    if (this.t < 0.8) return 'running';
    if (s.complete) {
      this.summary = 'Arrived, but the building was already finished.';
      return 'success';
    }
    const n = deliverToSite(w, s, a, this.item);
    fulfilPromise(a, w, n);
    this.summary = n > 0 ? `Delivered ${plural(n, ITEMS[this.item].label, ITEMS[this.item].plural)} to the ${BLUEPRINTS[s.kind].name.toLowerCase()}.` : 'The site already had enough.';
    return 'success';
  }

  override finish(a: Agent): void {
    a.setAnim('idle');
  }
}

export class Store extends Action {
  override interruptible = false;
  private t = 0;
  constructor(
    private readonly storageId: number,
    private readonly items: readonly ItemType[],
  ) {
    super();
  }

  get label(): string {
    return 'Storing supplies';
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const s = w.structure(this.storageId);
    if (!s) return this.fail('The storehouse is gone');
    a.focus = { x: s.x, z: s.z };
    a.setAnim('gather');
    this.t += dt;
    if (this.t < 0.9) return 'running';
    const before = { ...a.inventory };
    const n = storeItems(w, s, a, this.items);
    if (n <= 0) return this.fail('The storage was full');
    const moved: Partial<Record<ItemType, number>> = {};
    for (const k of this.items) moved[k] = before[k] - a.inventory[k];
    this.summary = `Stored ${describeItems(moved)} in the ${BLUEPRINTS[s.kind].name.toLowerCase()}.`;
    return 'success';
  }

  override finish(a: Agent): void {
    a.setAnim('idle');
  }
}

export class Withdraw extends Action {
  override interruptible = false;
  private t = 0;
  constructor(
    private readonly storageId: number,
    private readonly item: ItemType | 'food' | 'gift',
    private readonly count: number,
  ) {
    super();
  }

  get label(): string {
    return this.item === 'food' ? 'Taking food from storage' : this.item === 'gift' ? 'Packing gifts' : `Taking ${ITEMS[this.item].plural} from storage`;
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const s = w.structure(this.storageId);
    if (!s) return this.fail('The storehouse is gone');
    a.focus = { x: s.x, z: s.z };
    a.setAnim('gather');
    this.t += dt;
    if (this.t < 0.8) return 'running';
    let got = 0;
    const items: ItemType[] = this.item === 'food' ? [...FOOD_ITEMS] : this.item === 'gift' ? ['fruit', 'mushrooms', 'berries', 'stone', 'wood', 'crystal'] : [this.item];
    for (const k of items) {
      if (got >= this.count) break;
      const room = Math.floor((CARRY_CAPACITY - inventoryWeight(a.inventory)) / ITEMS[k].weight);
      got += takeItems(w, s, a, k, Math.min(this.count - got, room));
    }
    if (got <= 0) return this.fail('The storage was empty');
    this.summary = `Took ${got} ${this.item === 'food' ? 'food' : this.item === 'gift' ? 'gifts' : ITEMS[this.item].plural} from the ${BLUEPRINTS[s.kind].name.toLowerCase()}.`;
    return 'success';
  }

  override finish(a: Agent): void {
    a.setAnim('idle');
  }
}

export class Build extends Action {
  private hammer = 0;
  private celebrate = -1;

  constructor(private readonly siteId: number) {
    super();
  }

  get label(): string {
    return this.celebrate >= 0 ? 'Celebrating!' : 'Building';
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    if (this.celebrate >= 0) {
      this.celebrate += dt;
      a.setAnim('celebrate');
      return this.celebrate > 2.2 ? 'success' : 'running';
    }
    const s = w.structure(this.siteId);
    if (!s) return this.fail('The building site is gone');
    if (s.complete) return 'success';
    if (s.burning > 0) return this.fail('The site is on fire!');
    a.focus = { x: s.x, z: s.z };
    a.setAnim('build');
    const rate = a.has('industrious') ? 1.2 : 1;
    const res = workOnSite(w, s, a, dt * rate);
    this.progress = s.progress;
    this.hammer += dt;
    if (this.hammer > 0.62) {
      this.hammer = 0;
      w.events.emit('sfx', { kind: 'hammer', x: s.x, z: s.z, volume: 0.7 });
      if (w.rng.chance(0.35)) w.events.emit('fx', { kind: 'buildDust', x: (s.x + a.x) / 2, z: (s.z + a.z) / 2, count: 4 });
    }
    if (res === 'complete') {
      this.summary = `Helped finish the ${BLUEPRINTS[s.kind].name.toLowerCase()}!`;
      this.celebrate = 0;
      a.emote = { icon: 'star', until: w.time + 4 };
      a.needs.social = Math.min(1, a.needs.social + 0.1);
      return 'running';
    }
    if (res === 'blocked') {
      this.summary = `Built as far as the materials allowed (${Math.round(s.progress * 100)}%).`;
      return 'success';
    }
    if (a.needs.energy < 0.12) {
      this.summary = 'Too tired to keep building.';
      return 'success';
    }
    return 'running';
  }

  override finish(a: Agent): void {
    a.setAnim('idle');
  }
}

export class PlaceSite extends Action {
  constructor(
    private readonly kind: StructureKind,
    private spot: { x: number; z: number; rot: number },
    private readonly reason: string,
    private readonly sid: number,
  ) {
    super();
  }

  get label(): string {
    return `Marking out a ${BLUEPRINTS[this.kind].name.toLowerCase()}`;
  }

  tick(a: Agent, w: World): ActionStatus {
    if (w.structures.some((s) => s.kind === this.kind && !s.complete && s.settlementId === this.sid)) return this.fail('Someone else already started one');
    if (!siteClear(w, this.spot.x, this.spot.z, BLUEPRINTS[this.kind].radius)) {
      const alt = chooseSite(w, this.kind, this.sid, a);
      if (!alt) return this.fail('There was no clear ground');
      this.spot = alt;
    }
    const s = w.createStructure(this.kind, this.spot.x, this.spot.z, this.spot.rot, a.id, a.civId, this.sid);
    s.builders.push(a.id);
    const name = BLUEPRINTS[this.kind].name.toLowerCase();
    const civ = w.civOf(a);
    const big = this.kind === 'campfire' || this.kind === 'hall' || this.kind === 'monument' || this.kind === 'workshop';
    w.log(`${a.name}${civ ? ` of ${civ.name}` : ''} started building a ${name}. ${this.reason}.`, 'build', big ? 2 : 1, s, a.id);
    w.events.emit('fx', { kind: 'dust', x: s.x, z: s.z, count: 10 });
    this.summary = `Marked out a spot for a ${name}.`;
    return 'success';
  }
}

export class AddFuel extends Action {
  override interruptible = false;
  private t = 0;
  constructor(private readonly fireId: number) {
    super();
  }

  get label(): string {
    return 'Feeding the fire';
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const f = w.structure(this.fireId);
    if (!f) return this.fail('The campfire is gone');
    a.focus = { x: f.x, z: f.z };
    a.setAnim('gather');
    this.t += dt;
    if (this.t < 1.2) return 'running';
    const n = Math.min(a.inventory.wood, Math.ceil((1 - f.fuel) / 0.25));
    if (n <= 0) return this.fail('Had no wood left');
    a.inventory.wood -= n;
    f.fuel = Math.min(1, f.fuel + n * 0.25);
    w.events.emit('structureChanged', f);
    w.events.emit('fx', { kind: 'embers', x: f.x, z: f.z, y: 0.6 });
    this.summary = `Added ${plural(n, 'log', 'logs')} to the campfire.`;
    return 'success';
  }

  override finish(a: Agent): void {
    a.setAnim('idle');
  }
}

export class ShelterInside extends Action {
  constructor(private readonly hutId: number) {
    super();
  }

  get label(): string {
    return 'Waiting out the rain inside';
  }

  override begin(a: Agent, w: World): ActionStatus | void {
    if (!w.structure(this.hutId)) return this.fail('The hut is gone');
    a.inside = this.hutId;
    stopNav(a, w);
  }

  tick(_a: Agent, w: World): ActionStatus {
    const hut = w.structure(this.hutId);
    if (!hut) return this.fail('The hut is gone');
    if (w.rainAt(hut.x, hut.z) < 0.12) {
      this.summary = 'Stayed dry until the rain passed.';
      return 'success';
    }
    return 'running';
  }

  override finish(a: Agent, w: World): void {
    if (a.inside !== null) {
      const hut = w.structure(a.inside);
      a.inside = null;
      if (hut) {
        const r = BLUEPRINTS[hut.kind].blockRadius + 0.6;
        const p = w.nav.nearestWalkable(hut.x + Math.sin(hut.rot) * r, hut.z + Math.cos(hut.rot) * r, 6);
        if (p) {
          a.x = a.prevX = p.x;
          a.z = a.prevZ = p.z;
        }
      }
    }
  }
}

export class WaitUnderTree extends Action {
  get label(): string {
    return 'Sheltering under a tree';
  }

  tick(a: Agent, w: World): ActionStatus {
    a.setAnim('cower');
    if (w.rainAt(a.x, a.z) < 0.12) {
      this.summary = 'The rain stopped.';
      return 'success';
    }
    return 'running';
  }

  override finish(a: Agent): void {
    a.setAnim('idle');
  }
}

// ---------------------------------------------------------------------------
// Exploration
// ---------------------------------------------------------------------------

export type SearchFor = 'food' | 'water' | 'anything';

export class Search extends Action {
  private look = -1;
  private checkT = 0;

  constructor(
    private readonly what: SearchFor,
    private readonly dest: V2,
    private readonly found: () => boolean,
  ) {
    super();
  }

  get label(): string {
    if (this.look >= 0) return 'Looking around';
    return this.what === 'anything' ? 'Exploring' : `Searching for ${this.what}`;
  }

  override begin(a: Agent, w: World): void {
    navigateTo(a, w, this.dest, 1.5, false);
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    this.checkT += dt;
    if (this.checkT > 0.5 && this.what !== 'anything') {
      this.checkT = 0;
      if (this.found()) {
        this.summary = `Found ${this.what}!`;
        return 'success';
      }
    }
    if (this.look >= 0) {
      this.look += dt;
      a.setAnim('look');
      if (this.look > 2.5) {
        this.summary = this.what === 'anything' ? `Explored ${describePlace(w, a.x, a.z)}.` : `No ${this.what} here.`;
        return this.what === 'anything' || this.found() ? 'success' : this.fail(`Found no ${this.what} there`);
      }
      return 'running';
    }
    const nav = a.nav;
    if (nav.status === 'arrived') {
      this.look = 0;
      stopNav(a, w);
      return 'running';
    }
    if (nav.status === 'failed') return this.fail('Could not get there');
    if (nav.status === 'idle') navigateTo(a, w, this.dest, 1.5, false);
    a.setAnim('walk');
    return 'running';
  }

  override finish(a: Agent, w: World): void {
    stopNav(a, w);
    if (a.anim === 'walk' || a.anim === 'look') a.setAnim('idle');
  }
}

// ---------------------------------------------------------------------------
// Social
// ---------------------------------------------------------------------------

/** Start a conversation: the partner joins if they're free enough. */
export function invite(w: World, from: Agent, to: Agent, duration: number): boolean {
  if (!to.awake || to.inside !== null || to.civId !== from.civId) return false;
  const act = to.brain.active;
  if (act && (act.urgent || act.score > 0.52 || act.goal === 'chat' || act.goal === 'flee' || act.goal === 'help' || act.goal === 'pray')) return false;
  const step = act?.plan[act.step];
  if (step && !step.interruptible) return false;
  const cand: Candidate = {
    goal: 'chat',
    label: `Chat with ${from.name}`,
    icon: 'social',
    score: 0.5,
    reason: `${from.name} came over to talk`,
    targetLabel: from.name,
    target: { x: from.x, z: from.z },
    targetId: from.id,
    key: `chat:${from.id}`,
    thought: pickLine(to, [`Oh, hello ${from.name}!`, `${from.name}! What's new?`, `Good to see you, ${from.name}.`]),
    build: () => [new Talk(from.id, duration + 0.6, false)],
    onComplete: (ag, wd) => {
      ag.brain.cooldowns.set(`talk:${from.id}`, wd.time + 120);
      return `Had a good chat with ${from.name}.`;
    },
  };
  // Neither of them should turn right around and start the same conversation again.
  from.brain.cooldowns.set(`talk:${to.id}`, w.time + 120);
  injectPlan(to, w, cand);
  return true;
}

export function pickLine(a: Agent, lines: string[]): string {
  return lines[(a.id * 7 + Math.floor(a.stats.distance)) % lines.length]!;
}

export class Talk extends Action {
  override interruptible = false;
  private t = 0;
  private accepted = false;

  constructor(
    private readonly partnerId: number,
    private readonly duration: number,
    private readonly initiator: boolean,
  ) {
    super();
  }

  get label(): string {
    return 'Chatting';
  }

  override begin(a: Agent, w: World): ActionStatus | void {
    const p = w.agent(this.partnerId);
    if (!p || !p.alive) return this.fail('They were gone');
    if (this.initiator) {
      if (!invite(w, a, p, this.duration)) return this.fail(`${p.name} was too busy to talk`);
    }
    this.accepted = true;
    stopNav(a, w);
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const p = w.agent(this.partnerId);
    if (!p || !p.alive || !p.awake) return this.fail('The conversation was cut short');
    if (Math.hypot(p.x - a.x, p.z - a.z) > 3) return this.fail(`${p.name} walked away`);
    const pAct = p.brain.active;
    if (this.accepted && this.t > 0.5 && (!pAct || (pAct.goal !== 'chat' && pAct.goal !== 'socialize'))) {
      if (this.t >= this.duration * 0.7) return this.wrapUp(a, w, p);
      return this.fail(`${p.name} had to leave`);
    }
    a.focus = { x: p.x, z: p.z };
    a.setAnim('talk');
    this.t += dt;
    a.needs.social = Math.min(1, a.needs.social + dt * 0.035);
    if (this.t > 1 && Math.floor(this.t / 2.5) !== Math.floor((this.t - dt) / 2.5)) w.events.emit('sfx', { kind: 'talk', x: a.x, z: a.z, volume: 0.35 });
    this.progress = clamp01(this.t / this.duration);
    if (this.t >= this.duration) return this.wrapUp(a, w, p);
    return 'running';
  }

  private wrapUp(a: Agent, w: World, p: Agent): ActionStatus {
    if (this.initiator) finishConversation(w, a, p);
    this.summary = `Had a good chat with ${p.name}.`;
    return 'success';
  }

  override finish(a: Agent): void {
    a.setAnim('idle');
  }
}

/** Bond, and swap knowledge about food and water the other doesn't have. */
function finishConversation(w: World, a: Agent, b: Agent): void {
  a.bond(b.id, 0.08);
  b.bond(a.id, 0.08);
  a.stats.conversations++;
  b.stats.conversations++;
  const told = [shareKnowledge(w, a, b), shareKnowledge(w, b, a)];
  if (told[0]) b.addLog(w.time, 'learn', `${a.name} told me about ${told[0]}.`);
  if (told[1]) a.addLog(w.time, 'learn', `${b.name} told me about ${told[1]}.`);
  if (a.affinity(b.id) > 0.75 && b.affinity(a.id) > 0.75 && !a.relations.has(-b.id)) {
    a.relations.set(-b.id, 1); // marker: friendship noted
    b.relations.set(-a.id, 1);
    a.addLog(w.time, 'event', `${b.name} and I have become close friends.`);
    b.addLog(w.time, 'event', `${a.name} and I have become close friends.`);
    w.events.emit('fx', { kind: 'hearts', x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, y: 1.6 });
    // Only the first few friendships make the news; after that it's everyday life.
    if (w.stats.friendships++ < 4) w.log(`${a.name} and ${b.name} have become close friends.`, 'social', 1, a, a.id);
  }
}

export function shareKnowledge(w: World, from: Agent, to: Agent): string | null {
  const offers = [...from.memory.resources.values()].filter((m) => m.amount > 0 && !to.memory.resources.has(m.id) && m.kind !== 'tree');
  offers.sort((x, y) => (y.kind === 'fruitTree' ? 2 : 1) * y.amount - (x.kind === 'fruitTree' ? 2 : 1) * x.amount);
  let text: string | null = null;
  for (const m of offers.slice(0, 2)) {
    to.memory.rememberResource({ id: m.id, kind: m.kind, x: m.x, z: m.z, amount: m.amount, seenAt: m.seenAt, source: 'told' });
    text ??= `${m.kind === 'fruitTree' ? 'a fruit tree' : m.kind === 'mushroom' ? 'mushrooms' : m.kind === 'rock' ? 'good stone' : m.kind === 'crystal' ? 'crystal' : 'berries'} ${describePlace(w, m.x, m.z, false, to)}`;
  }
  for (const [id, wm] of from.memory.water) {
    if (!to.memory.water.has(id)) {
      to.memory.water.set(id, { ...wm });
      text ??= `fresh water ${describePlace(w, wm.x, wm.z, true, to)}`;
    }
  }
  return text;
}

export class Give extends Action {
  override interruptible = false;
  private t = 0;
  constructor(
    private readonly targetId: number,
    private readonly count: number,
  ) {
    super();
  }

  get label(): string {
    return 'Sharing food';
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const o = w.agent(this.targetId);
    if (!o || !o.alive) return this.fail('They were gone');
    if (Math.hypot(o.x - a.x, o.z - a.z) > 2.6) return this.fail(`Couldn't reach ${o.name}`);
    a.focus = { x: o.x, z: o.z };
    a.setAnim('gather');
    this.t += dt;
    if (this.t < 1) return 'running';
    let given = 0;
    for (const k of FOOD_ITEMS) {
      const n = Math.min(this.count - given, a.inventory[k]);
      if (n <= 0) continue;
      a.inventory[k] -= n;
      o.inventory[k] += n;
      given += n;
    }
    if (given <= 0) return this.fail('Had nothing to share');
    o.bond(a.id, 0.2);
    a.bond(o.id, 0.1);
    a.stats.helped++;
    o.brain.nextThink = w.time;
    o.addLog(w.time, 'event', `${a.name} shared food with me.`);
    w.log(`${a.name} brought food to ${o.name}.`, 'food', 2, o, a.id);
    w.events.emit('fx', { kind: 'hearts', x: o.x, z: o.z, y: 1.6 });
    this.summary = `Gave ${given} food to ${o.name}.`;
    return 'success';
  }

  override finish(a: Agent): void {
    a.setAnim('idle');
  }
}

export class Tend extends Action {
  override interruptible = false;
  private t = 0;
  constructor(
    private readonly targetId: number,
    private readonly duration: number,
  ) {
    super();
  }

  get label(): string {
    return 'Tending wounds';
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const o = w.agent(this.targetId);
    if (!o || !o.alive) return this.fail('Too late to help');
    if (Math.hypot(o.x - a.x, o.z - a.z) > 2.6) return this.fail(`${o.name} moved away`);
    a.focus = { x: o.x, z: o.z };
    a.setAnim('tend');
    this.t += dt;
    o.needs.health = Math.min(1, o.needs.health + dt * 0.012);
    o.needs.safety = Math.min(1, o.needs.safety + dt * 0.03);
    this.progress = clamp01(this.t / this.duration);
    if (this.t >= this.duration) {
      o.bond(a.id, 0.2);
      a.bond(o.id, 0.1);
      a.stats.helped++;
      o.addLog(w.time, 'event', `${a.name} tended to my wounds.`);
      w.log(`${a.name} tended to ${o.name}'s wounds.`, 'heal', 2, o, a.id);
      this.summary = `Tended to ${o.name}.`;
      return 'success';
    }
    return 'running';
  }

  override finish(a: Agent): void {
    a.setAnim('idle');
  }
}

// ---------------------------------------------------------------------------
// Danger
// ---------------------------------------------------------------------------

export function fleePoint(w: World, a: Agent, from: V2, dist: number, prefer?: V2): V2 | null {
  const away = Math.atan2(a.z - from.z, a.x - from.x);
  let best: V2 | null = null;
  let bestScore = -Infinity;
  for (let k = 0; k < 9; k++) {
    const ang = away + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 0.45;
    for (const dd of [dist, dist * 0.7]) {
      const x = a.x + Math.cos(ang) * dd;
      const z = a.z + Math.sin(ang) * dd;
      if (!w.nav.walkable(x, z)) continue;
      const fromD = Math.hypot(x - from.x, z - from.z);
      let score = fromD - Math.abs(k) * 0.4;
      if (prefer) score -= Math.hypot(x - prefer.x, z - prefer.z) * 0.15;
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
  }
  return best;
}

export class Cower extends Action {
  private t = 0;
  constructor(private readonly duration: number) {
    super();
  }

  get label(): string {
    return 'Catching breath';
  }

  tick(a: Agent, _w: World, dt: number): ActionStatus {
    a.setAnim('cower');
    this.t += dt;
    return this.t >= this.duration ? 'success' : 'running';
  }

  override finish(a: Agent): void {
    a.setAnim('idle');
  }
}

export function foodInHand(a: Agent): number {
  return foodCount(a.inventory);
}

// ---------------------------------------------------------------------------
// Faith & play
// ---------------------------------------------------------------------------

export class Pray extends Action {
  private t = 0;
  private glow = 0;

  constructor(
    private readonly shrineId: number,
    private readonly duration: number,
  ) {
    super();
  }

  get label(): string {
    return 'Praying at the shrine';
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const s = w.structure(this.shrineId);
    if (!s) return this.fail('The shrine is gone');
    a.focus = { x: s.x, z: s.z };
    a.setAnim('pray');
    this.t += dt;
    const hr = dt / HOUR;
    a.needs.safety = Math.min(1, a.needs.safety + hr * 0.9);
    a.needs.social = Math.min(1, a.needs.social + hr * 0.05);
    a.faith = Math.min(1, a.faith + hr * 0.03);
    this.glow += dt;
    if (this.glow > 3) {
      this.glow = 0;
      w.events.emit('fx', { kind: 'sparkle', x: s.x, z: s.z, y: 1.6, count: 3 });
    }
    this.progress = clamp01(this.t / this.duration);
    if (this.t >= this.duration) {
      this.summary = 'Prayed at the shrine and felt calmer.';
      return 'success';
    }
    return 'running';
  }

  override finish(a: Agent): void {
    if (a.anim === 'pray') a.setAnim('idle');
  }
}

/** Children dash about near a spot, pausing to jump and laugh. */
export class Play extends Action {
  private t = 0;
  private hop = 0;

  constructor(
    private readonly center: V2,
    private readonly duration: number,
    private readonly mateName: string | null,
  ) {
    super();
  }

  get label(): string {
    return this.mateName ? `Playing with ${this.mateName}` : 'Playing';
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    this.t += dt;
    a.needs.social = Math.min(1, a.needs.social + (dt / HOUR) * 0.12);
    if (this.hop > 0) {
      this.hop -= dt;
      a.setAnim('play');
      if (this.hop <= 0) this.next(a, w);
    } else if (a.nav.status === 'arrived' || a.nav.status === 'failed' || a.nav.status === 'idle') {
      this.hop = 0.6 + w.rng.range(0, 0.8);
      stopNav(a, w);
    } else a.setAnim('run');
    this.progress = clamp01(this.t / this.duration);
    if (this.t >= this.duration) {
      this.summary = this.mateName ? `Played with ${this.mateName}.` : 'Played for a while.';
      return 'success';
    }
    return 'running';
  }

  private next(a: Agent, w: World): void {
    const ang = w.rng.range(0, Math.PI * 2);
    const r = w.rng.range(1.5, 4);
    const p = w.nav.nearestWalkable(this.center.x + Math.cos(ang) * r, this.center.z + Math.sin(ang) * r, 3);
    if (p) navigateTo(a, w, p, 0.4, true);
  }

  override begin(a: Agent, w: World): void {
    this.next(a, w);
  }

  override finish(a: Agent, w: World): void {
    stopNav(a, w);
    a.setAnim('idle');
  }
}

// ---------------------------------------------------------------------------
// Civilization errands
// ---------------------------------------------------------------------------

/** Hand gifts to another people and speak for your leader. */
export class Envoy extends Action {
  override interruptible = false;
  private t = 0;
  constructor(
    private readonly civId: number,
    private readonly peace: boolean,
  ) {
    super();
  }

  get label(): string {
    return this.peace ? 'Speaking of peace' : 'Offering gifts';
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const mine = w.civOf(a);
    const other = w.civs[this.civId];
    if (!mine || !other) return this.fail('They were gone');
    a.setAnim(this.t < 2 ? 'wave' : 'talk');
    this.t += dt;
    if (this.t < 4) return 'running';
    let given = 0;
    const store = other.capital ? storages(w, other.capital.id)[0] : undefined;
    for (const k of [...FOOD_ITEMS, ...MATERIALS]) {
      const n = a.inventory[k];
      if (n <= 0) continue;
      a.inventory[k] -= n;
      if (store) store.stored[k] += n;
      given += n;
    }
    const warm = (this.peace ? 0.12 : 0.08) + Math.min(0.1, given * 0.012);
    adjustOpinion(w, other, mine, warm, `${a.name} of ${mine.name} came in peace${given ? ` bearing ${given} gifts` : ''}.`);
    adjustOpinion(w, mine, other, warm * 0.5, `${other.name} received our envoy ${a.name}.`);
    // They trade what they know of the land.
    for (let i = 0; i < mine.knowledge.map.length; i++) if (other.knowledge.map[i]) a.memory.explored[i] = Math.max(a.memory.explored[i]!, 1e-3);
    for (const id of other.knowledge.landmarks) if (!mine.knowledge.landmarks.has(id) && !a.news.some((n) => n.kind === 'landmark' && n.id === id)) a.news.push({ kind: 'landmark', id });
    const text = `${a.name} of ${mine.name} visited ${other.name} ${this.peace ? 'to make peace' : 'with gifts'}.`;
    w.log(text, 'social', 2, a, a.id);
    civHistory(w, mine, `${a.name} went to ${other.name} as our envoy${given ? ` with ${given} gifts` : ''}.`, 'relation', 2);
    civHistory(w, other, `${a.name}, an envoy of ${mine.name}, came ${this.peace ? 'seeking peace' : 'bearing gifts'}.`, 'relation', 2);
    leaderMemory(other, `${mine.name} sent ${a.name} to us ${this.peace ? 'to make peace' : 'with gifts'}.`, 2);
    w.events.emit('fx', { kind: 'hearts', x: a.x, z: a.z, y: 1.8, count: 6 });
    this.summary = `Delivered ${given} gifts to ${other.name}.`;
    return 'success';
  }

  override finish(a: Agent): void {
    a.setAnim('idle');
  }
}

/** Kneel at a wonder and pray. */
export class Worship extends Action {
  private t = 0;
  constructor(
    private readonly landmarkId: number,
    private readonly duration: number,
  ) {
    super();
  }

  get label(): string {
    return 'Worshipping';
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const l = w.terrain.landmarks.find((x) => x.id === this.landmarkId);
    if (!l) return this.fail('It was gone');
    a.focus = { x: l.x, z: l.z };
    a.setAnim('pray');
    this.t += dt;
    const hr = dt / HOUR;
    a.faith = Math.min(1, a.faith + hr * 0.25);
    a.needs.safety = Math.min(1, a.needs.safety + hr * 0.8);
    if (l.kind === 'spring') a.needs.health = Math.min(1, a.needs.health + dt * 0.01);
    this.progress = clamp01(this.t / this.duration);
    if (this.t >= this.duration) {
      const civ = w.civOf(a);
      if (civ) civ.rep.awe = Math.min(1, civ.rep.awe + 0.01);
      w.events.emit('fx', { kind: 'sparkle', x: a.x, z: a.z, y: 1.6, count: 6 });
      this.summary = `Prayed at ${l.name}. ${LANDMARK_INFO[l.kind].effect}`;
      return 'success';
    }
    return 'running';
  }

  override finish(a: Agent): void {
    if (a.anim === 'pray') a.setAnim('idle');
  }
}

/** The leader stands by the evening fire and speaks to the people. */
/** Kneel before the god who has come down among them. */
export class Behold extends Action {
  private t = 0;
  constructor(private readonly duration: number) {
    super();
  }

  get label(): string {
    return 'Kneeling before the god';
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const p = w.presence;
    if (!p || p.until < w.worldTime) {
      this.summary = 'The light faded. I will never forget it.';
      return 'success';
    }
    a.focus = { x: p.x, z: p.z };
    a.setAnim('pray');
    this.t += dt;
    const hr = dt / HOUR;
    a.faith = Math.min(1, a.faith + hr * 0.6);
    a.needs.safety = Math.min(1, a.needs.safety + hr * 0.6);
    a.needs.social = Math.min(1, a.needs.social + hr * 0.2);
    this.progress = clamp01(this.t / this.duration);
    if (this.t >= this.duration) {
      this.summary = 'Knelt before the god who walked among us.';
      return 'success';
    }
    return 'running';
  }

  override finish(a: Agent): void {
    if (a.anim === 'pray') a.setAnim('idle');
  }
}

export class Address extends Action {
  private t = 0;
  constructor(
    private readonly fireId: number,
    private readonly duration: number,
  ) {
    super();
  }

  get label(): string {
    return 'Speaking to the people';
  }

  tick(a: Agent, w: World, dt: number): ActionStatus {
    const fire = w.structure(this.fireId);
    if (!fire) return this.fail('The fire is gone');
    a.focus = { x: fire.x, z: fire.z };
    a.setAnim(Math.floor(this.t / 3) % 3 === 2 ? 'wave' : 'talk');
    this.t += dt;
    // Listeners by the fire feel heard.
    if (Math.floor(this.t) !== Math.floor(this.t - dt)) {
      w.agentHash.query(fire.x, fire.z, 5, (o) => {
        if (o !== a && o.alive && o.civId === a.civId && (o.anim === 'sit' || o.anim === 'sitTalk')) {
          o.needs.safety = Math.min(1, o.needs.safety + 0.01);
          o.bond(a.id, 0.004);
        }
      });
    }
    this.progress = clamp01(this.t / this.duration);
    return this.t >= this.duration || !fire.lit ? 'success' : 'running';
  }

  override finish(a: Agent): void {
    a.setAnim('idle');
  }
}
