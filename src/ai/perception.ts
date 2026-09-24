import type { Agent } from '../agents/Agent';
import type { World } from '../sim/World';
import { isFoodKind, resourceLabel } from '../sim/types';
import { describePlace, withArticle } from './describe';
import { firstContact, adjustOpinion, territoryAt } from '../civ/civSystem';
import { LANDMARK_INFO } from '../world/biomes';
import { campCenter } from '../sim/settlement';
import { hash01 } from '../core/rng';

/** What an agent notices around itself; updates its memory. Called once per think. */
export function perceive(a: Agent, w: World): void {
  const R = (w.isNight ? 10 : 17) + (a.has('curious') ? 3 : 0);
  const time = w.time;
  w.resourceHash.query(a.x, a.z, R, (r) => {
    const food = isFoodKind(r.kind);
    if (!food && r.kind !== 'rock' && r.kind !== 'crystal') return;
    const amount = r.state === 'grown' && r.burning <= 0 ? r.amount : 0;
    if (!food && amount <= 0 && !a.memory.resources.has(r.id)) return;
    const known = a.memory.resources.get(r.id);
    const isNew = a.memory.rememberResource({ id: r.id, kind: r.kind, x: r.x, z: r.z, amount, seenAt: time, source: 'seen' });
    if (known && known.avoidUntil > time && amount > 0) known.avoidUntil = 0;
    if (isNew && amount > 0 && (food || r.kind === 'crystal')) {
      a.stats.discoveries++;
      a.addLog(time, 'learn', `Found ${withArticle(resourceLabel(r).toLowerCase())} ${describePlace(w, r.x, r.z, false, a)}.`);
      if (r.kind === 'crystal' && !civKnows(w, a, r.id) && !(w.civOf(a)?.timers.has('foundCrystal') ?? true)) {
        w.civOf(a)!.timers.set('foundCrystal', time);
        w.log(`${a.name} of ${w.civOf(a)!.name} found glowing crystal ${describePlace(w, r.x, r.z, false, a)}.`, 'crystal', 2, r, a.id);
      }
    }
  });
  for (const p of w.water) {
    const d = Math.hypot(p.x - a.x, p.z - a.z) - p.radius;
    if (d > R) continue;
    const prev = a.memory.water.get(p.id);
    if (!prev) {
      a.memory.water.set(p.id, { pondId: p.id, x: p.x, z: p.z, seenAt: time, avoidUntil: 0 });
      a.addLog(time, 'learn', `Found fresh water ${describePlace(w, p.x, p.z, true, a)}.`);
      a.stats.discoveries++;
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
  if (a.isChild) return;
  noticeWorld(a, w, R);
}

function civKnows(w: World, self: Agent, id: number): boolean {
  const civ = w.civOf(self);
  if (!civ) return false;
  return civ.members.some((o) => o !== self && o.memory.resources.has(id));
}

/** Landmarks, new regions, strangers, and land worth settling. */
function noticeWorld(a: Agent, w: World, R: number): void {
  const civ = w.civOf(a);
  if (!civ) return;
  const time = w.time;
  // Wonders are visible from afar.
  for (const l of w.terrain.landmarks) {
    if (a.seenLandmarks.has(l.id)) continue;
    const d = Math.hypot(l.x - a.x, l.z - a.z);
    if (d > (w.isNight ? l.sight * 0.5 : l.sight)) continue;
    a.seenLandmarks.add(l.id);
    const info = LANDMARK_INFO[l.kind];
    a.addLog(time, 'learn', `Saw ${l.name}! ${info.lore}`);
    a.emote = { icon: 'star', until: time + 4 };
    a.faith = Math.min(1, a.faith + (l.kind === 'floatingRocks' || l.kind === 'temple' || l.kind === 'stoneCircle' ? 0.08 : 0.03));
    if (l.kind === 'titanBones') a.needs.safety = Math.max(0, a.needs.safety - 0.15);
    if (!civ.knowledge.landmarks.has(l.id) && !a.news.some((n) => n.kind === 'landmark' && n.id === l.id)) a.news.push({ kind: 'landmark', id: l.id });
    a.thought = `${l.name}... ${l.kind === 'titanBones' ? 'what could have been that big?' : l.kind === 'floatingRocks' ? 'stones floating in the air!' : 'I have to tell the others.'}`;
  }
  // New land.
  const region = w.terrain.regionAt(a.x, a.z);
  if (region && !civ.knowledge.regions.has(region.id) && !a.news.some((n) => n.kind === 'region' && n.id === region.id)) {
    a.news.push({ kind: 'region', id: region.id });
    a.addLog(time, 'learn', `Walked into ${region.name}.`);
  }
  // Strangers: other peoples' folk or their settlements.
  const owner = territoryAt(w, a.x, a.z);
  if (owner >= 0 && owner !== civ.id && !civ.knows(owner)) {
    firstContact(w, a, null, owner, { x: a.x, z: a.z });
  }
  let met: Agent | null = null;
  w.agentHash.query(a.x, a.z, R, (o) => {
    if (o.civId === a.civId || !o.alive || o.civId < 0 || o.inside !== null) return;
    met = o;
    return true;
  });
  if (met) {
    const o: Agent = met;
    if (!civ.knows(o.civId)) firstContact(w, a, o, o.civId, { x: a.x, z: a.z });
    else encounter(a, o, w);
  }
  // Scouting: note land that would make a good home, when far from our own.
  const home = campCenter(w, a.settlementId);
  const far = Math.hypot(a.x - home.x, a.z - home.z);
  if (far > 60 && owner < 0 && (a.brain.cooldowns.get('scout') ?? 0) <= time) {
    a.brain.cooldowns.set('scout', time + 20);
    const p = scoreSite(w, a.x, a.z);
    if (p.score > 3.2 && !a.news.some((n) => n.kind === 'prospect' && n.at && Math.hypot(n.at.x - a.x, n.at.z - a.z) < 40)) {
      a.news.push({ kind: 'prospect', id: 0, at: { x: a.x, z: a.z }, score: p.score, note: p.note });
      a.addLog(time, 'learn', `This would be a good place to live: ${p.note}.`);
    }
  }
}

/** How good a spot would be for a new village: water, food, timber, flat ground. */
export function scoreSite(w: World, x: number, z: number): { score: number; note: string } {
  const t = w.terrain;
  if (t.slopeAt(x, z) > 0.25 || t.heightAt(x, z) < 1.4 || t.isWater(x, z)) return { score: 0, note: '' };
  let water = Infinity;
  for (const wb of w.water) water = Math.min(water, Math.hypot(wb.x - x, wb.z - z) - wb.radius);
  let food = 0;
  let trees = 0;
  let stone = 0;
  w.resourceHash.query(x, z, 30, (r) => {
    if (r.state !== 'grown') return;
    if (isFoodKind(r.kind)) food += r.kind === 'fruitTree' ? 2 : 1;
    else if (r.kind === 'tree') trees++;
    else if (r.kind === 'rock') stone++;
  });
  for (const s of w.settlements) if (Math.hypot(s.x - x, s.z - z) < 70) return { score: 0, note: '' };
  const score = (water < 30 ? 2 : water < 60 ? 0.8 : 0) + Math.min(3, food * 0.25) + Math.min(1.5, trees * 0.05) + Math.min(1, stone * 0.2);
  const bits: string[] = [];
  if (water < 30) bits.push('fresh water close by');
  if (food > 6) bits.push('plenty of food');
  if (trees > 20) bits.push('good timber');
  if (stone > 3) bits.push('stone to build with');
  const region = t.regionAt(x, z);
  return { score, note: `${bits.join(', ') || 'open land'}${region ? ` in ${region.name}` : ''}` };
}

/** Meeting someone from a people we already know. */
function encounter(a: Agent, o: Agent, w: World): void {
  const civ = w.civOf(a);
  const other = w.civOf(o);
  if (!civ || !other) return;
  const rel = civ.relation(other.id);
  rel.lastContact = w.worldTime;
  const key = `meet:${other.id}`;
  if ((a.brain.cooldowns.get(key) ?? 0) > w.time) return;
  a.brain.cooldowns.set(key, w.time + 90);
  if (rel.state === 'hostile' || rel.state === 'tense') {
    a.memory.addDanger({ x: o.x, z: o.z, at: w.time, kind: 'hostile' });
    a.needs.safety = Math.max(0, a.needs.safety - (rel.state === 'hostile' ? 0.25 : 0.1) * (a.has('timid') ? 1.4 : a.has('brave') ? 0.5 : 1));
    a.emote = { icon: 'warning', until: w.time + 3 };
    a.addLog(w.time, 'event', `Ran into ${o.name} of ${other.name}. ${rel.state === 'hostile' ? 'They glared at me.' : 'We eyed each other warily.'}`);
    if (rel.state === 'hostile' && hash01(a.id, Math.floor(w.worldTime)) < 0.25) adjustOpinion(w, civ, other, -0.03, `A tense meeting with ${other.name} near ${describePlace(w, a.x, a.z, false, a)}.`);
  } else {
    a.emote = { icon: 'social', until: w.time + 3 };
    a.addLog(w.time, 'event', `Waved to ${o.name} of ${other.name}.`);
    if (hash01(a.id, Math.floor(w.worldTime)) < 0.3) adjustOpinion(w, civ, other, 0.01, '');
  }
}
