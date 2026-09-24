import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/World';
import { Simulation } from '../src/sim/Simulation';
import { SIM_DT, DAY_LENGTH, HOUR } from '../src/world/config';
import { serialize, deserialize } from '../src/save/SaveSystem';
import { think } from '../src/ai/Brain';
import { adopt } from '../src/ai/brainCore';
import { Rest } from '../src/ai/actions';
import { deliverToSite, workOnSite } from '../src/sim/construction';
import { chooseSite } from '../src/sim/settlement';
import { effectiveSpeed } from '../src/sim/Simulation';

function run(w: World, seconds: number): Simulation {
  const sim = new Simulation(w);
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) sim.step(SIM_DT);
  return sim;
}

describe('world generation', () => {
  it('is deterministic for a seed', () => {
    const sum = (w: World) => w.terrain.heights.reduce((s, h, i) => s + h * ((i % 97) + 1), 0);
    const a = new World(42);
    const b = new World(42);
    expect(a.resources.size).toBe(b.resources.size);
    expect(sum(a)).toBe(sum(b));
    expect(a.start).toEqual(b.start);
    const c = new World(43);
    expect(sum(c)).not.toBe(sum(a));
  });

  it('has fresh water, food, trees, stone, crystal, rivers and landmarks', () => {
    const w = new World(7);
    expect(w.water.filter((p) => p.kind === 'lake').length).toBeGreaterThanOrEqual(4);
    expect(w.water.filter((p) => p.kind === 'river').length).toBeGreaterThan(10);
    expect(w.water.every((p) => p.spots.length > 0)).toBe(true);
    const kinds = new Set([...w.resources.values()].map((r) => r.kind));
    for (const k of ['tree', 'berryBush', 'fruitTree', 'rock', 'mushroom', 'crystal'] as const) expect(kinds.has(k)).toBe(true);
    expect(w.terrain.rivers.length).toBe(3);
    expect(w.terrain.landmarks.length).toBeGreaterThanOrEqual(8);
    expect(w.sites.length).toBeGreaterThanOrEqual(4);
    for (const s of w.sites) expect(w.nav.walkable(s.x, s.z)).toBe(true);
  });

  it('rivers flow downhill into the sea', () => {
    const w = new World(7);
    for (const r of w.terrain.rivers) {
      for (let i = 1; i < r.points.length; i++) expect(r.points[i]!.level).toBeLessThanOrEqual(r.points[i - 1]!.level + 1e-6);
      expect(r.points[r.points.length - 1]!.level).toBeLessThan(0.2);
    }
  });

  it('homelands are reachable from one another over land', () => {
    const w = new World(1337);
    const [a, ...rest] = w.sites.slice(0, 4);
    for (const b of rest) expect(w.nav.connected(a!.x, a!.z, b.x, b.z)).toBe(true);
  });
});

describe('navigation', () => {
  it('routes around obstacles and never through blocked cells', () => {
    const w = new World(11, { skipResources: true });
    const s = w.start;
    // A wall between start and goal.
    for (let dz = -6; dz <= 6; dz++) w.nav.addBlocker(s.x + 4, s.z + dz, 0.6);
    const path = w.paths.finder.find(s, { x: s.x + 8, z: s.z });
    expect(path).not.toBeNull();
    let px = s.x;
    let pz = s.z;
    for (const p of path!) {
      expect(w.nav.lineOfSight(px, pz, p.x, p.z)).toBe(true);
      px = p.x;
      pz = p.z;
    }
    const end = path![path!.length - 1]!;
    expect(Math.hypot(end.x - (s.x + 8), end.z - s.z)).toBeLessThan(1.5);
  });

  it('reports unreachable goals', () => {
    const w = new World(11, { skipResources: true });
    const s = w.start;
    const goal = { x: s.x + 10, z: s.z };
    for (let k = 0; k < 40; k++) {
      const a = (k / 40) * Math.PI * 2;
      w.nav.addBlocker(goal.x + Math.cos(a) * 3, goal.z + Math.sin(a) * 3, 0.8);
    }
    // Goal inside the ring snaps to the nearest walkable cell (inside), which is unreachable.
    const path = w.paths.finder.find(s, goal);
    expect(path).toBeNull();
  });
});

describe('decision making', () => {
  it('commits to a goal instead of flip-flopping on small differences', () => {
    const w = new World(5);
    w.spawnTribe(1);
    const a = w.agents[0]!;
    a.needs.hunger = 0.9;
    a.needs.thirst = 0.9;
    a.needs.energy = 0.9;
    think(a, w);
    const first = a.brain.active?.goal;
    expect(first).toBeDefined();
    // Nudge needs slightly; the current plan should survive re-evaluation.
    a.needs.social -= 0.02;
    think(a, w);
    expect(a.brain.active?.goal).toBe(first);
  });

  it('drops everything for an urgent need', () => {
    const w = new World(5);
    w.spawnTribe(1);
    const a = w.agents[0]!;
    adopt(a, w, { goal: 'idle', label: 'Relax', icon: 'idle', score: 0.3, reason: 'test', build: () => [new Rest(100)] });
    a.needs.thirst = 0.05;
    think(a, w);
    expect(a.brain.active?.goal).toBe('drink');
  });

  it('explains decisions in the log', () => {
    const w = new World(5);
    w.spawnTribe(1);
    const a = w.agents[0]!;
    a.needs.hunger = 0.2;
    think(a, w);
    expect(a.log.some((e) => e.kind === 'decide' && /hunger|Hungry|Starving/i.test(e.text))).toBe(true);
    expect(a.thought.length).toBeGreaterThan(0);
  });
});

describe('construction', () => {
  it('builds a hut from delivered wood and assigns residents', () => {
    const w = new World(9);
    w.spawnTribe(2);
    const [a, b] = w.agents as [typeof w.agents[0], typeof w.agents[0]];
    const sid = a!.settlementId;
    const fireSpot = chooseSite(w, 'campfire', sid, w.start)!;
    w.createStructure('campfire', fireSpot.x, fireSpot.z, 0, a!.id).complete = true;
    const spot = chooseSite(w, 'hut', sid)!;
    expect(spot).not.toBeNull();
    const hut = w.createStructure('hut', spot.x, spot.z, spot.rot, a!.id);
    expect(workOnSite(w, hut, a!, 5)).toBe('blocked');
    a!.inventory.wood = 14;
    expect(deliverToSite(w, hut, a!, 'wood')).toBe(14);
    let res = 'ok';
    for (let i = 0; i < 200 && res !== 'complete'; i++) res = workOnSite(w, hut, i % 2 ? a! : b!, 1);
    expect(res).toBe('complete');
    expect(hut.residents.length).toBe(2);
    expect(a!.homeId).toBe(hut.id);
    expect(w.nav.walkable(hut.x, hut.z)).toBe(false);
  });
});

describe('save and load', () => {
  it('round-trips the simulation state', () => {
    const w = new World(21);
    w.spawnTribe(6);
    run(w, HOUR * 5);
    const data = JSON.parse(JSON.stringify(serialize(w)));
    const w2 = deserialize(data);
    expect(w2.worldTime).toBe(w.worldTime);
    expect(w2.civs.length).toBe(w.civs.length);
    expect(w2.civs[0]!.clock).toBe(w.civs[0]!.clock);
    expect(w2.civs[0]!.leaderId).toBe(w.civs[0]!.leaderId);
    expect(w2.civs[0]!.history.length).toBe(w.civs[0]!.history.length);
    expect(w2.agents.map((a) => a.civId)).toEqual(w.agents.map((a) => a.civId));
    expect(w2.agents.map((a) => a.name)).toEqual(w.agents.map((a) => a.name));
    expect(w2.agents.map((a) => a.needs.hunger)).toEqual(w.agents.map((a) => a.needs.hunger));
    expect(w2.structures.length).toBe(w.structures.length);
    expect(w2.resources.size).toBe(w.resources.size);
    const sampleIds = [...w.resources.keys()].slice(0, 50);
    for (const id of sampleIds) expect(w2.resources.get(id)!.amount).toBe(w.resources.get(id)!.amount);
    // Nav blockers are rebuilt consistently.
    let diff = 0;
    for (let i = 0; i < w.nav.blockers.length; i++) if ((w.nav.blockers[i]! > 0) !== (w2.nav.blockers[i]! > 0)) diff++;
    expect(diff).toBe(0);
    // And the loaded world keeps running.
    run(w2, HOUR);
    expect(w2.agents.every((a) => Number.isFinite(a.x))).toBe(true);
  });
});

describe('survival', () => {
  it('every civilization survives its first day and builds a campfire', () => {
    const w = new World(1337);
    w.spawnCivilizations(4, 6);
    run(w, DAY_LENGTH);
    expect(w.living.length).toBeGreaterThanOrEqual(24);
    for (const c of w.civs) {
      expect(w.structures.some((s) => s.civId === c.id && s.kind === 'campfire' && s.complete)).toBe(true);
      expect(c.leaderId).not.toBeNull();
    }
    for (const a of w.agents) {
      expect(Number.isFinite(a.x) && Number.isFinite(a.z)).toBe(true);
      expect(a.stats.foodEaten).toBeGreaterThan(0);
    }
  });
});

describe('civilization time', () => {
  it('runs each civilization at its own speed', () => {
    const w = new World(1337);
    w.spawnCivilizations(3, 5);
    w.civs[0]!.speed = 4;
    w.civs[1]!.speed = 0;
    w.civs[2]!.speed = 0.25;
    const t0 = w.civs.map((c) => c.clock);
    run(w, HOUR * 2);
    const dt = w.civs.map((c, i) => c.clock - t0[i]!);
    expect(dt[0]).toBeCloseTo(HOUR * 8, 0);
    expect(dt[1]).toBe(0);
    expect(dt[2]).toBeCloseTo(HOUR * 0.5, 0);
    // Frozen people don't move at all.
    const frozen = w.civs[1]!.members.map((a) => [a.x, a.z]);
    run(w, HOUR * 0.5);
    expect(w.civs[1]!.members.map((a) => [a.x, a.z])).toEqual(frozen);
    for (const a of w.agents) expect(Number.isFinite(a.x) && Number.isFinite(a.needs.hunger)).toBe(true);
  });

  it('a civilization back at 1x drifts back into step with the sun', () => {
    const w = new World(1337);
    w.spawnCivilizations(1, 3);
    const civ = w.civs[0]!;
    civ.clock += HOUR * 5; // five hours ahead after a burst of speed
    expect(effectiveSpeed(civ, w.worldTime)).toBeLessThan(1);
    run(w, HOUR * 12);
    const phase = (((civ.clock - w.worldTime) % DAY_LENGTH) + DAY_LENGTH) % DAY_LENGTH;
    expect(Math.min(phase, DAY_LENGTH - phase)).toBeLessThan(HOUR * 0.1);
  });
});
