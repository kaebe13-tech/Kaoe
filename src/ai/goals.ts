import { clamp01, smoothstep, type V2 } from '../core/math';
import { hash01 } from '../core/rng';
import type { Agent } from '../agents/Agent';
import type { World } from '../sim/World';
import { DAY_LENGTH, HOUR, MAP_N } from '../world/config';
import { BLUEPRINTS } from '../sim/blueprints';
import { EXPLORE_CELL, EXPLORE_N, EXPLORE_ORIGIN } from '../agents/Memory';
import {
  campfire,
  campCenter,
  chooseSite,
  doorSpot,
  fireSeat,
  isHome,
  nextProject,
  siteNeeds,
  sitesOf,
  storageRoom,
  storages,
  settlementFood,
  settlementStored,
  workSpot,
  allowedProgress,
  hasFreeBed,
} from '../sim/settlement';
import {
  CARRY_CAPACITY,
  FOOD_ITEMS,
  ITEMS,
  ITEM_SOURCE,
  foodCount,
  inventoryWeight,
  isHarvestable,
  isFoodKind,
  resourceLabel,
  type ItemType,
  type ResourceKind,
  type ResourceNode,
  type Structure,
} from '../sim/types';
import type { Civilization } from '../civ/Civilization';
import type { Priorities } from '../civ/cultures';
import { LANDMARK_INFO } from '../world/biomes';
import { onCooldown, type Candidate } from './brainCore';
import {
  AddFuel,
  Build,
  CatchRain,
  Cower,
  Deliver,
  Drink,
  Eat,
  Give,
  Harvest,
  MoveTo,
  PlaceSite,
  Rest,
  Search,
  ShelterInside,
  SitByFire,
  Sleep,
  Store,
  Talk,
  Tend,
  WaitUnderTree,
  Withdraw,
  Pray,
  Play,
  Envoy,
  Worship,
  Address,
  approachPoint,
  fleePoint,
  pickLine,
  reachOf,
} from './actions';
import { describePlace, pct, plural } from './describe';

export interface ThinkContext {
  now: number;
  hour: number;
  night: boolean;
  rain: number;
  /** The agent's settlement. */
  sid: number;
  civ: Civilization | undefined;
  camp: V2;
  fire: Structure | undefined;
  /** Settlement population. */
  pop: number;
  stores: Structure[];
  foodStored: number;
  /** Civilization priorities right now (culture x leader x objectives x divine effects). */
  focus: Priorities;
  isLeader: boolean;
  /** Fellow settlers (living). */
  mates: Agent[];
}

const NEUTRAL: Priorities = { build: 1, expand: 1, gather: 1, explore: 1, faith: 1, social: 1, defend: 1 };
const focusCache = new Map<number, { t: number; f: Priorities }>();

export function buildContext(a: Agent, w: World): ThinkContext {
  const sid = a.settlementId;
  const fire = campfire(w, sid);
  const civ = w.civOf(a);
  let focus = NEUTRAL;
  if (civ) {
    const c = focusCache.get(civ.id);
    if (c && Math.abs(c.t - w.worldTime) < 2) focus = c.f;
    else {
      focus = civ.focus(w.agent(civ.leaderId), w.worldTime);
      focusCache.set(civ.id, { t: w.worldTime, f: focus });
    }
  }
  const mates = civ ? civ.members.filter((o) => o.alive && o.settlementId === sid) : w.living;
  return {
    now: w.time,
    hour: w.hour,
    night: w.isNight,
    rain: a.inside !== null ? 0 : w.rainAt(a.x, a.z),
    sid,
    civ,
    camp: fire ? { x: fire.x, z: fire.z } : campCenter(w, sid),
    fire,
    pop: mates.length,
    stores: storages(w, sid),
    foodStored: settlementFood(w, sid),
    focus,
    isLeader: !!civ && civ.leaderId === a.id,
    mates,
  };
}

/** 0 while the need is fine, rising smoothly to 1 at `full`, and beyond when critical. */
export function needCurve(v: number, start: number, full: number): number {
  if (v >= start) return 0;
  const t = clamp01((start - v) / (start - full));
  const s = t * t * (3 - 2 * t);
  return s + (v < full ? ((full - v) / full) * 0.4 : 0);
}

/** Mild preference for closer options; urgency still dominates. */
function travel(d: number): number {
  return 1 - (Math.min(d, 120) / 120) * 0.32;
}

function dist(a: V2, b: V2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

type GoalFn = (a: Agent, w: World, ctx: ThinkContext) => Candidate | Candidate[] | null;

// ---------------------------------------------------------------------------
// Survival
// ---------------------------------------------------------------------------

const flee: GoalFn = (a, w, ctx) => {
  // Sleepers wake up for danger too (a burning hut, a strike next to them); the knocked-out can't.
  if (!a.alive || a.knocked > 0) return null;
  let threat: { x: number; z: number; kind: string; d: number } | null = null;
  const bias = a.has('timid') ? 4 : a.has('brave') ? -1.5 : 0;
  for (const d of w.dangers) {
    const dd = Math.hypot(d.x - a.x, d.z - a.z);
    if (dd < d.radius + bias && (!threat || dd < threat.d)) threat = { x: d.x, z: d.z, kind: d.kind, d: dd };
  }
  // Hostile strangers close by frighten the timid and the children.
  if (!threat && ctx.civ && (a.has('timid') || a.isChild || a.needs.safety < 0.35) && !a.has('brave')) {
    w.agentHash.query(a.x, a.z, 7, (o) => {
      if (o.civId === a.civId || o.civId < 0 || !o.alive) return;
      const st = ctx.civ!.relations.get(o.civId)?.state;
      if (st === 'hostile') {
        threat = { x: o.x, z: o.z, kind: 'hostile', d: Math.hypot(o.x - a.x, o.z - a.z) };
        return true;
      }
      return false;
    });
  }
  if (!threat) return null;
  const hostile = threat.kind === 'hostile';
  const campSafe = dist(ctx.camp, threat) > 16 ? ctx.camp : undefined;
  const pt = fleePoint(w, a, threat, 15 + (a.has('timid') ? 5 : 0), campSafe);
  if (!pt) return null;
  const reason = hostile ? 'Hostile strangers are too close' : threat.kind === 'fire' ? 'Fire is spreading nearby!' : threat.kind === 'quake' ? 'The ground is shaking!' : 'Something struck close by!';
  return {
    goal: 'flee',
    label: hostile ? 'Back away' : 'Escape danger',
    icon: 'warning',
    score: hostile ? 0.9 : 1.6,
    urgent: !hostile,
    reason,
    targetLabel: 'somewhere safe',
    target: pt,
    key: 'flee',
    thought: hostile ? pickLine(a, ["I don't like the look of them.", 'Best keep my distance.', 'Strangers. Walk away slowly.']) : threat.kind === 'fire' ? pickLine(a, ['Fire! Run!', 'The trees are burning, get away!', 'Too hot, too close!']) : pickLine(a, ['The sky is angry!', 'Run, run, run!', 'That was far too close...']),
    build: () => [new MoveTo(() => pt, 'safety', { run: true, arrive: 1.5 }), new Cower(2.5)],
  };
};

function nearestSpot(w: World, a: Agent, pondId: number): { spot: V2; pond: V2 } | null {
  const pond = w.waterBody(pondId);
  if (!pond || !pond.spots.length) return null;
  const sorted = [...pond.spots].sort((s1, s2) => dist(a, s1) - dist(a, s2)).slice(0, 4);
  // Among the few closest spots, prefer the least crowded one.
  let best = sorted[0]!;
  let bestCrowd = Infinity;
  for (const s of sorted) {
    let crowd = 0;
    w.agentHash.query(s.x, s.z, 1.2, (o) => {
      if (o !== a) crowd++;
    });
    const score = crowd * 3 + dist(a, s) * 0.05;
    if (score < bestCrowd) {
      bestCrowd = score;
      best = s;
    }
  }
  return { spot: best, pond: { x: best.wx, z: best.wz } };
}

const drink: GoalFn = (a, w, ctx) => {
  const u = needCurve(a.needs.thirst, 0.62, 0.14) * 1.25;
  if (u < 0.03) return null;
  const urgent = a.needs.thirst < 0.14;
  const reason = a.needs.thirst < 0.2 ? `Parched — thirst is critical (${pct(a.needs.thirst)})` : `Thirsty (${pct(a.needs.thirst)})`;
  const out: Candidate[] = [];
  if (ctx.rain > 0.4) {
    out.push({
      goal: 'drink',
      label: 'Quench thirst',
      icon: 'water',
      score: u + 0.08,
      urgent,
      reason: `${reason}, and it's raining`,
      targetLabel: 'rainwater',
      key: 'drink:rain',
      thought: pickLine(a, ['Fresh rain! Open wide.', 'The sky is giving us water.', 'Rain — just what I needed.']),
      build: () => [new CatchRain()],
    });
  }
  // A village well beats a long walk.
  const well = w.structures.find((st) => st.kind === 'well' && st.complete && st.settlementId === ctx.sid);
  if (well) {
    const d = dist(a, well);
    out.push({
      goal: 'drink',
      label: 'Quench thirst',
      icon: 'water',
      score: u * travel(d) * 1.05,
      urgent,
      reason: `${reason}. The well is close`,
      targetLabel: `The well (${Math.round(d)}m)`,
      target: well,
      key: 'drink:well',
      thought: pickLine(a, ['Water from the well.', 'Good thing we dug that well.']),
      build: () => [new MoveTo(() => workSpot(w, well, a.id), 'the well', { arrive: 0.4 }), new Drink({ x: well.x, z: well.z })],
    });
  }
  let best: { spot: V2; pond: V2; d: number; id: number } | null = null;
  for (const [pid, wm] of a.memory.water) {
    if (wm.avoidUntil > ctx.now || onCooldown(a, `drink:${pid}`, ctx.now)) continue;
    const s = nearestSpot(w, a, pid);
    if (!s) continue;
    const d = dist(a, s.spot);
    if (!best || d < best.d) best = { ...s, d, id: pid };
  }
  if (best) {
    const b = best;
    out.push({
      goal: 'drink',
      label: 'Quench thirst',
      icon: 'water',
      score: u * travel(b.d),
      urgent,
      reason,
      targetLabel: `Water ${describePlace(w, b.pond.x, b.pond.z, false, a)} (${Math.round(b.d)}m)`,
      target: b.spot,
      key: `drink:${b.id}`,
      thought: a.needs.thirst < 0.25 ? pickLine(a, ['So thirsty... need water now.', 'My throat is dry as sand.', 'Water. Now.']) : pickLine(a, ['A cool drink sounds good.', "I'll grab a drink.", 'Time for some water.']),
      build: () => [new MoveTo(() => b.spot, 'the water', { arrive: 0.35, run: a.needs.thirst < 0.15 }), new Drink(b.pond, w.waterBody(b.id)?.kind === 'spring')],
    });
  } else if (!out.length) {
    const dest = exploreTarget(a, w, 'water');
    if (dest) {
      out.push({
        goal: 'drink',
        label: 'Find water',
        icon: 'water',
        score: u * 0.92,
        urgent,
        reason: `${reason}, but no fresh water is known`,
        targetLabel: `unexplored land ${describePlace(w, dest.x, dest.z, false, a)}`,
        target: dest,
        key: 'drink:search',
        thought: pickLine(a, ['There must be fresh water somewhere...', 'I need to find a stream or a lake.', 'Where is the water in this land?']),
        build: () => [new Search('water', dest, () => a.memory.water.size > 0)],
      });
    }
  }
  return out;
};

interface FoodChoice {
  r: ResourceNode;
  d: number;
  est: number;
  item: ItemType;
  score: number;
}

/** Pick the most sensible remembered food source: plentiful, close, not crowded. */
export function bestFoodSource(a: Agent, w: World, need: number, only?: ItemType): FoodChoice | null {
  let best: FoodChoice | null = null;
  const now = w.time;
  for (const m of a.memory.resources.values()) {
    if (!isFoodKind(m.kind)) continue;
    const item: ItemType = m.kind === 'fruitTree' ? 'fruit' : m.kind === 'mushroom' ? 'mushrooms' : 'berries';
    if (only && item !== only) continue;
    if (m.avoidUntil > now || onCooldown(a, `eat:${m.id}`, now) || onCooldown(a, `food:${m.id}`, now)) continue;
    const r = w.resources.get(m.id);
    if (!r) continue;
    let est = m.amount;
    if (est <= 0) {
      const since = now - m.seenAt;
      est = Math.min(3, Math.floor(since / (HOUR * (item === 'fruit' ? 5 : item === 'mushrooms' ? 4 : 3))));
    }
    if (est <= 0) continue;
    const avail = est - r.claims * 2.5;
    const d = dist(a, m);
    const value = Math.max(0.3, Math.min(avail, need)) * ITEMS[item].food;
    const score = (value / (0.4 + d / 25)) * (avail <= 0 ? 0.35 : 1);
    if (!best || score > best.score) best = { r, d, est, item, score };
  }
  return best;
}

function foodTrip(a: Agent, w: World, src: FoodChoice, count: number): () => Array<MoveTo | Harvest> {
  const r = src.r;
  const startedAt = w.time;
  return () => [
    new MoveTo(() => approachPoint(w, a, r.x, r.z, reachOf(r.kind, r.blockRadius) - 0.25), resourceLabel(r).toLowerCase(), {
      arrive: 0.3,
      valid: () => {
        const m = a.memory.resources.get(r.id);
        if (m && m.amount <= 0 && m.seenAt > startedAt + 0.5 && !isHarvestable(r)) return 'Saw from afar that it had been picked clean';
        if (r.burning > 0) return 'It caught fire!';
        return null;
      },
    }),
    new Harvest(r.id, count, src.item),
  ];
}

const eat: GoalFn = (a, w, ctx) => {
  const start = a.has('glutton') ? 0.68 : 0.6;
  const u = needCurve(a.needs.hunger, start, 0.12) * 1.15;
  if (u < 0.03) return null;
  const urgent = a.needs.hunger < 0.12;
  const reason = a.needs.hunger < 0.2 ? `Starving — hunger is critical (${pct(a.needs.hunger)})` : `Hungry (${pct(a.needs.hunger)})`;
  const needItems = Math.max(1, Math.ceil((0.97 - a.needs.hunger) / ITEMS.berries.food));
  const out: Candidate[] = [];
  const carried = foodCount(a.inventory);
  const hungryLine = a.needs.hunger < 0.25 ? pickLine(a, ["I'm so hungry I could eat a tree.", 'My stomach is growling...', 'Food. Please. Anything.']) : '';
  if (carried > 0) {
    out.push({
      goal: 'eat',
      label: 'Eat',
      icon: 'food',
      score: u * 1.08 + 0.03,
      urgent,
      reason: `${reason}, and carrying food`,
      targetLabel: `${carried} food in hand`,
      key: 'eat:carried',
      thought: hungryLine || pickLine(a, ["Good thing I saved some food.", 'Snack time.', "I'll eat what I'm carrying."]),
      build: () => [new Eat()],
    });
  }
  if (ctx.foodStored > 0) {
    const s = ctx.stores.filter((st) => FOOD_ITEMS.some((k) => st.stored[k] > 0)).sort((x, y) => dist(a, x) - dist(a, y))[0];
    if (s) {
      const d = dist(a, s);
      out.push({
        goal: 'eat',
        label: 'Eat',
        icon: 'food',
        score: u * travel(d) * 1.04,
        urgent,
        reason: `${reason}. The ${BLUEPRINTS[s.kind].name.toLowerCase()} has food`,
        targetLabel: `${BLUEPRINTS[s.kind].name} (${Math.round(d)}m)`,
        target: s,
        key: `eat:store${s.id}`,
        thought: hungryLine || pickLine(a, ["There's food in the stores.", 'Our stash will do nicely.', "Glad we saved food for later."]),
        build: () => [new MoveTo(() => doorSpot(w, s), `the ${BLUEPRINTS[s.kind].name.toLowerCase()}`, { arrive: 0.5 }), new Withdraw(s.id, 'food', needItems), new Eat()],
      });
    }
  }
  const src = bestFoodSource(a, w, needItems);
  if (src) {
    const perItem = ITEMS[src.item].food;
    const count = Math.max(1, Math.ceil((0.97 - a.needs.hunger) / perItem)) + (a.has('glutton') ? 3 : 1);
    out.push({
      goal: 'eat',
      label: 'Find food',
      icon: 'food',
      score: u * travel(src.d),
      urgent,
      reason,
      targetLabel: `${resourceLabel(src.r)} ${describePlace(w, src.r.x, src.r.z, false, a)} (${Math.round(src.d)}m)`,
      target: src.r,
      targetId: src.r.id,
      key: `eat:${src.r.id}`,
      claims: { resource: src.r.id },
      thought:
        hungryLine ||
        (src.r.kind === 'fruitTree'
          ? pickLine(a, ['That fruit tree should have something ripe.', 'Sweet fruit, here I come.', 'I remember a fruit tree over there.'])
          : src.r.kind === 'mushroom'
            ? pickLine(a, ['Mushrooms under the old trees.', 'Those mushrooms should be ready.', 'Mushroom stew, maybe?'])
            : pickLine(a, ['Those berries should still be there.', "I know where there's a berry bush.", 'Berries would hit the spot.'])),
      build: () => [...foodTrip(a, w, src, count)(), new Eat()],
    });
  } else if (!carried && !ctx.foodStored) {
    const dest = exploreTarget(a, w, 'food');
    if (dest) {
      out.push({
        goal: 'eat',
        label: 'Search for food',
        icon: 'food',
        score: u * 0.9,
        urgent,
        reason: `${reason}, and knows of no food nearby`,
        targetLabel: `unexplored land ${describePlace(w, dest.x, dest.z, false, a)}`,
        target: dest,
        key: 'eat:search',
        thought: pickLine(a, ['There must be something to eat out there.', "I'll have to go looking for food.", 'Maybe the meadows have berries...']),
        build: () => [new Search('food', dest, () => bestFoodSource(a, w, 1) !== null)],
      });
    }
  }
  return out;
};

const sleep: GoalFn = (a, w, ctx) => {
  const e = a.needs.energy;
  if (e < 0.05) {
    return {
      goal: 'sleep',
      label: 'Collapse',
      icon: 'sleep',
      score: 2,
      urgent: true,
      reason: `Too exhausted to take another step (energy ${pct(e)})`,
      targetLabel: 'right here',
      key: 'sleep:collapse',
      thought: 'Can’t... go... on...',
      build: () => [new Sleep('ground', null, true)],
    };
  }
  let u = needCurve(e, 0.42, 0.06) * 1.1;
  const h = ctx.hour;
  const lateness = h >= 21 || h < 5 ? 1 : h >= 20 ? h - 20 : 0;
  if (lateness > 0) u += (0.62 + (a.has('sleepy') ? 0.1 : 0)) * lateness * (1 - smoothstep(0.93, 1.0, e));
  if (a.has('sleepy')) u *= 1.1;
  // Eat and drink before bed rather than waking up starving (unless about to drop).
  if (e > 0.15 && (a.needs.hunger < 0.42 || a.needs.thirst < 0.42)) u *= 0.62;
  if (u < 0.03) return null;
  const reason = e < 0.3 ? `Exhausted (energy ${pct(e)})` : lateness > 0 ? `It's late (${w.clockString()}) — time to rest` : `Tired (energy ${pct(e)})`;
  const home = w.structure(a.homeId);
  const nightLine = pickLine(a, ['What a day. Time to sleep.', 'My eyes are closing on their own.', 'Sleep now, work tomorrow.']);
  if (home && home.complete) {
    const d = dist(a, home);
    return {
      goal: 'sleep',
      label: 'Go to bed',
      icon: 'sleep',
      score: u * (1 - Math.min(d, 100) / 100 * 0.12),
      reason,
      targetLabel: `Home (${Math.round(d)}m)`,
      target: home,
      key: 'sleep:home',
      thought: pickLine(a, ['Home, sweet hut.', 'My own bed. Finally.', nightLine]),
      build: () => [new MoveTo(() => doorSpot(w, home), 'home', { arrive: 0.5 }), new Sleep('hut', home.id)],
    };
  }
  // Homeless: claim a free bed if there is one.
  const freeHut = a.isChild ? undefined : w.structures.find((s) => s.settlementId === ctx.sid && s.complete && hasFreeBed(w, s));
  if (freeHut) {
    return {
      goal: 'sleep',
      label: 'Go to bed',
      icon: 'sleep',
      score: u,
      reason: `${reason}. There's a free bed in a ${BLUEPRINTS[freeHut.kind].name.toLowerCase()}`,
      targetLabel: `A ${BLUEPRINTS[freeHut.kind].name.toLowerCase()} with a free bed`,
      target: freeHut,
      key: 'sleep:claim',
      thought: pickLine(a, ["There's room in that hut. I'll take it.", 'A real roof tonight!']),
      build: () => [
        new MoveTo(() => doorSpot(w, freeHut), `the ${BLUEPRINTS[freeHut.kind].name.toLowerCase()}`, { arrive: 0.5 }),
        new ClaimBed(freeHut.id),
        new Sleep('hut', freeHut.id),
      ],
    };
  }
  const fire = ctx.fire;
  if (fire && fire.complete) {
    const d = dist(a, fire);
    return {
      goal: 'sleep',
      label: 'Sleep by the fire',
      icon: 'sleep',
      score: u,
      reason: `${reason}. No home yet, so the fire will do`,
      targetLabel: `Campfire (${Math.round(d)}m)`,
      target: fire,
      key: 'sleep:fire',
      thought: pickLine(a, ["I'll sleep by the warm fire.", 'Sleeping under the stars again...', 'We really need a roof.']),
      build: () => [new MoveTo(() => fireSeat(w, fire, a.id), 'the campfire', { arrive: 0.4 }), new Sleep('fire', fire.id)],
    };
  }
  const d = dist(a, ctx.camp);
  return {
    goal: 'sleep',
    label: 'Sleep',
    icon: 'sleep',
    score: u,
    reason: `${reason}. There's no shelter at all`,
    targetLabel: d > 6 && d < 60 ? 'Near the others' : 'Right here',
    key: 'sleep:ground',
    thought: pickLine(a, ['The ground will have to do.', 'I miss having a roof.', nightLine]),
    build: () => (d > 6 && d < 60 ? [new MoveTo(() => w.nav.nearestWalkable(ctx.camp.x + (a.id % 5) - 2, ctx.camp.z + ((a.id * 3) % 5) - 2, 6), 'camp', { arrive: 1 }), new Sleep('ground', null)] : [new Sleep('ground', null)]),
  };
};

/** Take a bed in a hut that has room (becomes their home). */
class ClaimBed extends Rest {
  constructor(private readonly hutId: number) {
    super(0.2, 'idle', 'Claiming a bed');
  }

  override tick(a: Agent, w: World, dt: number) {
    const hut = w.structure(this.hutId);
    if (!hut) return this.fail('The home is gone');
    if (!hut.residents.includes(a.id)) {
      if (!hasFreeBed(w, hut)) return this.fail('Someone else took the last bed');
      hut.residents.push(a.id);
      a.homeId = hut.id;
      const mates = hut.residents.filter((id) => id !== a.id).map((id) => w.agent(id)?.name).filter(Boolean);
      const nm = BLUEPRINTS[hut.kind].name.toLowerCase();
      a.addLog(w.time, 'event', `Claimed a bed in the ${nm}${mates.length ? ` with ${mates.join(', ')}` : ''}.`);
      w.log(`${a.name} moved into a ${nm}${mates.length ? ` with ${mates.join(', ')}` : ''}.`, 'home', 1, hut, a.id);
    }
    return super.tick(a, w, dt);
  }
}

const shelter: GoalFn = (a, w, ctx) => {
  if (ctx.rain < 0.3 || !a.awake) return null;
  const u = 0.36 + ctx.rain * 0.2 + (a.has('timid') ? 0.1 : 0) - (a.has('brave') ? 0.05 : 0);
  const home = w.structure(a.homeId);
  const reason = `It's pouring (${pct(ctx.rain)} rain)`;
  if (home && home.complete && dist(a, home) < 60) {
    return {
      goal: 'shelter',
      label: 'Take shelter',
      icon: 'rain',
      score: u,
      reason,
      targetLabel: 'Home',
      target: home,
      key: 'shelter:home',
      thought: pickLine(a, ["I'm soaked! Home, quickly.", 'Let the rain pass, I’ll stay dry inside.', 'Brr, too wet out here.']),
      build: () => [new MoveTo(() => doorSpot(w, home), 'home', { arrive: 0.5, run: true }), new ShelterInside(home.id)],
    };
  }
  let tree: ResourceNode | null = null;
  let td = Infinity;
  w.resourceHash.query(a.x, a.z, 14, (r) => {
    if (r.kind !== 'tree' || r.state !== 'grown' || r.variant === 2) return;
    const d = dist(a, r);
    if (d < td) {
      td = d;
      tree = r;
    }
  });
  if (!tree) return null;
  const t: ResourceNode = tree;
  return {
    goal: 'shelter',
    label: 'Take shelter',
    icon: 'rain',
    score: u * 0.85,
    reason: `${reason} and there's no hut to hide in`,
    targetLabel: 'Under a big tree',
    target: t,
    key: `shelter:${t.id}`,
    thought: pickLine(a, ['That tree should keep the worst off.', 'Under the branches, quick!']),
    build: () => [new MoveTo(() => approachPoint(w, a, t.x, t.z, 1.1), 'a big tree', { arrive: 0.4, run: true }), new WaitUnderTree()],
  };
};

const comfort: GoalFn = (a, w, ctx) => {
  if (!a.awake) return null;
  let u = a.needs.safety < 0.55 ? (0.55 - a.needs.safety) * 1.3 : 0;
  const far = dist(a, ctx.camp) > 28;
  if (ctx.night && far && a.has('timid') && !a.brain.active?.key.startsWith('expedition')) u = Math.max(u, 0.32);
  if (u < 0.05) return null;
  const fire = ctx.fire;
  const reason = a.needs.safety < 0.4 ? `Shaken and scared (safety ${pct(a.needs.safety)})` : 'Nervous out here in the dark';
  if (fire && fire.complete) {
    return {
      goal: 'comfort',
      label: 'Seek comfort',
      icon: 'home',
      score: u,
      reason,
      targetLabel: 'The campfire',
      target: fire,
      key: 'comfort:fire',
      thought: pickLine(a, ["I'll feel safer by the fire.", 'I want to be near the others.', 'Back to camp. Now.']),
      build: () => [new MoveTo(() => fireSeat(w, fire, a.id), 'the campfire', { arrive: 0.4 }), new SitByFire(fire.id, 40)],
    };
  }
  return {
    goal: 'comfort',
    label: 'Seek comfort',
    icon: 'home',
    score: u,
    reason,
    targetLabel: 'Camp',
    target: ctx.camp,
    key: 'comfort:camp',
    thought: pickLine(a, ['Stay close to the others...', 'Safety in numbers.']),
    build: () => [new MoveTo(() => w.nav.nearestWalkable(ctx.camp.x + 1.5, ctx.camp.z + 1.5, 6), 'camp', { arrive: 1.5 }), new Rest(20, 'sit', 'Calming down')],
  };
};

const recover: GoalFn = (a, w, ctx) => {
  if (!a.awake || a.needs.health > 0.55 || a.needs.hunger < 0.2 || a.needs.thirst < 0.2) return null;
  const u = (0.6 - a.needs.health) * 1.5;
  const home = w.structure(a.homeId);
  const spot = home && home.complete ? doorSpot(w, home) : ctx.fire ? fireSeat(w, ctx.fire, a.id) : null;
  return {
    goal: 'recover',
    label: 'Recover',
    icon: 'heal',
    score: u,
    reason: `Hurt (health ${pct(a.needs.health)}) — needs rest`,
    targetLabel: spot ? (home ? 'Home' : 'The campfire') : 'Here',
    target: spot,
    key: 'recover',
    thought: pickLine(a, ['Ow... I need to lie down for a bit.', 'Everything hurts.', 'Rest first, then work.']),
    build: () => (spot ? [new MoveTo(() => spot, 'somewhere to rest', { arrive: 0.5 }), new Rest(40, 'sit', 'Resting to heal')] : [new Rest(40, 'sit', 'Resting to heal')]),
  };
};

// ---------------------------------------------------------------------------
// Social
// ---------------------------------------------------------------------------

const socialize: GoalFn = (a, w, ctx) => {
  if (!a.awake) return null;
  const out: Candidate[] = [];
  let u = needCurve(a.needs.social, 0.62, 0.12) * 0.72;
  if (a.has('sociable')) u *= 1.35;
  const fire = ctx.fire;
  if (fire && fire.complete && fire.lit && ctx.hour >= 18 && ctx.hour < 21.8 && ctx.rain < 0.3) {
    const ev = (0.3 + (a.has('sociable') ? 0.08 : 0) + (1 - a.needs.social) * 0.25) * Math.min(1.25, ctx.focus.social);
    const stay = Math.max(20, (21.8 - ctx.hour) * HOUR);
    if (ctx.isLeader && ctx.pop >= 4) {
      out.push({
        goal: 'socialize',
        label: 'Speak to the people',
        icon: 'fire',
        score: ev + 0.05,
        reason: 'The leader speaks at the evening fire',
        targetLabel: 'The campfire',
        target: fire,
        key: 'socialize:address',
        thought: pickLine(a, ['They look to me for answers. I had better have some.', 'Tonight I will tell them what comes next.', 'A leader must be heard.']),
        build: () => [new MoveTo(() => fireSeat(w, fire, a.id), 'the campfire', { arrive: 0.35 }), new Address(fire.id, Math.min(stay, HOUR * 0.8))],
        onComplete: (ag, wd) => {
          ag.brain.cooldowns.set('socialize:address', wd.time + DAY_LENGTH * 0.7);
          return 'Spoke to the people by the fire.';
        },
      });
    }
    out.push({
      goal: 'socialize',
      label: 'Gather at the campfire',
      icon: 'fire',
      score: Math.max(u, ev) * travel(dist(a, fire)),
      reason: 'Evening has come and the fire is lit',
      targetLabel: 'The campfire',
      target: fire,
      key: 'socialize:fire',
      thought: pickLine(a, ['Stories by the fire tonight!', 'Nothing like a warm fire after a long day.', "Let's see who's at the fire."]),
      build: () => [new MoveTo(() => fireSeat(w, fire, a.id), 'the campfire', { arrive: 0.35 }), new SitByFire(fire.id, stay)],
    });
  }
  // Even when not lonely, people strike up a chat with a friend who happens to be close by.
  const casual = ctx.night ? 0 : 0.1 + (a.has('sociable') ? 0.06 : 0);
  if (u < 0.05 && casual <= 0) return out;
  let best: Agent | null = null;
  let bestScore = -Infinity;
  for (const o of ctx.mates) {
    if (o === a || !o.alive || !o.awake || o.inside !== null) continue;
    if (onCooldown(a, `talk:${o.id}`, ctx.now)) continue;
    const d = dist(a, o);
    if (d > (u < 0.05 ? 12 : 40)) continue;
    const busy = o.brain.active && (o.brain.active.urgent || o.brain.active.score > 0.5);
    if (busy) continue;
    const s = a.affinity(o.id) * 0.6 + 0.4 - d / 60;
    if (s > bestScore) {
      bestScore = s;
      best = o;
    }
  }
  if (!best) return out;
  const p: Agent = best;
  const duration = 6 + hash01(a.id, Math.floor(ctx.now)) * 5;
  out.push({
    goal: 'socialize',
    label: `Chat with ${p.name}`,
    icon: 'social',
    score: Math.max(u * travel(dist(a, p)), casual + a.affinity(p.id) * 0.08),
    reason: a.needs.social < 0.3 ? `Lonely (social ${pct(a.needs.social)})` : u < 0.05 ? `${p.name} is close by` : `Wants some company (social ${pct(a.needs.social)})`,
    targetLabel: `${p.name} (${Math.round(dist(a, p))}m)`,
    target: p,
    targetId: p.id,
    key: `talk:${p.id}`,
    thought: a.affinity(p.id) > 0.7 ? pickLine(a, [`I wonder what ${p.name} has been up to.`, `${p.name} always cheers me up.`]) : pickLine(a, [`Maybe ${p.name} wants to talk.`, `I haven't talked to ${p.name} in a while.`, `Let's see how ${p.name} is doing.`]),
    build: () => [new MoveTo(() => ({ x: p.x, z: p.z }), p.name, { arrive: 1.4, follow: true }), new Talk(p.id, duration, true)],
    onComplete: (ag, wd) => {
      ag.brain.cooldowns.set(`talk:${p.id}`, wd.time + 120);
      return `Had a good chat with ${p.name}.`;
    },
  });
  return out;
};

const help: GoalFn = (a, w, ctx) => {
  if (!a.awake || a.needs.hunger < 0.3 || a.needs.thirst < 0.3 || a.needs.energy < 0.15) return null;
  let best: Candidate | null = null;
  const carried = foodCount(a.inventory);
  const kin = ctx.civ ? ctx.civ.members : w.agents;
  for (const o of kin) {
    if (o === a || !o.alive) continue;
    const d = dist(a, o);
    if (d > 55) continue;
    const key = `help:${o.id}`;
    if (onCooldown(a, key, ctx.now)) continue;
    if (kin.some((x) => x !== a && x.brain.active?.key === key)) continue;
    const kindB = a.has('kind') ? 0.15 : 0;
    // Starving and not already eating.
    if (o.needs.hunger < 0.2 && foodCount(o.inventory) === 0 && o.brain.active?.goal !== 'eat') {
      const canStore = ctx.foodStored > 0 ? ctx.stores.find((s) => FOOD_ITEMS.some((k) => s.stored[k] > 0)) : undefined;
      if (carried < 2 && !canStore) continue;
      const sev = (0.2 - o.needs.hunger) / 0.2;
      const score = (0.45 + sev * 0.3 + a.affinity(o.id) * 0.2 + kindB) * travel(d);
      if (!best || score > best.score) {
        const target = o;
        best = {
          goal: 'help',
          label: `Help ${o.name}`,
          icon: 'heart',
          score,
          reason: `${o.name} is starving (hunger ${pct(o.needs.hunger)})`,
          targetLabel: `${o.name} (${Math.round(d)}m)`,
          target: o,
          targetId: o.id,
          key,
          thought: pickLine(a, [`${o.name} looks starved. I'll bring food.`, `Nobody goes hungry while I have food.`, `Hold on, ${o.name}!`]),
          build: () => {
            const steps = [];
            if (carried < 2 && canStore) steps.push(new MoveTo(() => doorSpot(w, canStore), 'the stores', { arrive: 0.5 }), new Withdraw(canStore.id, 'food', 4));
            steps.push(new MoveTo(() => ({ x: target.x, z: target.z }), target.name, { arrive: 1.3, follow: true }), new Give(target.id, 4));
            return steps;
          },
          onComplete: (ag, wd) => {
            ag.brain.cooldowns.set(key, wd.time + 90);
          },
        };
      }
    }
    // Hurt or knocked down.
    if (o.needs.health < 0.45 || o.knocked > 0) {
      const score = (0.5 + (0.45 - o.needs.health) * 0.6 + a.affinity(o.id) * 0.2 + kindB + (a.has('brave') ? 0.1 : 0)) * travel(d);
      if (!best || score > best.score) {
        const target = o;
        best = {
          goal: 'help',
          label: `Help ${o.name}`,
          icon: 'heart',
          score,
          reason: `${o.name} is hurt (health ${pct(o.needs.health)})`,
          targetLabel: `${o.name} (${Math.round(d)}m)`,
          target: o,
          targetId: o.id,
          key,
          thought: pickLine(a, [`${o.name} is hurt! I'm coming!`, `Hang in there, ${o.name}.`, `I'll patch ${o.name} up.`]),
          build: () => [new MoveTo(() => ({ x: target.x, z: target.z }), target.name, { arrive: 1.2, follow: true, run: d > 8 }), new Tend(target.id, 10)],
          onComplete: (ag, wd) => {
            ag.brain.cooldowns.set(key, wd.time + 60);
          },
        };
      }
    }
  }
  return best;
};

// ---------------------------------------------------------------------------
// Work
// ---------------------------------------------------------------------------

function workBias(a: Agent): number {
  return (a.has('industrious') ? 0.1 : 0) - (a.has('sleepy') ? 0.05 : 0);
}

/** Civilization drive to build, gently scaled into utility space. */
function drive(v: number): number {
  return 0.75 + 0.25 * Math.min(1.8, v);
}

function nightWork(ctx: ThinkContext): number {
  if (ctx.night) return 0.35;
  if (ctx.hour >= 19.5) return 0.7;
  return 1;
}

const found: GoalFn = (a, w, ctx) => {
  if (!a.awake || ctx.night || a.needs.energy < 0.3 || !ctx.civ) return null;
  const proj = nextProject(w, ctx.sid, ctx.civ, ctx.focus);
  if (!proj) return null;
  if (ctx.mates.some((o) => o !== a && o.brain.active?.goal === 'found')) return null;
  const st = w.settlement(ctx.sid);
  const site = chooseSite(w, proj.kind, ctx.sid, proj.kind === 'campfire' && st ? { x: st.x, z: st.z } : undefined);
  if (!site) return null;
  const name = BLUEPRINTS[proj.kind].name.toLowerCase();
  const base = proj.kind === 'campfire' ? 0.58 : isHome({ kind: proj.kind } as Structure) ? 0.46 : 0.4;
  const d = dist(a, site);
  return {
    goal: 'found',
    label: `Start a ${name}`,
    icon: 'build',
    score: (base + workBias(a)) * travel(d * (proj.kind === 'campfire' ? 0.3 : 1)) * nightWork(ctx) * drive(ctx.focus.build),
    reason: proj.reason,
    targetLabel: `A clear spot ${describePlace(w, site.x, site.z, false, a)}`,
    target: site,
    key: `found:${proj.kind}`,
    thought:
      proj.kind === 'campfire'
        ? pickLine(a, ["We need a fire. I'll pick a good spot.", 'A campfire here would be perfect.', 'Fire first, then everything else.'])
        : isHome({ kind: proj.kind } as Structure)
          ? pickLine(a, [`Sleeping outside again? No. Let's build a ${name}.`, `I'll mark out a ${name} right there.`, 'A roof over our heads, that is the plan.'])
          : pickLine(a, [`We could really use a ${name}.`, `Time to start on a ${name}.`]),
    build: () => [new MoveTo(() => site, 'the building spot', { arrive: 1.4 }), new PlaceSite(proj.kind, site, proj.reason, ctx.sid)],
  };
};

/**
 * Nearest harvestable source of a material (trees for wood, boulders for stone, crystal clusters),
 * preferring ones on the way to `toward`. Falls back to remembered sources further away.
 */
function pickSource(a: Agent, w: World, item: ItemType, toward: V2 | null, radius = 45): ResourceNode | null {
  const kind: ResourceKind = ITEM_SOURCE[item];
  let best: ResourceNode | null = null;
  let bestS = Infinity;
  const consider = (t: ResourceNode) => {
    if (t.kind !== kind || !isHarvestable(t)) return;
    if (onCooldown(a, `tree:${t.id}`, w.time)) return;
    const crowd = t.claims > 0 && t.amount <= t.claims * 2 ? 12 : t.claims * 3;
    // Don't strip the forest right next to home when there's wood a little further out.
    const s = dist(a, t) + (toward ? dist(t, toward) * 0.7 : 0) + crowd;
    if (s < bestS) {
      bestS = s;
      best = t;
    }
  };
  w.resourceHash.query(a.x, a.z, radius, consider);
  if (!best) w.resourceHash.query(a.x, a.z, radius * 2, consider);
  if (!best && kind !== 'tree') {
    for (const m of a.memory.resources.values()) {
      if (m.kind !== kind || m.amount <= 0 || m.avoidUntil > w.time) continue;
      const r = w.resources.get(m.id);
      if (r) consider(r);
    }
  }
  return best;
}

function pickTree(a: Agent, w: World, toward: V2 | null, radius = 45): ResourceNode | null {
  return pickSource(a, w, 'wood', toward, radius);
}

function woodTrip(a: Agent, w: World, tree: ResourceNode, count: number, item: ItemType = 'wood'): Array<MoveTo | Harvest> {
  const gone = item === 'wood' ? 'Someone had already cut the tree down' : item === 'stone' ? 'The boulder was already broken up' : 'The crystal was already taken';
  return [
    new MoveTo(() => approachPoint(w, a, tree.x, tree.z, reachOf(tree.kind, tree.blockRadius) - 0.25), resourceLabel(tree).toLowerCase(), {
      arrive: 0.3,
      valid: () => (tree.state !== 'grown' || tree.amount <= 0 ? gone : tree.burning > 0 ? 'It caught fire!' : null),
    }),
    new Harvest(tree.id, count, item),
  ];
}

const supply: GoalFn = (a, w, ctx) => {
  if (!a.awake) return null;
  const sites = sitesOf(w, ctx.sid).filter((s) => s.burning <= 0);
  if (!sites.length) return null;
  let best: Candidate | null = null;
  for (const s of sites) {
    const needs = siteNeeds(s);
    const item = (Object.keys(needs) as ItemType[]).find((k) => (needs[k] ?? 0) > 0);
    if (!item) continue;
    const need = needs[item]!;
    const name = BLUEPRINTS[s.kind].name.toLowerCase();
    const age = Math.min(0.08, (ctx.now - s.foundedAt) / (HOUR * 6) * 0.08);
    const base = (0.36 + workBias(a) + age + (s.foundedBy === a.id ? 0.04 : 0) + (s.kind === 'campfire' ? 0.08 : 0)) * drive(ctx.focus.build);
    const reason = `The ${name} needs ${plural(need, ITEMS[item].label, ITEMS[item].plural)} more`;
    const spot = () => workSpot(w, s, a.id);
    let cand: Candidate | null = null;
    if (a.inventory[item] > 0) {
      const n = Math.min(a.inventory[item], need);
      cand = {
        goal: 'supply',
        label: `Deliver ${ITEMS[item].plural}`,
        icon: item === 'wood' ? 'wood' : 'food',
        score: (base + 0.12) * travel(dist(a, s)) * nightWork(ctx),
        reason,
        targetLabel: `${BLUEPRINTS[s.kind].name} site (${Math.round(dist(a, s))}m)`,
        target: s,
        targetId: s.id,
        key: `supply:${s.id}`,
        claims: { site: { id: s.id, item, promised: n } },
        thought: pickLine(a, ['Got the goods, heading to the site.', "Let's get these to the builders.", 'One more load for the site.']),
        build: () => [new MoveTo(spot, `the ${name} site`, { arrive: 0.5 }), new Deliver(s.id, item)],
      };
    } else if (item === 'wood' || item === 'stone' || item === 'crystal') {
      // Stored materials first; otherwise go and get some.
      const store = ctx.stores.find((st) => st.stored[item] > 0);
      if (store) {
        const n = Math.min(need, store.stored[item], Math.floor((CARRY_CAPACITY - inventoryWeight(a.inventory)) / ITEMS[item].weight));
        if (n > 0) {
          cand = {
            goal: 'supply',
            label: `Fetch ${ITEMS[item].plural}`,
            icon: item === 'wood' ? 'wood' : 'build',
            score: (base + 0.04) * travel(dist(a, store) + dist(store, s)) * nightWork(ctx),
            reason: `${reason}, and the ${BLUEPRINTS[store.kind].name.toLowerCase()} has some`,
            targetLabel: `${BLUEPRINTS[store.kind].name} → ${BLUEPRINTS[s.kind].name}`,
            target: store,
            targetId: s.id,
            key: `supply:${s.id}:store`,
            claims: { site: { id: s.id, item, promised: n } },
            thought: pickLine(a, ['There is some in the stores.', 'No need to go far, we have some stored.']),
            build: () => [new MoveTo(() => doorSpot(w, store), `the ${BLUEPRINTS[store.kind].name.toLowerCase()}`, { arrive: 0.5 }), new Withdraw(store.id, item, n), new MoveTo(spot, `the ${name} site`, { arrive: 0.5 }), new Deliver(s.id, item)],
          };
        }
      }
      const tree = cand ? null : pickSource(a, w, item, s, item === 'wood' ? 45 : 60);
      if (tree) {
        const room = Math.floor((CARRY_CAPACITY - inventoryWeight(a.inventory)) / ITEMS[item].weight);
        const n = Math.max(1, Math.min(need, room, tree.amount));
        const d = dist(a, tree) + dist(tree, s);
        const verb = item === 'wood' ? 'Gather wood' : item === 'stone' ? 'Quarry stone' : 'Mine crystal';
        cand = {
          goal: 'supply',
          label: verb,
          icon: item === 'wood' ? 'wood' : 'build',
          score: base * travel(d * 0.8) * nightWork(ctx),
          reason,
          targetLabel: `${resourceLabel(tree)} ${describePlace(w, tree.x, tree.z, false, a)} → ${BLUEPRINTS[s.kind].name}`,
          target: tree,
          targetId: tree.id,
          key: `supply:${s.id}:${tree.id}`,
          claims: { resource: tree.id, site: { id: s.id, item, promised: n } },
          thought:
            item === 'wood'
              ? pickLine(a, ['That tree will make good logs.', `We need wood for the ${name}.`, 'Time to swing the axe.', "I'll fetch some logs."])
              : item === 'stone'
                ? pickLine(a, ['Stone for the walls.', 'That boulder will split nicely.', `The ${name} needs good stone.`])
                : pickLine(a, ['The crystal hums when you touch it.', 'Careful... these shards are sharp.']),
          build: () => [...woodTrip(a, w, tree, n, item), new MoveTo(spot, `the ${name} site`, { arrive: 0.5 }), new Deliver(s.id, item)],
        };
      }
    } else {
      const src = bestFoodSource(a, w, need, item);
      if (src) {
        const n = Math.min(need, Math.max(1, src.est));
        cand = {
          goal: 'supply',
          label: `Gather ${ITEMS[item].plural}`,
          icon: 'food',
          score: base * travel(src.d) * nightWork(ctx),
          reason,
          targetLabel: `${resourceLabel(src.r)} ${describePlace(w, src.r.x, src.r.z, false, a)} → ${BLUEPRINTS[s.kind].name}`,
          target: src.r,
          targetId: src.r.id,
          key: `supply:${s.id}:${src.r.id}`,
          claims: { resource: src.r.id, site: { id: s.id, item, promised: n } },
          thought: pickLine(a, ['Seeds for the garden — berries it is.', 'The garden needs berries to plant.']),
          build: () => [...foodTrip(a, w, src, n)(), new MoveTo(spot, `the ${name} site`, { arrive: 0.5 }), new Deliver(s.id, item)],
        };
      }
    }
    if (cand && (!best || cand.score > best.score)) best = cand;
  }
  return best;
};

const construct: GoalFn = (a, w, ctx) => {
  if (!a.awake || a.needs.energy < 0.15) return null;
  let best: Candidate | null = null;
  for (const s of sitesOf(w, ctx.sid)) {
    if (s.burning > 0 || allowedProgress(s) <= s.progress + 1e-4) continue;
    const name = BLUEPRINTS[s.kind].name.toLowerCase();
    const d = dist(a, s);
    const helpers = ctx.mates.filter((o) => o !== a && o.brain.active?.goal === 'construct' && o.brain.active.targetId === s.id).length;
    const score = (0.44 + workBias(a) + (s.foundedBy === a.id ? 0.05 : 0) - helpers * 0.03) * travel(d) * nightWork(ctx) * drive(ctx.focus.build);
    const founder = w.agent(s.foundedBy);
    const reason = founder && founder !== a && founder.alive ? `Helping ${founder.name} build the ${name} (${pct(s.progress)} done)` : `Materials are ready for the ${name} (${pct(s.progress)} done)`;
    if (!best || score > best.score) {
      best = {
        goal: 'construct',
        label: `Build the ${name}`,
        icon: 'hammer',
        score,
        reason,
        targetLabel: `${BLUEPRINTS[s.kind].name} site (${Math.round(d)}m)`,
        target: s,
        targetId: s.id,
        key: `construct:${s.id}`,
        thought: pickLine(a, ['Hammer, hammer, hammer.', `This ${name} is going to be great.`, 'One beam at a time.', `Almost there... the ${name} is taking shape.`]),
        build: () => [new MoveTo(() => workSpot(w, s, a.id), `the ${name} site`, { arrive: 0.45 }), new Build(s.id)],
      };
    }
  }
  return best;
};

const haul: GoalFn = (a, w, ctx) => {
  if (!a.awake || ctx.night) return null;
  const stores = ctx.stores.filter((s) => storageRoom(s) > 0);
  if (!stores.length) return null;
  const store = stores.sort((x, y) => dist(a, x) - dist(a, y))[0]!;
  const name = BLUEPRINTS[store.kind].name.toLowerCase();
  const door = () => doorSpot(w, store);
  const food = foodCount(a.inventory);
  const siteNeedsWood = sitesOf(w, ctx.sid).some((s) => (siteNeeds(s).wood ?? 0) > 0);
  const gather = drive(ctx.focus.gather);
  if (food >= 5 && a.needs.hunger > 0.75) {
    return {
      goal: 'haul',
      label: 'Store food',
      icon: 'food',
      score: 0.3 + workBias(a) * 0.5,
      reason: `Carrying ${food} food the others could use later`,
      targetLabel: `The ${name}`,
      target: store,
      key: `haul:store:${store.id}`,
      thought: pickLine(a, ["I'll put this in the stores for later.", 'Saving some for a rainy day.']),
      build: () => [new MoveTo(door, `the ${name}`, { arrive: 0.5 }), new Store(store.id, FOOD_ITEMS)],
    };
  }
  if ((a.inventory.wood > 0 && !siteNeedsWood) || a.inventory.stone > 0 || a.inventory.crystal > 0) {
    const what = a.inventory.crystal > 0 ? 'crystal' : a.inventory.stone > 0 ? 'stone' : 'logs';
    return {
      goal: 'haul',
      label: 'Store materials',
      icon: 'wood',
      score: 0.26,
      reason: `Carrying spare ${what}`,
      targetLabel: `The ${name}`,
      target: store,
      key: `haul:wood:${store.id}`,
      build: () => [new MoveTo(door, `the ${name}`, { arrive: 0.5 }), new Store(store.id, ['wood', 'stone', 'crystal'])],
    };
  }
  const perCap = ctx.foodStored / Math.max(1, ctx.pop);
  if (perCap < 4 && store.kind === 'storage') {
    const src = bestFoodSource(a, w, 8);
    if (src && src.est >= 3) {
      const room = Math.floor((CARRY_CAPACITY - inventoryWeight(a.inventory)) / ITEMS[src.item].weight);
      const n = Math.max(2, Math.min(room, src.est, 14));
      return {
        goal: 'haul',
        label: 'Stock up food',
        icon: 'food',
        score: (0.24 + workBias(a) + (4 - perCap) * 0.015) * travel(src.d + dist(src.r, store)) * gather,
        reason: `The stores hold only ${ctx.foodStored} food for ${ctx.pop} people`,
        targetLabel: `${resourceLabel(src.r)} ${describePlace(w, src.r.x, src.r.z, false, a)} → ${BLUEPRINTS[store.kind].name}`,
        target: src.r,
        targetId: src.r.id,
        key: `haul:food:${src.r.id}`,
        claims: { resource: src.r.id },
        thought: pickLine(a, ["Let's fill the stores while the picking is good.", 'A full storehouse means nobody goes hungry.']),
        build: () => [...foodTrip(a, w, src, n)(), new MoveTo(door, `the ${name}`, { arrive: 0.5 }), new Store(store.id, FOOD_ITEMS)],
      };
    }
  }
  const wantStone = ctx.civ?.objectives.some((o) => o.kind === 'GATHER_MATERIALS') || sitesOf(w, ctx.sid).some((st) => (siteNeeds(st).stone ?? 0) > 0);
  if (store.kind === 'storage' && wantStone && settlementStored(w, ctx.sid, 'stone') < 10) {
    const rock = pickSource(a, w, 'stone', store, 60);
    if (rock) {
      const n = Math.min(rock.amount, 3);
      return {
        goal: 'haul',
        label: 'Quarry stone',
        icon: 'build',
        score: (0.2 + workBias(a)) * drive(ctx.focus.build) * travel(dist(a, rock) + dist(rock, store)),
        reason: 'The builders need stone',
        targetLabel: `${resourceLabel(rock)} → ${BLUEPRINTS[store.kind].name}`,
        target: rock,
        targetId: rock.id,
        key: `haul:stone:${rock.id}`,
        claims: { resource: rock.id },
        thought: pickLine(a, ['Stone for the builders.', 'Heavy work, but someone has to do it.']),
        build: () => [...woodTrip(a, w, rock, n, 'stone'), new MoveTo(door, `the ${name}`, { arrive: 0.5 }), new Store(store.id, ['stone'])],
      };
    }
  }
  if (store.kind === 'storage' && settlementStored(w, ctx.sid, 'wood') < 6 && !siteNeedsWood) {
    const tree = pickTree(a, w, store, 35);
    if (tree) {
      const n = Math.min(tree.amount, 4);
      return {
        goal: 'haul',
        label: 'Stockpile wood',
        icon: 'wood',
        score: 0.17 + workBias(a),
        reason: 'The woodpile is low',
        targetLabel: `${resourceLabel(tree)} → ${BLUEPRINTS[store.kind].name}`,
        target: tree,
        targetId: tree.id,
        key: `haul:wood:${tree.id}`,
        claims: { resource: tree.id },
        thought: pickLine(a, ['Firewood for the cold nights.', 'Always good to have wood stacked.']),
        build: () => [...woodTrip(a, w, tree, n), new MoveTo(door, `the ${name}`, { arrive: 0.5 }), new Store(store.id, ['wood'])],
      };
    }
  }
  return null;
};

const tendFire: GoalFn = (a, w, ctx) => {
  const fire = ctx.fire;
  if (!a.awake || !fire || !fire.complete || fire.fuel > 0.45) return null;
  const h = ctx.hour;
  const evening = h >= 15 && h < 22.5;
  if (!evening && fire.fuel > 0.1) return null;
  if (ctx.mates.some((o) => o !== a && o.brain.active?.goal === 'tendFire')) return null;
  const score = 0.34 + (1 - fire.fuel) * 0.15 + (h >= 17 ? 0.08 : 0) + workBias(a) * 0.5;
  const reason = `The campfire is burning low (${pct(fire.fuel)} fuel)`;
  const seat = () => fireSeat(w, fire, a.id);
  const base = {
    goal: 'tendFire' as const,
    label: 'Tend the fire',
    icon: 'fire' as const,
    reason,
    target: fire,
    key: 'tendFire',
    thought: pickLine(a, ["The fire's getting low. I'll add some logs.", "Can't let the fire die before nightfall.", 'More wood for the fire!']),
  };
  if (a.inventory.wood > 0) return { ...base, score: score + 0.05, targetLabel: 'Campfire', build: () => [new MoveTo(seat, 'the campfire', { arrive: 0.5 }), new AddFuel(fire.id)] };
  const store = ctx.stores.find((s) => s.stored.wood > 0 && s.kind === 'storage');
  if (store) {
    return {
      ...base,
      score,
      targetLabel: 'Wood from the storehouse',
      build: () => [new MoveTo(() => doorSpot(w, store), 'the storehouse', { arrive: 0.5 }), new Withdraw(store.id, 'wood', 2), new MoveTo(seat, 'the campfire', { arrive: 0.5 }), new AddFuel(fire.id)],
    };
  }
  const tree = pickTree(a, w, fire, 40);
  if (!tree) return null;
  return {
    ...base,
    score: score * 0.95,
    targetLabel: `${resourceLabel(tree)} → Campfire`,
    claims: { resource: tree.id },
    build: () => [...woodTrip(a, w, tree, Math.min(2, tree.amount)), new MoveTo(seat, 'the campfire', { arrive: 0.5 }), new AddFuel(fire.id)],
  };
};

// ---------------------------------------------------------------------------
// Exploration & leisure
// ---------------------------------------------------------------------------

/**
 * Somewhere worth exploring: unseen land (by the agent and by their people's shared map),
 * moderately far, biased by purpose. Expeditions reach much further than everyday wandering,
 * and head toward the region their leader wants explored.
 */
export function exploreTarget(a: Agent, w: World, purpose: 'food' | 'water' | 'any' | 'expedition', toward?: V2): V2 | null {
  const mem = a.memory;
  const civ = w.civOf(a);
  const home = campCenter(w, a.settlementId);
  let best: V2 | null = null;
  let bestS = -Infinity;
  const far = purpose === 'expedition';
  const ideal = far ? 110 : 34;
  for (let i = 0; i < (far ? 60 : 40); i++) {
    const cx = Math.floor(hash01(a.id * 131 + i, Math.floor(w.time / 30)) * EXPLORE_N);
    const cz = Math.floor(hash01(a.id * 71 + i * 3, Math.floor(w.time / 30) + 7) * EXPLORE_N);
    const x = EXPLORE_ORIGIN + (cx + 0.5) * EXPLORE_CELL;
    const z = EXPLORE_ORIGIN + (cz + 0.5) * EXPLORE_CELL;
    const dHome = Math.hypot(x - home.x, z - home.z);
    if (dHome > (far ? 230 : 90)) continue;
    const p = w.nav.nearestWalkable(x, z, 5);
    if (!p) continue;
    const idx = cz * EXPLORE_N + cx;
    const seen = mem.explored[idx]!;
    const civSeen = civ ? civ.knowledge.map[idx]! : 0;
    const fresh = seen === 0 ? (civSeen ? 0.55 : 1) : Math.min(0.5, (w.time - seen) / (DAY_LENGTH * 3));
    const d = dist(a, p);
    let s = fresh * 2 - Math.abs(d - ideal) / (far ? 90 : 40);
    const h = w.terrain.heightAt(p.x, p.z);
    if (purpose === 'water') s += h < 8 ? 0.3 : -0.3;
    if (purpose === 'food') s += w.terrain.moistureAt(p.x, p.z) > 0.35 && h > 1.5 && h < 20 ? 0.3 : 0;
    if (toward) s -= Math.hypot(p.x - toward.x, p.z - toward.z) / (far ? 80 : 60);
    if (a.has('timid')) s -= dHome / 60;
    // Stay out of the lands of people they fear or were told to avoid.
    const owner = w.territory[Math.floor((p.z + w.terrain.size / 2) / 16) * MAP_N + Math.floor((p.x + w.terrain.size / 2) / 16)] ?? -1;
    if (owner >= 0 && civ && owner !== civ.id) {
      const rel = civ.relations.get(owner);
      if (rel && (rel.state === 'hostile' || civ.objectives.some((o) => o.kind === 'AVOID_CIVILIZATION' && o.civ === owner))) s -= 3;
    }
    if (s > bestS) {
      bestS = s;
      best = p;
    }
  }
  return best;
}

/** Share of land near home that this people have already mapped. */
function localKnown(w: World, a: Agent, ctx: ThinkContext): number {
  const civ = ctx.civ;
  if (!civ) return w.exploredFraction(a);
  const c = ctx.camp;
  let land = 0;
  let known = 0;
  const r = 6;
  const cx0 = Math.floor((c.x - EXPLORE_ORIGIN) / EXPLORE_CELL);
  const cz0 = Math.floor((c.z - EXPLORE_ORIGIN) / EXPLORE_CELL);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const cx = cx0 + dx;
      const cz = cz0 + dz;
      if (cx < 0 || cz < 0 || cx >= EXPLORE_N || cz >= EXPLORE_N) continue;
      const i = cz * EXPLORE_N + cx;
      if (!w.exploreLand[i]) continue;
      land++;
      if (civ.knowledge.map[i] || a.memory.explored[i]! > 0) known++;
    }
  }
  return land ? known / land : 1;
}

const explore: GoalFn = (a, w, ctx) => {
  if (!a.awake || a.needs.energy < 0.3) return null;
  const out: Candidate[] = [];
  const f = ctx.focus.explore;
  // Everyday wandering near home fades once the surroundings are familiar.
  let u = 0.12 + (a.has('curious') ? 0.13 : 0) + (a.memory.knownFoodCount() < 3 ? 0.08 : 0) - (a.has('timid') ? 0.04 : 0);
  u *= 1 - localKnown(w, a, ctx) * 0.8;
  u *= 0.8 + 0.2 * f;
  if (ctx.night) u *= 0.25;
  if (ctx.rain > 0.3) u *= 0.4;
  const dest = u > 0.02 ? exploreTarget(a, w, 'any') : null;
  if (dest) {
    out.push({
      goal: 'explore',
      label: 'Explore',
      icon: 'explore',
      score: u,
      reason: a.has('curious') ? 'Curious about what lies beyond' : a.memory.knownFoodCount() < 3 ? 'Knows too few places to find food' : 'Nothing urgent to do, time to look around',
      targetLabel: describePlace(w, dest.x, dest.z, false, a),
      target: dest,
      key: `explore:${Math.round(dest.x / 10)}:${Math.round(dest.z / 10)}`,
      thought: pickLine(a, ['I wonder what is over that hill.', 'So much of this land is still a mystery.', "Let's see what's out there.", 'Maybe I will find something useful.']),
      build: () => [new Search('anything', dest, () => false)],
    });
  }
  // Expeditions: a few bold people travel far on behalf of everyone.
  const civ = ctx.civ;
  if (civ && !a.isChild && !ctx.isLeader && !ctx.night && a.needs.energy > 0.55 && a.needs.hunger > 0.45 && a.needs.thirst > 0.45) {
    const objective = civ.objectives.find((o) => o.kind === 'EXPLORE_REGION' || o.kind === 'ESTABLISH_SETTLEMENT' || o.kind === 'EXPAND');
    const wanted = Math.round((f - 0.6) * 2 + (objective ? 1 : 0) + ctx.pop / 14);
    const current = civ.members.filter((o) => o.alive && o.brain.active?.key.startsWith('expedition')).length;
    const aptitude = (a.has('curious') ? 0.12 : 0) + (a.has('brave') ? 0.08 : 0) - (a.has('timid') ? 0.15 : 0) - (a.news.length ? 0.2 : 0);
    if (current < wanted && ctx.pop >= 4) {
      const region = objective?.region !== undefined ? w.terrain.regions[objective.region] : undefined;
      const toward = region ? { x: region.x, z: region.z } : objective?.target;
      const far = exploreTarget(a, w, 'expedition', toward);
      if (far) {
        const home = ctx.camp;
        const whereName = region?.name ?? describePlace(w, far.x, far.z, false, a);
        out.push({
          goal: 'explore',
          label: 'Lead an expedition',
          icon: 'explore',
          score: (0.3 + aptitude) * (0.7 + 0.3 * f) + (objective ? 0.08 : 0),
          reason: objective ? `${civ.objectives.includes(objective) ? 'The leader' : 'The people'} want${objective ? 's' : ''} to know ${region ? region.name : 'what lies beyond'}` : 'Their people want to know what lies beyond the horizon',
          targetLabel: whereName,
          target: far,
          key: `expedition:${Math.round(far.x / 20)}:${Math.round(far.z / 20)}`,
          thought: pickLine(a, ['I will see what nobody has seen.', 'Pack light, walk far.', `They say ${whereName} is out there somewhere.`, 'Someone has to go. It might as well be me.']),
          build: () => [new Search('anything', far, () => false), new MoveTo(() => w.nav.nearestWalkable(home.x + 2, home.z + 2, 8), 'home', { arrive: 3 })],
          onComplete: (ag) => `Back from the expedition with ${ag.news.length ? 'news' : 'tired feet'}.`,
        });
      }
    }
  }
  return out;
};

const idle: GoalFn = (a, w, ctx) => {
  if (!a.awake) return null;
  const slot = Math.floor(ctx.now / 20);
  const roll = hash01(a.id * 5, slot);
  // Children stay close to a parent (or home) when they have nothing else to do.
  const parent = a.isChild ? a.parents.map((id) => w.agent(id)).find((p) => p && p.alive && p.inside === null) : undefined;
  const home = w.structure(a.homeId);
  const center = parent ?? (home && home.complete ? home : ctx.camp);
  const base = {
    goal: 'idle' as const,
    label: 'Relax',
    icon: 'idle' as const,
    score: 0.05,
    reason: a.isChild ? 'Too young to work, staying near family' : 'Needs are met and there is no pressing work',
    key: 'idle',
  };
  // Stargazing on clear evenings.
  if (!a.isChild && ctx.hour >= 20 && ctx.hour < 22.5 && ctx.rain < 0.1 && roll < (a.has('curious') ? 0.7 : 0.35)) {
    const ang = roll * 40;
    const spot = w.nav.nearestWalkable(ctx.camp.x + Math.cos(ang) * 6, ctx.camp.z + Math.sin(ang) * 6, 5);
    if (spot) {
      return {
        ...base,
        label: 'Watch the stars',
        icon: 'star',
        targetLabel: 'A quiet spot near camp',
        target: spot,
        thought: pickLine(a, ['So many stars tonight...', 'I wonder who lives up there.', 'The sky is so big.']),
        build: () => [new MoveTo(() => spot, 'a quiet spot', { arrive: 0.6 }), new Rest(25, 'stargaze', 'Gazing at the stars')],
      };
    }
  }
  // Watching the waves from the beach.
  if (!a.isChild && !ctx.night && roll > 0.55 && w.beachSpots.length) {
    let best: V2 | null = null;
    let bd = Infinity;
    for (const b of w.beachSpots) {
      const d = dist(a, b);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    if (best && bd < 40) {
      const b: V2 = best;
      let sea = { x: b.x, z: b.z };
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2;
        if (w.terrain.heightAt(b.x + Math.cos(ang) * 8, b.z + Math.sin(ang) * 8) < -0.2) sea = { x: b.x + Math.cos(ang) * 8, z: b.z + Math.sin(ang) * 8 };
      }
      return {
        ...base,
        label: 'Watch the waves',
        icon: 'idle',
        targetLabel: `The shore (${Math.round(bd)}m)`,
        target: b,
        thought: pickLine(a, ['The sea is calm today.', 'I love the sound of the waves.', 'What is on the other side of the sea?']),
        build: () => [new MoveTo(() => b, 'the shore', { arrive: 1 }), new Rest(20 + roll * 15, 'sit', 'Watching the waves', sea)],
      };
    }
  }
  const ang = hash01(a.id, slot) * Math.PI * 2;
  const r = (a.isChild ? 1.5 : 2) + hash01(a.id + 3, slot) * (a.isChild ? 3 : 6);
  const spot = w.nav.nearestWalkable(center.x + Math.cos(ang) * r, center.z + Math.sin(ang) * r, 5);
  if (!spot) return null;
  const sit = hash01(a.id, Math.floor(ctx.now / 13)) < 0.5;
  return {
    ...base,
    targetLabel: parent ? `Near ${parent.name}` : home ? 'Near home' : 'Around camp',
    target: spot,
    thought: a.isChild ? pickLine(a, ['Where did everyone go?', 'I want to help too!', 'When I grow up I will build a house.']) : pickLine(a, ['What a lovely day.', 'Nothing to do for a moment. Nice.', 'I could get used to this.', 'Listening to the birds...']),
    build: () => [new MoveTo(() => spot, 'a quiet spot', { arrive: 0.6 }), new Rest(6 + hash01(a.id, 99) * 6, sit ? 'sit' : 'look', sit ? 'Sitting down for a while' : 'Taking in the view')],
  };
};

const pray: GoalFn = (a, w, ctx) => {
  if (!a.awake || a.faith < 0.12 || (a.isChild && a.age < 6)) return null;
  const shrine = w.structures.find((s) => (s.kind === 'monument' || s.kind === 'shrine') && s.complete && s.settlementId === ctx.sid);
  if (!shrine) return null;
  let u = a.faith * 0.22 * drive(ctx.focus.faith);
  if (a.needs.safety < 0.65) u += (0.65 - a.needs.safety) * 0.9;
  const h = ctx.hour;
  if ((h >= 6 && h < 7.5) || (h >= 18 && h < 19.5)) u += 0.12 * a.faith;
  const grief = a.memory.dangers.some((d) => d.kind === 'death' && ctx.now - d.at < DAY_LENGTH);
  if (grief) u += 0.15;
  if (u < 0.08) return null;
  const d = dist(a, shrine);
  const spot = () => workSpot(w, shrine, a.id);
  const place = shrine.kind === 'monument' ? 'the Sky Altar' : 'the shrine';
  return {
    goal: 'pray',
    label: 'Pray',
    icon: 'star',
    score: u * travel(d),
    reason: a.needs.safety < 0.5 ? 'Frightened, and hoping for protection' : grief ? 'Mourning a loss' : 'Giving thanks to whoever watches over them',
    targetLabel: `${place.charAt(0).toUpperCase()}${place.slice(1)} (${Math.round(d)}m)`,
    target: shrine,
    key: 'pray',
    thought: pickLine(a, ['Whoever you are up there... thank you.', 'Please keep us safe.', 'I know someone is watching.', 'Give us good harvests.']),
    build: () => [new MoveTo(spot, place, { arrive: 0.5 }), new Pray(shrine.id, 14 + hash01(a.id, 5) * 8)],
    onComplete: (ag, wd) => {
      ag.brain.cooldowns.set('pray', wd.time + DAY_LENGTH * 0.4);
      return `Prayed at ${place} and felt calmer.`;
    },
  };
};

/** The faithful travel to sacred wonders their people know of. */
const pilgrimage: GoalFn = (a, w, ctx) => {
  const civ = ctx.civ;
  if (!civ || !a.awake || ctx.night || a.faith < 0.35 || a.needs.energy < 0.5 || a.needs.hunger < 0.5 || a.needs.thirst < 0.5) return null;
  let best: { l: (typeof w.terrain.landmarks)[number]; d: number } | null = null;
  for (const id of civ.knowledge.landmarks) {
    const l = w.terrain.landmarks.find((x) => x.id === id);
    if (!l || !['stoneCircle', 'temple', 'greatTree', 'spring', 'floatingRocks', 'crystalSpire'].includes(l.kind)) continue;
    const d = dist(a, l);
    if (d > 190) continue;
    if (!best || d < best.d) best = { l, d };
  }
  if (!best) return null;
  const l = best.l;
  const spot = w.nav.nearestWalkable(l.x + Math.cos(a.id) * (l.block + 3), l.z + Math.sin(a.id) * (l.block + 3), 8);
  if (!spot) return null;
  return {
    goal: 'pray',
    label: `Pilgrimage to ${l.name}`,
    icon: 'star',
    score: (0.1 + a.faith * 0.18) * drive(ctx.focus.faith) * travel(best.d * 0.6),
    reason: `${l.name} is sacred to the ${civ.people}`,
    targetLabel: `${l.name} (${Math.round(best.d)}m)`,
    target: spot,
    key: `pilgrim:${l.id}`,
    thought: pickLine(a, [`I want to see ${l.name} with my own eyes.`, 'The old places are closer to the sky.', `They say ${LANDMARK_INFO[l.kind].title.toLowerCase()} can answer prayers.`]),
    build: () => [new MoveTo(() => spot, l.name, { arrive: 1.2 }), new Worship(l.id, 18)],
    onComplete: (ag, wd) => {
      ag.brain.cooldowns.set(`pilgrim:${l.id}`, wd.time + DAY_LENGTH * 3);
      return `Worshipped at ${l.name}.`;
    },
  };
};

/** Envoys carry gifts to another people (trade or peace-making, as the leader wishes). */
const envoy: GoalFn = (a, w, ctx) => {
  const civ = ctx.civ;
  if (!civ || a.isChild || ctx.isLeader || !a.awake || ctx.night || a.needs.energy < 0.55 || a.needs.hunger < 0.5 || a.needs.thirst < 0.5) return null;
  const o = civ.objectives.find((x) => (x.kind === 'TRADE' || x.kind === 'SEEK_PEACE') && x.civ !== undefined);
  if (!o) return null;
  const other = w.civs[o.civ!];
  if (!other || !other.capital) return null;
  if (civ.members.some((m) => m !== a && m.alive && m.brain.active?.goal === 'envoy')) return null;
  if (onCooldown(a, `envoy:${other.id}`, ctx.now) || (civ.timers.get(`envoy:${other.id}`) ?? -Infinity) > ctx.now) return null;
  const their = campCenter(w, other.capital.id);
  const d = dist(a, their);
  if (d > 420) return null;
  const store = ctx.stores.find((s) => s.stored.wood + s.stored.berries + s.stored.fruit + s.stored.mushrooms + s.stored.stone > 3);
  const aptitude = (a.has('sociable') ? 0.1 : 0) + (a.has('kind') ? 0.06 : 0) + (a.persona.includes('generous') ? 0.08 : 0);
  const peace = o.kind === 'SEEK_PEACE';
  return {
    goal: 'envoy',
    label: peace ? `Seek peace with ${other.name}` : `Take gifts to ${other.name}`,
    icon: 'social',
    score: 0.36 + aptitude,
    reason: o.reason || (peace ? `The leader wants peace with ${other.name}` : `The leader wants friends among ${other.name}`),
    targetLabel: `${other.capital.name} (${Math.round(d)}m)`,
    target: their,
    key: 'envoy',
    thought: peace ? pickLine(a, ['Words and gifts. Better than spears.', 'I hope they listen.']) : pickLine(a, ['A long walk with a heavy basket.', 'I wonder what their homes look like.']),
    build: () => {
      const steps = [];
      if (store) steps.push(new MoveTo(() => doorSpot(w, store), 'the stores', { arrive: 0.5 }), new Withdraw(store.id, 'gift', 5));
      steps.push(new MoveTo(() => w.nav.nearestWalkable(their.x + 3, their.z + 3, 10), other.capital!.name, { arrive: 3 }), new Envoy(other.id, peace));
      steps.push(new MoveTo(() => w.nav.nearestWalkable(ctx.camp.x + 2, ctx.camp.z + 2, 8), 'home', { arrive: 3 }));
      return steps;
    },
    onComplete: (ag, wd) => {
      ag.brain.cooldowns.set(`envoy:${other.id}`, wd.time + DAY_LENGTH);
      civ.timers.set(`envoy:${other.id}`, wd.time + DAY_LENGTH * 0.8);
      return `Came home from ${other.name}.`;
    },
  };
};

const play: GoalFn = (a, w, ctx) => {
  if (!a.isChild || !a.awake || ctx.night || ctx.rain > 0.3) return null;
  let mate: Agent | null = null;
  let md = Infinity;
  for (const o of ctx.mates) {
    if (o === a || !o.alive || !o.awake || o.inside !== null) continue;
    const d = dist(a, o);
    const kid = o.isChild;
    const score = d - (kid ? 20 : 0) - (a.parents.includes(o.id) ? 8 : 0);
    if (d < 35 && score < md) {
      md = score;
      mate = o;
    }
  }
  const m: Agent | null = mate;
  const center = m ? { x: (a.x + m.x) / 2, z: (a.z + m.z) / 2 } : ctx.camp;
  const spot = w.nav.nearestWalkable(center.x, center.z, 4);
  if (!spot) return null;
  return {
    goal: 'play',
    label: m ? `Play with ${m.name}` : 'Play',
    icon: 'star',
    score: 0.22 + (a.needs.social < 0.6 ? 0.08 : 0),
    reason: 'Children love to play',
    targetLabel: m ? m.name : 'Around camp',
    target: spot,
    key: 'play',
    thought: pickLine(a, ["Can't catch me!", "Tag, you're it!", 'Wheee!', "Let's race to the fire!"]),
    build: () => [new MoveTo(() => spot, 'the playground', { arrive: 1, run: true }), new Play(spot, 14 + hash01(a.id, 3) * 10, m ? m.name : null)],
    onComplete: (ag, wd) => {
      ag.brain.cooldowns.set('play', wd.time + 25);
    },
  };
};

/** Goals children never pursue. */
export const ADULT_ONLY = new Set(['found', 'supply', 'construct', 'haul', 'tendFire', 'explore', 'help', 'envoy']);

export const GOALS: Array<{ id: string; fn: GoalFn }> = [
  { id: 'flee', fn: flee },
  { id: 'drink', fn: drink },
  { id: 'eat', fn: eat },
  { id: 'sleep', fn: sleep },
  { id: 'shelter', fn: shelter },
  { id: 'comfort', fn: comfort },
  { id: 'recover', fn: recover },
  { id: 'help', fn: help },
  { id: 'socialize', fn: socialize },
  { id: 'pray', fn: pray },
  { id: 'pilgrimage', fn: pilgrimage },
  { id: 'play', fn: play },
  { id: 'found', fn: found },
  { id: 'supply', fn: supply },
  { id: 'construct', fn: construct },
  { id: 'haul', fn: haul },
  { id: 'tendFire', fn: tendFire },
  { id: 'explore', fn: explore },
  { id: 'envoy', fn: envoy },
  { id: 'idle', fn: idle },
];
