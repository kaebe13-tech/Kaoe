import { clamp01, smoothstep, type V2 } from '../core/math';
import { hash01 } from '../core/rng';
import type { Agent } from '../agents/Agent';
import type { World } from '../sim/World';
import { DAY_LENGTH, HOUR } from '../world/config';
import { BLUEPRINTS } from '../sim/blueprints';
import { EXPLORE_CELL, EXPLORE_N, EXPLORE_ORIGIN } from '../agents/Memory';
import {
  campfire,
  chooseSite,
  doorSpot,
  fireSeat,
  nextProject,
  siteNeeds,
  sitesOf,
  storageRoom,
  storages,
  tribeFood,
  tribeStored,
  workSpot,
  allowedProgress,
} from '../sim/settlement';
import {
  CARRY_CAPACITY,
  FOOD_ITEMS,
  ITEMS,
  foodCount,
  inventoryWeight,
  isHarvestable,
  resourceLabel,
  type ItemType,
  type ResourceNode,
  type Structure,
} from '../sim/types';
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
  camp: V2;
  fire: Structure | undefined;
  pop: number;
  stores: Structure[];
  foodStored: number;
}

export function buildContext(a: Agent, w: World): ThinkContext {
  const fire = campfire(w);
  return {
    now: w.time,
    hour: w.hour,
    night: w.isNight,
    rain: a.inside !== null ? 0 : w.rainAt(a.x, a.z),
    camp: fire ? { x: fire.x, z: fire.z } : w.start,
    fire,
    pop: w.living.length,
    stores: storages(w),
    foodStored: tribeFood(w),
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
  if (!a.awake) return null;
  let threat: { x: number; z: number; kind: string; d: number } | null = null;
  const bias = a.has('timid') ? 4 : a.has('brave') ? -1.5 : 0;
  for (const d of w.dangers) {
    const dd = Math.hypot(d.x - a.x, d.z - a.z);
    if (dd < d.radius + bias && (!threat || dd < threat.d)) threat = { x: d.x, z: d.z, kind: d.kind, d: dd };
  }
  if (!threat) return null;
  const campSafe = dist(ctx.camp, threat) > 16 ? ctx.camp : undefined;
  const pt = fleePoint(w, a, threat, 15 + (a.has('timid') ? 5 : 0), campSafe);
  if (!pt) return null;
  const reason = threat.kind === 'fire' ? 'Fire is spreading nearby!' : 'Lightning struck close by!';
  return {
    goal: 'flee',
    label: 'Escape danger',
    icon: 'warning',
    score: 1.6,
    urgent: true,
    reason,
    targetLabel: 'somewhere safe',
    target: pt,
    key: 'flee',
    thought: threat.kind === 'fire' ? pickLine(a, ['Fire! Run!', 'The trees are burning — get away!', 'Too hot, too close!']) : pickLine(a, ['The sky is angry!', 'Run, run, run!', 'That was far too close...']),
    build: () => [new MoveTo(() => pt, 'safety', { run: true, arrive: 1.5 }), new Cower(2.5)],
  };
};

function nearestSpot(w: World, a: Agent, pondId: number): { spot: V2; pond: V2 } | null {
  const pond = w.water.find((p) => p.id === pondId);
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
  return { spot: best, pond: { x: pond.x, z: pond.z } };
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
      targetLabel: `Pond ${describePlace(w, b.pond.x, b.pond.z)} (${Math.round(b.d)}m)`,
      target: b.spot,
      key: `drink:${b.id}`,
      thought: a.needs.thirst < 0.25 ? pickLine(a, ['So thirsty... need water now.', 'My throat is dry as sand.', 'Water. Now.']) : pickLine(a, ['A cool drink from the pond sounds good.', "I'll grab a drink.", 'Time for some water.']),
      build: () => [new MoveTo(() => b.spot, 'the pond', { arrive: 0.35, run: a.needs.thirst < 0.15 }), new Drink(b.pond)],
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
        targetLabel: `unexplored land ${describePlace(w, dest.x, dest.z)}`,
        target: dest,
        key: 'drink:search',
        thought: pickLine(a, ['There must be fresh water somewhere...', 'I need to find a stream or a pond.', 'Where can I find water on this island?']),
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
    if (m.kind !== 'berryBush' && m.kind !== 'fruitTree') continue;
    const item: ItemType = m.kind === 'fruitTree' ? 'fruit' : 'berries';
    if (only && item !== only) continue;
    if (m.avoidUntil > now || onCooldown(a, `eat:${m.id}`, now) || onCooldown(a, `food:${m.id}`, now)) continue;
    const r = w.resources.get(m.id);
    if (!r) continue;
    let est = m.amount;
    if (est <= 0) {
      const since = now - m.seenAt;
      est = Math.min(3, Math.floor(since / (HOUR * (item === 'fruit' ? 3.2 : 1.7))));
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
      targetLabel: `${resourceLabel(src.r)} ${describePlace(w, src.r.x, src.r.z)} (${Math.round(src.d)}m)`,
      target: src.r,
      targetId: src.r.id,
      key: `eat:${src.r.id}`,
      claims: { resource: src.r.id },
      thought:
        hungryLine ||
        (src.r.kind === 'fruitTree'
          ? pickLine(a, ['That fruit tree should have something ripe.', 'Sweet fruit, here I come.', 'I remember a fruit tree over there.'])
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
        targetLabel: `unexplored land ${describePlace(w, dest.x, dest.z)}`,
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
  const freeHut = w.structures.find((s) => s.kind === 'hut' && s.complete && s.residents.length < BLUEPRINTS.hut.capacity);
  if (freeHut) {
    return {
      goal: 'sleep',
      label: 'Go to bed',
      icon: 'sleep',
      score: u,
      reason: `${reason}. There's a free bed in a hut`,
      targetLabel: 'A hut with a free bed',
      target: freeHut,
      key: 'sleep:claim',
      thought: pickLine(a, ["There's room in that hut. I'll take it.", 'A real roof tonight!']),
      build: () => [
        new MoveTo(() => doorSpot(w, freeHut), 'the hut', { arrive: 0.5 }),
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
      reason: `${reason}. No hut yet, so the fire will do`,
      targetLabel: `Campfire (${Math.round(d)}m)`,
      target: fire,
      key: 'sleep:fire',
      thought: pickLine(a, ["I'll sleep by the warm fire.", 'Sleeping under the stars again...', 'We really need huts.']),
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
    if (!hut) return this.fail('The hut is gone');
    if (!hut.residents.includes(a.id)) {
      if (hut.residents.length >= BLUEPRINTS.hut.capacity) return this.fail('Someone else took the last bed');
      hut.residents.push(a.id);
      a.homeId = hut.id;
      const mates = hut.residents.filter((id) => id !== a.id).map((id) => w.agent(id)?.name).filter(Boolean);
      a.addLog(w.time, 'event', `Claimed a bed in the hut${mates.length ? ` with ${mates.join(', ')}` : ''}.`);
      w.log(`${a.name} moved into a hut${mates.length ? ` with ${mates.join(', ')}` : ''}.`, 'home', 1, hut, a.id);
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
  if (ctx.night && far && a.has('timid')) u = Math.max(u, 0.32);
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
  if (!a.awake || a.needs.health > 0.45 || a.needs.hunger < 0.2 || a.needs.thirst < 0.2) return null;
  const u = (0.5 - a.needs.health) * 1.1;
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
    const ev = 0.3 + (a.has('sociable') ? 0.08 : 0) + (1 - a.needs.social) * 0.25;
    const stay = Math.max(20, (21.8 - ctx.hour) * HOUR);
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
  for (const o of w.agents) {
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
  for (const o of w.agents) {
    if (o === a || !o.alive) continue;
    const d = dist(a, o);
    if (d > 55) continue;
    const key = `help:${o.id}`;
    if (onCooldown(a, key, ctx.now)) continue;
    if (w.agents.some((x) => x !== a && x.brain.active?.key === key)) continue;
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

function nightWork(ctx: ThinkContext): number {
  if (ctx.night) return 0.35;
  if (ctx.hour >= 19.5) return 0.7;
  return 1;
}

const found: GoalFn = (a, w, ctx) => {
  if (!a.awake || ctx.night || a.needs.energy < 0.3) return null;
  const proj = nextProject(w);
  if (!proj) return null;
  if (w.agents.some((o) => o !== a && o.brain.active?.goal === 'found')) return null;
  const site = chooseSite(w, proj.kind, proj.kind === 'campfire' ? w.start : undefined);
  if (!site) return null;
  const name = BLUEPRINTS[proj.kind].name.toLowerCase();
  const base = proj.kind === 'campfire' ? 0.56 : proj.kind === 'hut' ? 0.46 : 0.4;
  const d = dist(a, site);
  return {
    goal: 'found',
    label: `Start a ${name}`,
    icon: 'build',
    score: (base + workBias(a)) * travel(d) * nightWork(ctx),
    reason: proj.reason,
    targetLabel: `A clear spot ${describePlace(w, site.x, site.z)}`,
    target: site,
    key: `found:${proj.kind}`,
    thought:
      proj.kind === 'campfire'
        ? pickLine(a, ["We need a fire. I'll pick a good spot.", 'A campfire here would be perfect.', 'Fire first, then everything else.'])
        : proj.kind === 'hut'
          ? pickLine(a, ["Sleeping outside again? No. Let's build a hut.", "I'll mark out a hut right there.", 'A roof over our heads — that’s the plan.'])
          : pickLine(a, [`The tribe could really use a ${name}.`, `Time to start on a ${name}.`]),
    build: () => [new MoveTo(() => site, 'the building spot', { arrive: 1.4 }), new PlaceSite(proj.kind, site, proj.reason)],
  };
};

/** Nearest standing tree that isn't burning, preferring ones on the way to `toward`. */
function pickTree(a: Agent, w: World, toward: V2 | null, radius = 45): ResourceNode | null {
  let best: ResourceNode | null = null;
  let bestS = Infinity;
  const scan = (r: number) => {
    w.resourceHash.query(a.x, a.z, r, (t) => {
      if (t.kind !== 'tree' || !isHarvestable(t)) return;
      if (onCooldown(a, `tree:${t.id}`, w.time)) return;
      const crowd = t.claims > 0 && t.amount <= t.claims * 2 ? 12 : t.claims * 3;
      const s = dist(a, t) + (toward ? dist(t, toward) * 0.7 : 0) + crowd;
      if (s < bestS) {
        bestS = s;
        best = t;
      }
    });
  };
  scan(radius);
  if (!best) scan(radius * 2);
  return best;
}

function woodTrip(a: Agent, w: World, tree: ResourceNode, count: number): Array<MoveTo | Harvest> {
  return [
    new MoveTo(() => approachPoint(w, a, tree.x, tree.z, reachOf('tree', tree.blockRadius) - 0.25), resourceLabel(tree).toLowerCase(), {
      arrive: 0.3,
      valid: () => (tree.state !== 'grown' ? 'Someone had already cut the tree down' : tree.burning > 0 ? 'The tree caught fire!' : null),
    }),
    new Harvest(tree.id, count, 'wood'),
  ];
}

const supply: GoalFn = (a, w, ctx) => {
  if (!a.awake) return null;
  const sites = sitesOf(w).filter((s) => s.burning <= 0);
  if (!sites.length) return null;
  let best: Candidate | null = null;
  for (const s of sites) {
    const needs = siteNeeds(s);
    const item = (Object.keys(needs) as ItemType[]).find((k) => (needs[k] ?? 0) > 0);
    if (!item) continue;
    const need = needs[item]!;
    const name = BLUEPRINTS[s.kind].name.toLowerCase();
    const age = Math.min(0.08, (ctx.now - s.foundedAt) / (HOUR * 6) * 0.08);
    const base = 0.36 + workBias(a) + age + (s.foundedBy === a.id ? 0.04 : 0) + (s.kind === 'campfire' ? 0.08 : 0);
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
    } else if (item === 'wood') {
      const tree = pickTree(a, w, s);
      if (tree) {
        const room = Math.floor(CARRY_CAPACITY - inventoryWeight(a.inventory));
        const n = Math.max(1, Math.min(need, room, tree.amount));
        const d = dist(a, tree) + dist(tree, s);
        cand = {
          goal: 'supply',
          label: 'Gather wood',
          icon: 'wood',
          score: base * travel(d * 0.8) * nightWork(ctx),
          reason,
          targetLabel: `${resourceLabel(tree)} ${describePlace(w, tree.x, tree.z)} → ${BLUEPRINTS[s.kind].name}`,
          target: tree,
          targetId: tree.id,
          key: `supply:${s.id}:${tree.id}`,
          claims: { resource: tree.id, site: { id: s.id, item: 'wood', promised: n } },
          thought: pickLine(a, ["That tree will make good logs.", `We need wood for the ${name}.`, 'Time to swing the axe.', "I'll fetch some logs."]),
          build: () => [...woodTrip(a, w, tree, n), new MoveTo(spot, `the ${name} site`, { arrive: 0.5 }), new Deliver(s.id, 'wood')],
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
          targetLabel: `${resourceLabel(src.r)} ${describePlace(w, src.r.x, src.r.z)} → ${BLUEPRINTS[s.kind].name}`,
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
  for (const s of sitesOf(w)) {
    if (s.burning > 0 || allowedProgress(s) <= s.progress + 0.015) continue;
    const name = BLUEPRINTS[s.kind].name.toLowerCase();
    const d = dist(a, s);
    const helpers = w.agents.filter((o) => o !== a && o.brain.active?.goal === 'construct' && o.brain.active.targetId === s.id).length;
    const score = (0.44 + workBias(a) + (s.foundedBy === a.id ? 0.05 : 0) - helpers * 0.03) * travel(d) * nightWork(ctx);
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
  const siteNeedsWood = sitesOf(w).some((s) => (siteNeeds(s).wood ?? 0) > 0);
  if (food >= 5 && a.needs.hunger > 0.75) {
    return {
      goal: 'haul',
      label: 'Store food',
      icon: 'food',
      score: 0.3 + workBias(a) * 0.5,
      reason: `Carrying ${food} food the tribe could use later`,
      targetLabel: `The ${name}`,
      target: store,
      key: `haul:store:${store.id}`,
      thought: pickLine(a, ["I'll put this in the stores for later.", 'Saving some for a rainy day.']),
      build: () => [new MoveTo(door, `the ${name}`, { arrive: 0.5 }), new Store(store.id, FOOD_ITEMS)],
    };
  }
  if (a.inventory.wood > 0 && !siteNeedsWood) {
    return {
      goal: 'haul',
      label: 'Store wood',
      icon: 'wood',
      score: 0.26,
      reason: `Carrying ${a.inventory.wood} spare logs`,
      targetLabel: `The ${name}`,
      target: store,
      key: `haul:wood:${store.id}`,
      build: () => [new MoveTo(door, `the ${name}`, { arrive: 0.5 }), new Store(store.id, ['wood'])],
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
        score: (0.24 + workBias(a) + (4 - perCap) * 0.015) * travel(src.d + dist(src.r, store)),
        reason: `The stores hold only ${ctx.foodStored} food for ${ctx.pop} people`,
        targetLabel: `${resourceLabel(src.r)} ${describePlace(w, src.r.x, src.r.z)} → ${BLUEPRINTS[store.kind].name}`,
        target: src.r,
        targetId: src.r.id,
        key: `haul:food:${src.r.id}`,
        claims: { resource: src.r.id },
        thought: pickLine(a, ["Let's fill the stores while the picking is good.", 'A full storehouse means nobody goes hungry.']),
        build: () => [...foodTrip(a, w, src, n)(), new MoveTo(door, `the ${name}`, { arrive: 0.5 }), new Store(store.id, FOOD_ITEMS)],
      };
    }
  }
  if (store.kind === 'storage' && tribeStored(w, 'wood') < 6 && !siteNeedsWood) {
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
  if (w.agents.some((o) => o !== a && o.brain.active?.goal === 'tendFire')) return null;
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

/** Choose somewhere worth exploring: unseen land, moderately far, biased by purpose. */
export function exploreTarget(a: Agent, w: World, purpose: 'food' | 'water' | 'any'): V2 | null {
  const mem = a.memory;
  let best: V2 | null = null;
  let bestS = -Infinity;
  for (let i = 0; i < 40; i++) {
    const cx = Math.floor(hash01(a.id * 131 + i, Math.floor(w.time / 30)) * EXPLORE_N);
    const cz = Math.floor(hash01(a.id * 71 + i * 3, Math.floor(w.time / 30) + 7) * EXPLORE_N);
    const x = EXPLORE_ORIGIN + (cx + 0.5) * EXPLORE_CELL;
    const z = EXPLORE_ORIGIN + (cz + 0.5) * EXPLORE_CELL;
    const p = w.nav.nearestWalkable(x, z, 4);
    if (!p) continue;
    const seen = mem.explored[cz * EXPLORE_N + cx]!;
    const fresh = seen === 0 ? 1 : Math.min(0.6, (w.time - seen) / (DAY_LENGTH * 2));
    const d = dist(a, p);
    let s = fresh * 2 - Math.abs(d - 32) / 40;
    const h = w.terrain.heightAt(p.x, p.z);
    if (purpose === 'water') s += h < 6 ? 0.3 : -0.3;
    if (purpose === 'food') s += w.terrain.moistureAt(p.x, p.z) < 0.6 && h > 1.5 ? 0.3 : 0;
    if (a.has('timid')) s -= dist(p, w.start) / 60;
    if (s > bestS) {
      bestS = s;
      best = p;
    }
  }
  return best;
}

const explore: GoalFn = (a, w, ctx) => {
  if (!a.awake || a.needs.energy < 0.3) return null;
  let u = 0.12 + (a.has('curious') ? 0.13 : 0) + (a.memory.knownFoodCount() < 3 ? 0.08 : 0) - (a.has('timid') ? 0.04 : 0);
  if (ctx.night) u *= 0.25;
  if (ctx.rain > 0.3) u *= 0.4;
  const dest = exploreTarget(a, w, 'any');
  if (!dest) return null;
  return {
    goal: 'explore',
    label: 'Explore',
    icon: 'explore',
    score: u,
    reason: a.has('curious') ? 'Curious about what lies beyond' : a.memory.knownFoodCount() < 3 ? 'Knows too few places to find food' : 'Nothing urgent to do — time to look around',
    targetLabel: describePlace(w, dest.x, dest.z),
    target: dest,
    key: `explore:${Math.round(dest.x / 10)}:${Math.round(dest.z / 10)}`,
    thought: pickLine(a, ['I wonder what’s over that hill.', 'So much of this island is still a mystery.', 'Let’s see what’s out there.', 'Maybe I’ll find something useful.']),
    build: () => [new Search('anything', dest, () => false)],
  };
};

const idle: GoalFn = (a, w, ctx) => {
  if (!a.awake) return null;
  const home = w.structure(a.homeId);
  const center = home && home.complete ? home : ctx.camp;
  const ang = hash01(a.id, Math.floor(ctx.now / 20)) * Math.PI * 2;
  const r = 2 + hash01(a.id + 3, Math.floor(ctx.now / 20)) * 6;
  const spot = w.nav.nearestWalkable(center.x + Math.cos(ang) * r, center.z + Math.sin(ang) * r, 5);
  if (!spot) return null;
  const sit = hash01(a.id, Math.floor(ctx.now / 13)) < 0.5;
  return {
    goal: 'idle',
    label: 'Relax',
    icon: 'idle',
    score: 0.05,
    reason: 'Needs are met and there is no pressing work',
    targetLabel: home ? 'Near home' : 'Around camp',
    target: spot,
    key: 'idle',
    thought: pickLine(a, ['What a lovely day.', 'Nothing to do for a moment. Nice.', 'I could get used to island life.', 'Listening to the waves...']),
    build: () => [new MoveTo(() => spot, 'a quiet spot', { arrive: 0.6 }), new Rest(6 + hash01(a.id, 99) * 6, sit ? 'sit' : 'look', sit ? 'Sitting down for a while' : 'Taking in the view')],
  };
};

export const GOALS: GoalFn[] = [flee, drink, eat, sleep, shelter, comfort, recover, help, socialize, found, supply, construct, haul, tendFire, explore, idle];
