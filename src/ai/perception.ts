import type { Agent } from '../agents/Agent';
import type { World } from '../sim/World';
import { resourceLabel } from '../sim/types';
import { describePlace, withArticle } from './describe';

/** What an agent notices around itself; updates its memory. Called once per think. */
export function perceive(a: Agent, w: World): void {
  const R = (w.isNight ? 10 : 17) + (a.has('curious') ? 3 : 0);
  const time = w.time;
  w.resourceHash.query(a.x, a.z, R, (r) => {
    if (r.kind !== 'berryBush' && r.kind !== 'fruitTree') return;
    const amount = r.state === 'grown' && r.burning <= 0 ? r.amount : 0;
    const known = a.memory.resources.get(r.id);
    const isNew = a.memory.rememberResource({ id: r.id, kind: r.kind, x: r.x, z: r.z, amount, seenAt: time, source: 'seen' });
    if (known && known.avoidUntil > time && amount > 0) known.avoidUntil = 0;
    if (isNew && amount > 0) {
      a.stats.discoveries++;
      a.addLog(time, 'learn', `Found ${withArticle(resourceLabel(r).toLowerCase())} ${describePlace(w, r.x, r.z)}.`);
      if (r.kind === 'fruitTree' && !tribeKnows(w, a, r.id) && w.time > w.startTime + 5) {
        w.log(`${a.name} discovered a fruit tree ${describePlace(w, r.x, r.z)}.`, 'food', 2, r, a.id);
      }
    }
  });
  for (const p of w.water) {
    const d = Math.hypot(p.x - a.x, p.z - a.z) - p.radius;
    if (d > R) continue;
    const prev = a.memory.water.get(p.id);
    if (!prev) {
      a.memory.water.set(p.id, { pondId: p.id, x: p.x, z: p.z, seenAt: time, avoidUntil: 0 });
      a.addLog(time, 'learn', `Found a freshwater pond ${describePlace(w, p.x, p.z, true)}.`);
      a.stats.discoveries++;
      if (!w.agents.some((o) => o !== a && o.memory.water.has(p.id)) && w.time > w.startTime + 5) {
        w.log(`${a.name} found a freshwater pond ${describePlace(w, p.x, p.z, true)}.`, 'water', 2, p, a.id);
      }
    } else prev.seenAt = time;
  }
  // Fires and other visible dangers.
  for (const d of w.dangers) {
    const dist = Math.hypot(d.x - a.x, d.z - a.z);
    if (d.kind === 'fire' && dist < R) {
      const last = a.memory.dangers[a.memory.dangers.length - 1];
      if (!last || Math.hypot(last.x - d.x, last.z - d.z) > 3 || time - last.at > 20) a.memory.addDanger({ x: d.x, z: d.z, at: time, kind: 'fire' });
    }
  }
  a.memory.markExplored(a.x, a.z, R, time);
}

function tribeKnows(w: World, self: Agent, id: number): boolean {
  return w.agents.some((o) => o !== self && o.memory.resources.has(id));
}
