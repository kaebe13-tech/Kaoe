/**
 * Headless simulation soak test: runs the world for several days at max speed and prints
 * survival, construction, AI decision quality and navigation statistics.
 *
 *   npm run soak -- --seed 1337 --days 5 --pop 6 [--log NAME] [--quiet]
 */
import { World } from '../src/sim/World';
import { Simulation } from '../src/sim/Simulation';
import { DAY_LENGTH, SIM_DT } from '../src/world/config';
import { BLUEPRINTS } from '../src/sim/blueprints';

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const seed = Number(arg('seed', '1337'));
const days = Number(arg('days', '5'));
const pop = Number(arg('pop', '6'));
const logName = arg('log', '');
const quiet = args.includes('--quiet');

const t0 = performance.now();
const world = new World(seed);
world.spawnTribe(pop);
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
  maxStepMs = Math.max(maxStepMs, sim.lastStepMs);
  for (const a of world.agents) {
    if (!a.alive) continue;
    if (!Number.isFinite(a.x) || !Number.isFinite(a.z)) nanCount++;
    const g = a.brain.active?.goal ?? 'none';
    goalTime.set(g, (goalTime.get(g) ?? 0) + SIM_DT);
  }
  if (world.day !== lastDay) {
    lastDay = world.day;
    const alive = world.living;
    const avg = (k: 'hunger' | 'thirst' | 'energy' | 'health' | 'social') => (alive.reduce((s, a) => s + a.needs[k], 0) / Math.max(1, alive.length)).toFixed(2);
    const built = world.structures.filter((s) => s.complete && s.kind !== 'grave').map((s) => s.kind);
    const sites = world.structures.filter((s) => !s.complete).map((s) => `${s.kind}@${Math.round(s.progress * 100)}%`);
    dayReports.push(
      `Day ${world.day - 1} end: alive ${alive.length}/${world.agents.length}  hunger ${avg('hunger')} thirst ${avg('thirst')} energy ${avg('energy')} health ${avg('health')} social ${avg('social')}  built [${built.join(',')}] sites [${sites.join(',')}]`,
    );
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
  const hours = (world.time - 7 * (DAY_LENGTH / 24)) / (DAY_LENGTH / 24);
  console.log(
    `  ${a.name.padEnd(8)} ${a.alive ? 'alive' : `DEAD(${a.deathCause})`} traits=${a.traits.join('/')} home=${a.homeId ?? '-'} switches/h=${(a.brain.switches / hours).toFixed(2)} ate=${a.stats.foodEaten} wood=${a.stats.woodChopped} work=${a.stats.workDone.toFixed(0)}s talks=${a.stats.conversations} helped=${a.stats.helped} dist=${a.stats.distance.toFixed(0)} knownFood=${a.memory.knownFoodCount()} water=${a.memory.water.size}`,
  );
}
const ps = world.paths.finder.stats;
console.log(`\nPaths: ${ps.searches} searches, ${ps.failures} failures, avg ${(world.paths.msTotal / Math.max(1, world.paths.solvedTotal)).toFixed(2)}ms, avg expanded ${(ps.expanded / Math.max(1, ps.searches)).toFixed(0)}`);
console.log(`NaN positions: ${nanCount}`);
console.log(`Structures: ${world.structures.map((s) => `${BLUEPRINTS[s.kind].name}${s.complete ? '' : `(${Math.round(s.progress * 100)}%)`}`).join(', ')}`);
console.log('\nFailure reasons:');
for (const [r, n] of [...failReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${n}x ${r}`);
if (!quiet) {
  console.log('\nFeed:');
  for (const f of feed.slice(-60)) console.log('  ' + f);
}
if (logName) {
  const a = world.agents.find((x) => x.name === logName) ?? world.agents[0]!;
  console.log(`\nDecision log for ${a.name}:`);
  for (const e of a.log) console.log(`  D${Math.floor(e.time / DAY_LENGTH) + 1} ${world.clockString(e.time)} [${e.kind}] ${e.text}`);
}
if (args.includes('--stuck')) {
  console.log('\nStuck events:');
  for (const s of world.stuckLog.slice(-40)) {
    const a = world.agent(s.id)!;
    const cellInfo = (x: number, z: number) => `${world.nav.walkable(x, z) ? 'W' : 'B'}${world.nav.terrainWalkable(x, z) ? '' : '(terrain)'} h=${world.terrain.heightAt(x, z).toFixed(2)} slope=${world.terrain.slopeAt(x, z).toFixed(2)}`;
    console.log(`  ${a.name} t=${world.clockString(s.time)} final=${s.final} at (${s.x.toFixed(1)},${s.z.toFixed(1)}) ${cellInfo(s.x, s.z)} -> wp (${s.wx.toFixed(1)},${s.wz.toFixed(1)}) ${cellInfo(s.wx, s.wz)} d=${Math.hypot(s.wx - s.x, s.wz - s.z).toFixed(2)}`);
  }
}
