import type { V2 } from '../core/math';
import type { Agent } from '../agents/Agent';
import type { World } from '../sim/World';
import type { Structure } from '../sim/types';
import { BLUEPRINTS } from '../sim/blueprints';
import { DAY_LENGTH, HOUR, MAP_CELL, MAP_N, WORLD_HALF } from '../world/config';
import { LANDMARK_INFO } from '../world/biomes';
import { Civilization, nextObjectiveId, stateFromOpinion, RELATION_LABEL, type HistoryEntry, type Objective } from './Civilization';
import { PERSONAS } from './persona';
import { development, campCenter, civFood, eraOf, isHome } from '../sim/settlement';
import { divineUpdate } from './divine';
import { leaderUpdate, leaderMemory, requestLeaderThought } from './leader';

/** Record something in a civilization's history (and the world chronicle when important). */
export function civHistory(w: World, civ: Civilization, text: string, kind: HistoryEntry['kind'], importance: 1 | 2 | 3): void {
  civ.addHistory({ time: w.worldTime, day: civ.day, text, kind, importance });
}

export function leaderOf(w: World, civ: Civilization): Agent | undefined {
  const a = w.agent(civ.leaderId);
  return a && a.alive ? a : undefined;
}

export function onBuilt(w: World, civ: Civilization, s: Structure): void {
  const name = BLUEPRINTS[s.kind].name.toLowerCase();
  const settlement = w.settlement(s.settlementId);
  const count = w.structures.filter((o) => o.civId === civ.id && o.kind === s.kind && o.complete).length;
  if (count === 1 && s.kind !== 'grave' && s.kind !== 'tent') {
    civHistory(w, civ, `Built their first ${name}${settlement && !settlement.capital ? ` at ${settlement.name}` : ''}.`, 'building', s.kind === 'hall' || s.kind === 'monument' || s.kind === 'campfire' ? 3 : 2);
    if (s.kind === 'hall' || s.kind === 'monument' || s.kind === 'workshop') {
      leaderMemory(civ, `We raised our first ${name}.`, 2);
      requestLeaderThought(w, civ, `milestone: first ${name}`);
    }
  }
  // Era changes are worth a line in the history.
  const era = eraOf(w, s.settlementId);
  const key = `era:${s.settlementId}`;
  const prev = civ.timers.get(key) ?? 0;
  const rank = era === 'Town' ? 2 : era === 'Village' ? 1 : 0;
  if (rank > prev) {
    civ.timers.set(key, rank);
    const where = settlement?.name ?? civ.name;
    civHistory(w, civ, `${where} grew from a ${prev === 0 ? 'camp' : 'village'} into a ${era.toLowerCase()}.`, 'growth', 3);
    w.log(`${where} of ${civ.name} has grown into a ${era.toLowerCase()}!`, 'star', 3, s, undefined);
    w.events.emit('civEvent', { civId: civ.id, kind: 'era', text: `${where} is now a ${era.toLowerCase()}`, x: s.x, z: s.z });
  }
}

/** Map cell index for a world position. */
export function mapIndex(x: number, z: number): number {
  const cx = Math.floor((x + WORLD_HALF) / MAP_CELL);
  const cz = Math.floor((z + WORLD_HALF) / MAP_CELL);
  if (cx < 0 || cz < 0 || cx >= MAP_N || cz >= MAP_N) return -1;
  return cz * MAP_N + cx;
}

export function territoryAt(w: World, x: number, z: number): number {
  const i = mapIndex(x, z);
  return i < 0 ? -1 : w.territory[i]!;
}

/**
 * World-level and civilization-level upkeep that isn't per-agent: territory, relations,
 * reports from explorers, leadership, expansion, and everything the god does to them.
 */
export class CivSystem {
  private territoryT = 0;
  private relationT = 0;

  /** World context, once per world step. */
  worldUpdate(w: World, dt: number): void {
    this.territoryT -= dt;
    if (this.territoryT <= 0) {
      this.territoryT = 12;
      recomputeTerritory(w);
    }
    this.relationT -= dt;
    if (this.relationT <= 0) {
      this.relationT = 5;
      updateRelations(w, 5);
    }
    divineUpdate(w, dt);
    for (const civ of w.civs) {
      for (let i = civ.effects.length - 1; i >= 0; i--) if (civ.effects[i]!.until < w.worldTime) civ.effects.splice(i, 1);
    }
  }

  /** Civilization context, once per substep of that civilization. */
  civUpdate(w: World, civ: Civilization, dt: number): void {
    void dt;
    if (!civ.timerDue('upkeep', w.time)) return;
    civ.setTimer('upkeep', w.time + 3);
    if (civ.population === 0) return;
    succession(w, civ);
    reports(w, civ);
    expansion(w, civ);
    objectivesUpkeep(w, civ);
    leaderUpdate(w, civ);
  }
}

// ---------------------------------------------------------------------------
// Territory
// ---------------------------------------------------------------------------

export function recomputeTerritory(w: World): void {
  const t = w.territory;
  const next = new Int8Array(t.length).fill(-1);
  const best = new Float32Array(t.length);
  for (const s of w.settlements) {
    const civ = w.civs[s.civId];
    if (!civ) continue;
    const people = w.settlers(s.id).length;
    if (people === 0 && !w.structures.some((o) => o.settlementId === s.id && o.complete && o.kind !== 'grave')) continue;
    const dev = development(w, s.id);
    const c = campCenter(w, s.id);
    const radius = Math.min(78, 24 + dev * 0.55 + people * 0.8);
    const r = Math.ceil(radius / MAP_CELL) + 1;
    const cx0 = Math.floor((c.x + WORLD_HALF) / MAP_CELL);
    const cz0 = Math.floor((c.z + WORLD_HALF) / MAP_CELL);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = cx0 + dx;
        const cz = cz0 + dz;
        if (cx < 0 || cz < 0 || cx >= MAP_N || cz >= MAP_N) continue;
        const x = (cx + 0.5) * MAP_CELL - WORLD_HALF;
        const z = (cz + 0.5) * MAP_CELL - WORLD_HALF;
        if (w.terrain.heightAt(x, z) < 0.1) continue;
        const d = Math.hypot(x - c.x, z - c.z);
        if (d > radius) continue;
        const infl = (1 + dev * 0.02) / (1 + (d / radius) ** 2 * 3);
        const i = cz * MAP_N + cx;
        if (infl > best[i]!) {
          best[i] = infl;
          next[i] = civ.id;
        }
      }
    }
  }
  let changed = false;
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== next[i]) {
      changed = true;
      t[i] = next[i]!;
    }
  }
  if (changed) {
    w.territoryVersion++;
    w.events.emit('territory', undefined);
  }
}

/** Number of map cells where two civilizations' territories touch. */
function borderContact(w: World, a: number, b: number): number {
  const t = w.territory;
  let n = 0;
  for (let cz = 0; cz < MAP_N; cz++) {
    for (let cx = 0; cx < MAP_N; cx++) {
      const i = cz * MAP_N + cx;
      if (t[i] !== a) continue;
      if ((cx + 1 < MAP_N && t[i + 1] === b) || (cx > 0 && t[i - 1] === b) || (cz + 1 < MAP_N && t[i + MAP_N] === b) || (cz > 0 && t[i - MAP_N] === b)) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

function diplomacy(w: World, civ: Civilization): number {
  const l = leaderOf(w, civ);
  let d = 0;
  for (const t of l?.persona ?? []) d += PERSONAS[t].diplomacy;
  return d;
}

function updateRelations(w: World, dt: number): void {
  for (const a of w.civs) {
    for (const [bid, r] of a.relations) {
      if (r.state === 'unknown') continue;
      const b = w.civs[bid];
      if (!b) continue;
      const dip = diplomacy(w, a);
      const contact = borderContact(w, a.id, b.id);
      // Drift toward a temperament-dependent resting point; crowded borders sour things.
      const rest = dip * 0.5 - Math.min(0.5, contact * 0.05);
      let drift = (rest - r.opinion) * 0.004 * dt;
      if (r.truceUntil > w.worldTime) drift = Math.max(drift, 0.01 * dt);
      if (a.objectives.some((o) => o.kind === 'SEEK_PEACE' && o.civ === b.id)) drift += 0.004 * dt;
      if (a.objectives.some((o) => o.kind === 'AVOID_CIVILIZATION' && o.civ === b.id)) drift -= 0.001 * dt;
      r.opinion = Math.max(-1, Math.min(1, r.opinion + drift));
      const prev = r.state;
      r.state = stateFromOpinion(r.state, r.opinion);
      if (prev !== r.state) {
        const text = `Relations between ${a.name} and ${b.name} are now ${RELATION_LABEL[r.state].toLowerCase()}.`;
        civHistory(w, a, `Relations with ${b.name} became ${RELATION_LABEL[r.state].toLowerCase()}.`, 'relation', r.state === 'hostile' || r.state === 'friendly' ? 3 : 2);
        if (a.id < b.id || !b.knows(a.id)) w.log(text, r.state === 'hostile' || r.state === 'tense' ? 'warning' : 'social', r.state === 'hostile' ? 3 : 2, campCenter(w, a.capital?.id ?? -1));
        leaderMemory(a, `Our bond with ${b.name} turned ${RELATION_LABEL[r.state].toLowerCase()}.`, r.state === 'hostile' ? 3 : 2);
        requestLeaderThought(w, a, `relations with ${b.name} became ${r.state}`);
      }
    }
  }
}

/** Nudge how one people feels about another (both directions, asymmetric). */
export function adjustOpinion(w: World, a: Civilization, b: Civilization, delta: number, why: string): void {
  if (a === b) return;
  const r = a.relation(b.id);
  if (r.state === 'unknown') return;
  r.opinion = Math.max(-1, Math.min(1, r.opinion + delta));
  r.lastContact = w.worldTime;
  if (delta > 0.05) r.gifts++;
  if (delta < -0.05) r.quarrels++;
  if (Math.abs(delta) >= 0.1) leaderMemory(a, why, 2);
}

/**
 * Two peoples see each other for the first time. Called from perception in the observer's
 * context; both sides learn of the other.
 */
export function firstContact(w: World, seer: Agent, other: Agent | null, otherCivId: number, where: V2): void {
  const a = w.civs[seer.civId];
  const b = w.civs[otherCivId];
  if (!a || !b || a === b) return;
  const ra = a.relation(b.id);
  if (ra.state !== 'unknown') return;
  const rb = b.relation(a.id);
  const base = (civ: Civilization, o: Civilization) => {
    let v = 0.05 + diplomacy(w, civ) * 0.5;
    if (civ.def.priorities.defend > 1.2) v -= 0.1;
    if (o.culture === 'ember' || civ.culture === 'ember') v -= 0.05;
    return v;
  };
  ra.opinion = base(a, b);
  ra.state = stateFromOpinion('neutral', ra.opinion);
  ra.metAt = w.worldTime;
  ra.lastContact = w.worldTime;
  if (rb.state === 'unknown') {
    rb.opinion = base(b, a);
    rb.state = stateFromOpinion('neutral', rb.opinion);
    rb.metAt = w.worldTime;
    rb.lastContact = w.worldTime;
  }
  a.knowledge.civs.add(b.id);
  b.knowledge.civs.add(a.id);
  const what = other ? `${seer.name} of ${a.name} met ${other.name} of ${b.name}` : `${seer.name} of ${a.name} came upon a settlement of ${b.name}`;
  w.log(`First contact! ${what}.`, 'contact', 3, where, seer.id);
  civHistory(w, a, `First contact with ${b.name}, the ${b.people}. ${seer.name} saw them first.`, 'contact', 3);
  civHistory(w, b, `Strangers from ${a.name} (${a.people}) were seen near our lands.`, 'contact', 3);
  leaderMemory(a, `${seer.name} found another people: ${b.name}, the ${b.people}.`, 3);
  leaderMemory(b, `Strangers called ${a.name} have come near our lands.`, 3);
  w.events.emit('civEvent', { civId: a.id, kind: 'contact', text: what, x: where.x, z: where.z, other: b.id });
  seer.addLog(w.now(seer), 'event', `Strangers! People from ${b.name}.`);
  seer.emote = { icon: 'warning', until: w.now(seer) + 5 };
  requestLeaderThought(w, a, `first contact with ${b.name}`);
  requestLeaderThought(w, b, `first contact with ${a.name}`);
}

// ---------------------------------------------------------------------------
// Explorers coming home with news
// ---------------------------------------------------------------------------

function reports(w: World, civ: Civilization): void {
  for (const a of civ.members) {
    if (!a.alive || a.isChild || !a.news.length) continue;
    const home = campCenter(w, a.settlementId);
    if (Math.hypot(a.x - home.x, a.z - home.z) > 26) continue;
    // Share the map they walked.
    for (let i = 0; i < a.memory.explored.length; i++) if (a.memory.explored[i]! > 0) civ.knowledge.map[i] = 1;
    for (const n of a.news.splice(0)) {
      if (n.kind === 'landmark') {
        if (civ.knowledge.landmarks.has(n.id)) continue;
        civ.knowledge.landmarks.add(n.id);
        civ.stats.discoveries++;
        const l = w.terrain.landmarks.find((x) => x.id === n.id);
        if (!l) continue;
        const first = !w.landmarkFinder.has(l.id);
        if (first) w.landmarkFinder.set(l.id, civ.id);
        const info = LANDMARK_INFO[l.kind];
        w.log(`${a.name} returned to ${civ.name} with news of ${l.name}${first ? ', never seen before' : ''}.`, 'discovery', first ? 3 : 2, l, a.id);
        civHistory(w, civ, `${a.name} discovered ${l.name}. ${info.lore}`, 'discovery', 3);
        leaderMemory(civ, `${a.name} found ${l.name}: ${info.lore.toLowerCase()}`, 2);
        w.events.emit('civEvent', { civId: civ.id, kind: 'discovery', text: `${a.name} found ${l.name}`, x: l.x, z: l.z });
        requestLeaderThought(w, civ, `discovery of ${l.name}`);
        for (const o of civ.members) if (o.alive) o.faith = Math.min(1, o.faith + (l.kind === 'temple' || l.kind === 'floatingRocks' || l.kind === 'stoneCircle' ? 0.05 : 0.02));
      } else if (n.kind === 'region') {
        if (civ.knowledge.regions.has(n.id)) continue;
        civ.knowledge.regions.add(n.id);
        const r = w.terrain.regions[n.id];
        if (!r) continue;
        w.log(`${a.name} of ${civ.name} came back from ${r.name}.`, 'explore', 2, r, a.id);
        civHistory(w, civ, `${a.name} explored ${r.name} for the first time.`, 'discovery', 2);
        leaderMemory(civ, `${a.name} explored ${r.name}.`, 1);
      } else if (n.kind === 'prospect' && n.at) {
        if (civ.knowledge.prospects.some((p) => Math.hypot(p.x - n.at!.x, p.z - n.at!.z) < 40)) continue;
        civ.knowledge.prospects.push({ x: n.at.x, z: n.at.z, score: n.score ?? 1, note: n.note ?? 'good land', foundAt: w.time });
        civ.knowledge.prospects.sort((p, q) => q.score - p.score);
        if (civ.knowledge.prospects.length > 6) civ.knowledge.prospects.length = 6;
        civHistory(w, civ, `${a.name} reported ${n.note ?? 'good land'}.`, 'discovery', 1);
      }
    }
    a.addLog(w.now(a), 'event', 'Told everyone at home what I found out there.');
  }
}

// ---------------------------------------------------------------------------
// Leadership
// ---------------------------------------------------------------------------

function leadershipScore(w: World, civ: Civilization, a: Agent): number {
  void w;
  let respect = 0;
  for (const o of civ.members) if (o.alive && o !== a) respect += o.affinity(a.id);
  const ageK = Math.min(1, (a.age - 18) / 25);
  const bold = a.persona.includes('ambitious') || a.persona.includes('proud') ? 0.4 : 0;
  return respect + ageK * 1.5 + bold + a.stats.workDone / 3000 + a.faith * 0.5;
}

export function chooseLeader(w: World, civ: Civilization, exclude: number[] = []): Agent | undefined {
  const cap = civ.capital?.id;
  let best: Agent | undefined;
  let bs = -Infinity;
  for (const a of civ.members) {
    if (!a.alive || a.isChild || exclude.includes(a.id)) continue;
    const s = leadershipScore(w, civ, a) + (a.settlementId === cap ? 1 : 0);
    if (s > bs) {
      bs = s;
      best = a;
    }
  }
  return best;
}

export function crownLeader(w: World, civ: Civilization, a: Agent, why: string): void {
  const prev = civ.leaders[civ.leaders.length - 1];
  if (prev && prev.to < 0) prev.to = w.worldTime;
  civ.leaderId = a.id;
  civ.leaders.push({ id: a.id, name: a.name, from: w.worldTime, to: -1, persona: [...a.persona] });
  civ.mind.lastPlan = -1e9;
  const traits = a.persona.map((t) => PERSONAS[t].label.toLowerCase()).join(' and ');
  if (civ.leaders.length === 1) {
    civHistory(w, civ, `${a.name} was chosen to lead the ${civ.people}. ${why}`, 'leader', 3);
  } else {
    civHistory(w, civ, `${a.name} became leader of ${civ.name}. ${why}`, 'leader', 3);
    w.log(`${a.name} is the new leader of ${civ.name}, a ${traits} ${a.age < 25 ? 'youth' : 'elder'}.`, 'crown', 3, a, a.id);
    w.events.emit('civEvent', { civId: civ.id, kind: 'leader', text: `${a.name} now leads ${civ.name}`, x: a.x, z: a.z });
    if (prev) leaderMemory(civ, `Before me, ${prev.name} led us${prev.persona.length ? `, a ${prev.persona.map((t) => PERSONAS[t].label.toLowerCase()).join(' and ')} leader` : ''}.`, 2);
  }
  a.addLog(w.now(a), 'event', `The people chose me to lead ${civ.name}.`);
  requestLeaderThought(w, civ, 'new leader');
}

/** Make sure every people has a leader from the start (world context). */
export function ensureLeaders(w: World): void {
  for (const civ of w.civs) {
    if (civ.population === 0 || leaderOf(w, civ)) continue;
    w.withCiv(civ, () => succession(w, civ));
  }
}

function succession(w: World, civ: Civilization): void {
  const leader = w.agent(civ.leaderId);
  if (leader && leader.alive) {
    // A leader who has presided over long misery may be pushed aside.
    const reign = civ.leaders[civ.leaders.length - 1];
    const long = reign ? w.worldTime - reign.from > DAY_LENGTH * 5 : false;
    if (long && civ.timerDue('council', w.time)) {
      civ.setTimer('council', w.time + DAY_LENGTH);
      const living = civ.living.filter((a) => !a.isChild);
      const misery = living.length ? living.reduce((s, a) => s + (1 - Math.min(a.needs.hunger, a.needs.safety, a.needs.health)), 0) / living.length : 0;
      if (misery > 0.62 || civ.rep.anger > 0.8) {
        const rival = chooseLeader(w, civ, [leader.id]);
        if (rival) {
          w.log(`The ${civ.people} have lost faith in ${leader.name}. ${rival.name} takes their place.`, 'crown', 3, rival, rival.id);
          crownLeader(w, civ, rival, `${leader.name} was pushed aside after hard times.`);
        }
      }
    }
    return;
  }
  const next = chooseLeader(w, civ);
  if (!next) return;
  const why = leader && !leader.alive ? `${leader.name} had died.` : 'They needed someone to speak for them.';
  crownLeader(w, civ, next, why);
}

// ---------------------------------------------------------------------------
// Expansion: founding new settlements
// ---------------------------------------------------------------------------

function expansion(w: World, civ: Civilization): void {
  if (!civ.timerDue('expand', w.time)) return;
  civ.setTimer('expand', w.time + HOUR * 3);
  const want = civ.objectives.find((o) => o.kind === 'ESTABLISH_SETTLEMENT' || o.kind === 'MIGRATE');
  if (!want) return;
  const cap = civ.capital;
  if (!cap) return;
  const settlers = w.settlers(cap.id).filter((a) => !a.isChild);
  if (settlers.length < 8 && want.kind !== 'MIGRATE') {
    want.status = 'Waiting for more people';
    return;
  }
  if (civ.settlements.length >= 4) {
    want.status = 'They have all the villages they can hold';
    return;
  }
  const target = want.target ?? civ.knowledge.prospects[0];
  if (!target) {
    want.status = 'Explorers are looking for good land';
    return;
  }
  // Is it still free?
  const owner = territoryAt(w, target.x, target.z);
  if (owner >= 0 && owner !== civ.id) {
    want.status = 'That land belongs to others now';
    civ.knowledge.prospects = civ.knowledge.prospects.filter((p) => p !== target);
    want.target = undefined;
    return;
  }
  const spot = w.nav.nearestWalkable(target.x, target.z, 12);
  if (!spot) return;
  const leaderId = civ.leaderId;
  const pool = settlers.filter((a) => a.id !== leaderId).sort((a, b) => (b.persona.includes('ambitious') ? 1 : 0) + (b.has('brave') ? 1 : 0) - ((a.persona.includes('ambitious') ? 1 : 0) + (a.has('brave') ? 1 : 0)));
  const size = want.kind === 'MIGRATE' ? Math.ceil(pool.length * 0.7) : Math.max(4, Math.min(6, Math.floor(pool.length * 0.4)));
  const party = pool.slice(0, size);
  if (party.length < 3) return;
  const region = w.terrain.regionAt(spot.x, spot.z);
  const name = newSettlementName(w, civ);
  const st = w.foundSettlement(civ, spot, false, name);
  for (const a of party) {
    const old = w.structure(a.homeId);
    if (old) old.residents = old.residents.filter((id) => id !== a.id);
    a.homeId = null;
    a.settlementId = st.id;
    a.addLog(w.now(a), 'event', `Setting out to found ${name}${region ? ` in ${region.name}` : ''}.`);
    for (const k of civ.members) {
      if (k.alive && k.isChild && k.parents.includes(a.id)) {
        const oh = w.structure(k.homeId);
        if (oh) oh.residents = oh.residents.filter((id) => id !== k.id);
        k.homeId = null;
        k.settlementId = st.id;
      }
    }
  }
  if (want.kind === 'MIGRATE') {
    for (const s of civ.settlements) s.capital = s === st;
  }
  civ.knowledge.prospects = civ.knowledge.prospects.filter((p) => Math.hypot(p.x - spot.x, p.z - spot.z) > 40);
  const names = party.map((a) => a.name);
  civHistory(w, civ, `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} others` : ''} set out to found ${name}${region ? ` in ${region.name}` : ''}.`, 'founding', 3);
  w.log(`${civ.name} is founding a new settlement, ${name}${region ? `, in ${region.name}` : ''}.`, 'build', 3, spot);
  w.events.emit('civEvent', { civId: civ.id, kind: 'settlement', text: `${civ.name} founded ${name}`, x: spot.x, z: spot.z });
  leaderMemory(civ, `We sent ${party.length} people to found ${name}.`, 2);
  civ.objectives.splice(civ.objectives.indexOf(want), 1);
}

function newSettlementName(w: World, civ: Civilization): string {
  const d = civ.def;
  const taken = new Set(w.settlements.map((s) => s.name));
  const suffix = { vale: ['stead', 'ford', 'mere', 'field'], grove: ['hollow', 'glade', 'root', 'shade'], stone: ['hold', 'cairn', 'crag', 'fell'], ember: ['forge', 'brand', 'reach', 'watch'], glass: ['light', 'spire', 'glimmer', 'rest'] }[civ.culture];
  for (let i = 0; i < 40; i++) {
    const n = `${d.onset[(i * 7 + civ.settlements.length * 3) % d.onset.length]}${suffix[(i + civ.settlements.length) % suffix.length]}`;
    if (!taken.has(n)) return n;
  }
  return `${civ.name} ${civ.settlements.length + 1}`;
}

function objectivesUpkeep(w: World, civ: Civilization): void {
  void w;
  for (let i = civ.objectives.length - 1; i >= 0; i--) {
    const o = civ.objectives[i]!;
    if (o.until < w.worldTime) {
      civ.objectives.splice(i, 1);
      continue;
    }
    // Keep a readable status.
    if (o.kind === 'PRIORITIZE_FOOD') {
      const food = civFood(w, civ);
      o.status = `${food} food in the stores`;
      if (food > civ.population * 4) civ.objectives.splice(i, 1);
    } else if (o.kind === 'EXPLORE_REGION' && o.region !== undefined) {
      if (civ.knowledge.regions.has(o.region)) {
        civHistory(w, civ, `Explorers reached ${w.terrain.regions[o.region]?.name ?? 'the far lands'}, as the leader wished.`, 'objective', 1);
        civ.objectives.splice(i, 1);
      } else o.status = 'Explorers are on their way';
    }
  }
}

/** Replace or add an objective of the same kind. */
export function setObjective(w: World, civ: Civilization, o: Omit<Objective, 'id' | 'since' | 'status'> & { status?: string }): Objective {
  const existing = civ.objectives.find((x) => x.kind === o.kind && x.civ === o.civ);
  if (existing) {
    Object.assign(existing, o, { since: w.worldTime, status: o.status ?? existing.status });
    return existing;
  }
  const full: Objective = { id: nextObjectiveId(), since: w.worldTime, ...o, status: o.status ?? '' };
  civ.objectives.push(full);
  while (civ.objectives.length > 3) civ.objectives.shift();
  return full;
}

export function homeStructures(w: World, civ: Civilization): Structure[] {
  return w.structures.filter((s) => s.civId === civ.id && isHome(s));
}
