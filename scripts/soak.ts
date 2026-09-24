/**
 * Headless simulation soak test: runs the world for several days at max speed and prints
 * survival, construction, AI decision quality and navigation statistics.
 *
 *   npm run soak -- --seed 1337 --days 5 --civs 4 --pop 6 [--speeds 1,4,0.5,1] [--log NAME] [--quiet]
 */
import { World } from '../src/sim/World';
import { Simulation } from '../src/sim/Simulation';
import { DAY_LENGTH, SIM_DT } from '../src/world/config';
import { BLUEPRINTS } from '../src/sim/blueprints';
import { eraOf, civFood } from '../src/sim/settlement';
import { RELATION_LABEL, type CivSpeed } from '../src/civ/Civilization';

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const seed = Number(arg('seed', '1337'));
const days = Number(arg('days', '5'));
const pop = Number(arg('pop', '6'));
const civs = Number(arg('civs', '4'));
const speeds = arg('speeds', '').split(',').filter(Boolean).map(Number);
const logName = arg('log', '');
const quiet = args.includes('--quiet');

const t0 = performance.now();
const world = new World(seed);
world.spawnCivilizations(civs, pop);
speeds.forEach((sp, i) => {
  if (world.civs[i]) world.civs[i]!.speed = sp as CivSpeed;
});
const sim = new Simulation(world);
const genMs = performance.now() - t0;

const goalTime = new Map<string, number>();
const failReasons = new Map<string, number>();
let maxStepMs = 0;
let nanCount = 0;
const feed: string[] = [];
world.events.on('log', (e) => feed.push(`D${Math.floor(e.time / DAY_LENGTH) + 1} ${world.clockString(e.time)}  ${e.text}`));

const steps = Math.round((days * DAY_LENGTH) / SIM_DT);
const t1 = performance.now();
let lastDay = world.day;
const dayReports: string[] = [];
for (let i = 0; i < steps; i++) {
  sim.step(SIM_DT);
  if (sim.lastStepMs > 40) console.log(`slow step ${sim.lastStepMs.toFixed(1)}ms at D${world.day} ${world.clockString()} phases ${JSON.stringify(Object.fromEntries(Object.entries(sim.phase).map(([k, v]) => [k, +v.toFixed(1)])))} pop ${world.living.length}`);
  maxStepMs = Math.max(maxStepMs, sim.lastStepMs);
  for (const a of world.agents) {
    if (!a.alive) continue;
    if (!Number.isFinite(a.x) || !Number.isFinite(a.z)) nanCount++;
    const g = a.brain.active?.goal ?? 'none';
    goalTime.set(g, (goalTime.get(g) ?? 0) + SIM_DT);
  }
  if (world.worldDay !== lastDay) {
    lastDay = world.worldDay;
    dayReports.push(`--- World day ${world.worldDay - 1} end ---`);
    for (const civ of world.civs) {
      const alive = civ.living;
      const avg = (k: 'hunger' | 'thirst' | 'energy' | 'health' | 'social') => (alive.reduce((s, a) => s + a.needs[k], 0) / Math.max(1, alive.length)).toFixed(2);
      const built = world.structures.filter((s) => s.civId === civ.id && s.complete && s.kind !== 'grave').map((s) => s.kind);
      const counts = new Map<string, number>();
      for (const b of built) counts.set(b, (counts.get(b) ?? 0) + 1);
      const sites = world.structures.filter((s) => s.civId === civ.id && !s.complete).map((s) => `${s.kind}@${Math.round(s.progress * 100)}%`);
      const leader = world.agent(civ.leaderId);
      const rels = [...civ.relations.values()].filter((r) => r.state !== 'unknown').map((r) => `${world.civs[r.civId]!.name}:${RELATION_LABEL[r.state]}(${r.opinion.toFixed(2)})`);
      dayReports.push(
        `  ${civ.name.padEnd(16)} x${civ.speed} civDay ${civ.day} pop ${alive.length} (${civ.settlements.length} stl, ${eraOf(world, civ.capital?.id ?? -1)}) food ${civFood(world, civ)}  h ${avg('hunger')} t ${avg('thirst')} e ${avg('energy')} hp ${avg('health')}  built {${[...counts].map(([k, v]) => `${k}:${v}`).join(' ')}} sites [${sites.join(',')}]`,
      );
      dayReports.push(
        `      leader ${leader?.name ?? '-'} (${leader?.persona.join('/') ?? ''}) obj [${civ.objectives.map((o) => o.kind).join(',')}] regions ${civ.knowledge.regions.size} landmarks ${civ.knowledge.landmarks.size} prospects ${civ.knowledge.prospects.length} rels [${rels.join(' ')}] rep f${civ.rep.faith.toFixed(2)} fe${civ.rep.fear.toFixed(2)} t${civ.rep.trust.toFixed(2)}`,
      );
    }
  }
}
const runMs = performance.now() - t1;

for (const a of world.agents) {
  for (const e of a.log) {
    if (e.kind !== 'fail') continue;
    const reason = e.text.replace(/^.*failed: /, '').replace(/[A-Z][a-z]+ (was|had|walked|moved)/, 'X $1');
    failReasons.set(reason, (failReasons.get(reason) ?? 0) + 1);
  }
}

console.log(`seed ${seed}  pop ${pop}  days ${days}  gen ${genMs.toFixed(0)}ms  sim ${runMs.toFixed(0)}ms (${((steps / runMs) * 1000).toFixed(0)} steps/s, max step ${maxStepMs.toFixed(2)}ms)`);
for (const r of dayReports) console.log(r);
console.log('\nTime share by goal:');
const total = [...goalTime.values()].reduce((s, v) => s + v, 0);
for (const [g, t] of [...goalTime.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${g.padEnd(10)} ${((t / total) * 100).toFixed(1)}%`);
console.log('\nPer agent:');
for (const a of world.agents) {
  const hours = Math.max(1, (world.now(a) - 7 * (DAY_LENGTH / 24)) / (DAY_LENGTH / 24));
  console.log(
    `  ${(world.civs[a.civId]?.name ?? '?').slice(0, 10).padEnd(10)} ${a.name.padEnd(8)} ${a.alive ? 'alive' : `DEAD(${a.deathCause})`} traits=${a.traits.join('/')} home=${a.homeId ?? '-'} switches/h=${(a.brain.switches / hours).toFixed(2)} ate=${a.stats.foodEaten} wood=${a.stats.woodChopped} work=${a.stats.workDone.toFixed(0)}s talks=${a.stats.conversations} helped=${a.stats.helped} dist=${a.stats.distance.toFixed(0)} knownFood=${a.memory.knownFoodCount()} water=${a.memory.water.size}`,
  );
}
const ps = world.paths.finder.stats;
console.log(`\nPaths: ${ps.searches} searches, ${ps.failures} failures, avg ${(world.paths.msTotal / Math.max(1, world.paths.solvedTotal)).toFixed(2)}ms, avg expanded ${(ps.expanded / Math.max(1, ps.searches)).toFixed(0)}`);
console.log(`NaN positions: ${nanCount}`);
console.log(`Stats: ${JSON.stringify(world.stats)}`);
console.log(`Structures: ${world.structures.length} (${world.structures.filter((s) => !s.complete).map((s) => `${BLUEPRINTS[s.kind].name}(${Math.round(s.progress * 100)}%)`).join(', ')})`);
console.log('\nFailure reasons:');
for (const [r, n] of [...failReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${n}x ${r}`);
if (!quiet) {
  console.log('\nFeed:');
  for (const f of feed.slice(-90)) console.log('  ' + f);
}
if (logName) {
  const a = world.agents.find((x) => x.name === logName) ?? world.agents[0]!;
  console.log(`\nDecision log for ${a.name}:`);
  for (const e of a.log) console.log(`  D${Math.floor(e.time / DAY_LENGTH) + 1} ${world.clockString(e.time)} [${e.kind}] ${e.text}`);
  const civ = world.civs[a.civId];
  if (civ) {
    console.log(`\nHistory of ${civ.name}:`);
    for (const h of civ.history) console.log(`  Day ${h.day} [${h.kind}] ${h.text}`);
    console.log(`\nLeader memory: ${civ.mind.summary}`);
    for (const m of civ.mind.memories) console.log(`  ${m}`);
  }
}
if (args.includes('--stuck')) {
  console.log('\nStuck events:');
  for (const s of world.stuckLog.slice(-40)) {
    const a = world.agent(s.id)!;
    const cellInfo = (x: number, z: number) => `${world.nav.walkable(x, z) ? 'W' : 'B'}${world.nav.terrainWalkable(x, z) ? '' : '(terrain)'} h=${world.terrain.heightAt(x, z).toFixed(2)} slope=${world.terrain.slopeAt(x, z).toFixed(2)}`;
    console.log(`  ${a.name} t=${world.clockString(s.time)} final=${s.final} at (${s.x.toFixed(1)},${s.z.toFixed(1)}) ${cellInfo(s.x, s.z)} -> wp (${s.wx.toFixed(1)},${s.wz.toFixed(1)}) ${cellInfo(s.wx, s.wz)} d=${Math.hypot(s.wx - s.x, s.wz - s.z).toFixed(2)}`);
  }
}
