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

  it('has fresh water, food and trees', () => {
    const w = new World(7);
    expect(w.water.length).toBeGreaterThanOrEqual(2);
    expect(w.water.every((p) => p.spots.length > 5)).toBe(true);
    const kinds = new Set([...w.resources.values()].map((r) => r.kind));
    expect(kinds.has('tree') && kinds.has('berryBush') && kinds.has('fruitTree')).toBe(true);
    expect(w.nav.walkable(w.start.x, w.start.z)).toBe(true);
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
    const fireSpot = chooseSite(w, 'campfire', w.start)!;
    w.createStructure('campfire', fireSpot.x, fireSpot.z, 0, a!.id).complete = true;
    const spot = chooseSite(w, 'hut')!;
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
    expect(w2.time).toBe(w.time);
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
  it('a tribe survives its first day and builds a campfire', () => {
    const w = new World(1337);
    w.spawnTribe(6);
    run(w, DAY_LENGTH);
    expect(w.living.length).toBe(6);
    expect(w.structures.some((s) => s.kind === 'campfire' && s.complete)).toBe(true);
    for (const a of w.agents) {
      expect(Number.isFinite(a.x) && Number.isFinite(a.z)).toBe(true);
      expect(a.stats.foodEaten).toBeGreaterThan(0);
    }
  });
});
