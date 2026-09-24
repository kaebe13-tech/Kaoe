import type { Agent } from '../agents/Agent';
import { TAU } from '../core/math';
import { BLUEPRINTS } from './blueprints';
import { adultResidents, allowedProgress, campCenter, homeless, isHome } from './settlement';
import { ITEM_TYPES, type ItemType, type ResourceNode, type Structure } from './types';
import type { World } from './World';
import { civHistory, onBuilt } from '../civ/civSystem';

/** Hand materials to a construction site. Returns how many were accepted. */
export function deliverToSite(w: World, s: Structure, a: Agent, item: ItemType): number {
  const bp = BLUEPRINTS[s.kind];
  const need = (bp.cost[item] ?? 0) - (s.delivered[item] ?? 0);
  const n = Math.min(need, a.inventory[item]);
  if (n <= 0) return 0;
  a.inventory[item] -= n;
  s.delivered[item] = (s.delivered[item] ?? 0) + n;
  w.events.emit('structureChanged', s);
  w.events.emit('sfx', { kind: 'deposit', x: s.x, z: s.z });
  return n;
}

/**
 * Apply labour to a site. Returns 'complete' when finished, 'blocked' when it needs
 * more materials first, otherwise 'ok'.
 */
export function workOnSite(w: World, s: Structure, a: Agent, seconds: number): 'ok' | 'blocked' | 'complete' {
  if (s.complete) return 'complete';
  const bp = BLUEPRINTS[s.kind];
  const allowed = allowedProgress(s);
  if (s.progress >= allowed - 1e-6) return 'blocked';
  const before = s.progress;
  // A finished workshop makes everyone in the settlement quicker.
  const tools = w.structures.some((o) => o.kind === 'workshop' && o.complete && o.settlementId === s.settlementId) ? 1.2 : 1;
  const civ = w.civs[s.civId];
  const blessed = civ?.hasEffect('blessed', w.worldTime) ? 1.25 : 1;
  const cursed = civ?.hasEffect('cursed', w.worldTime) ? 0.75 : 1;
  s.progress = Math.min(allowed, s.progress + (seconds * tools * blessed * cursed) / bp.work);
  if (!s.builders.includes(a.id)) s.builders.push(a.id);
  a.stats.workDone += seconds;
  // Tell the renderer when a visible stage changes (every ~4%).
  if (Math.floor(before * 25) !== Math.floor(s.progress * 25)) w.events.emit('structureChanged', s);
  if (s.progress >= 1 - 1e-6) {
    completeStructure(w, s);
    return 'complete';
  }
  return 'ok';
}

export function completeStructure(w: World, s: Structure): void {
  s.progress = 1;
  s.complete = true;
  s.completedAt = w.time;
  s.delivered = {};
  s.incoming = {};
  w.stats.built++;
  const bp = BLUEPRINTS[s.kind];
  const civ = w.civs[s.civId];
  if (civ) civ.stats.built++;
  const builders = s.builders.map((id) => w.agent(id)?.name).filter(Boolean) as string[];
  const by = builders.length > 2 ? `${builders.slice(0, -1).join(', ')} and ${builders[builders.length - 1]}` : builders.join(' and ');
  const major = s.kind === 'hall' || s.kind === 'monument' || s.kind === 'workshop' || s.kind === 'house' || s.kind === 'campfire';
  w.log(`${by || civ?.name || 'They'} finished ${s.kind === 'hall' || s.kind === 'monument' ? 'the' : 'a'} ${bp.name.toLowerCase()}${civ ? ` (${civ.name})` : ''}!`, isHome(s) ? 'home' : 'build', major ? 3 : 2, s);
  w.events.emit('sfx', { kind: 'complete', x: s.x, z: s.z });
  w.events.emit('fx', { kind: 'buildDust', x: s.x, z: s.z, count: 24 });
  if (s.kind === 'campfire') {
    s.fuel = 0.6;
  }
  if (isHome(s)) {
    if (s.kind !== 'tent') retireTent(w, s);
    assignResidents(w, s);
  }
  if (s.kind === 'garden') plantGarden(w, s);
  if (civ) onBuilt(w, civ, s);
  w.events.emit('structureChanged', s);
}

/** When a real home is finished, the people in the oldest tent move in and the tent comes down. */
function retireTent(w: World, home: Structure): void {
  const tent = w.structures.find((t) => t.kind === 'tent' && t.complete && t.settlementId === home.settlementId);
  if (!tent) return;
  const movers = tent.residents.map((id) => w.agent(id)).filter((a): a is Agent => !!a && a.alive);
  for (const a of movers) {
    a.homeId = null;
    if (a.inside === tent.id) a.inside = null;
  }
  tent.residents = [];
  w.removeStructure(tent);
  const cap = BLUEPRINTS[home.kind].capacity;
  for (const a of movers) {
    if (adultResidents(w, home) >= cap && !a.isChild) continue;
    home.residents.push(a.id);
    a.homeId = home.id;
    a.addLog(w.now(a), 'event', `Moved out of the old tent into the new ${BLUEPRINTS[home.kind].name.toLowerCase()}.`);
  }
  const civ = w.civs[home.civId];
  if (civ) civHistory(w, civ, `The last tents came down: the people moved into a proper ${BLUEPRINTS[home.kind].name.toLowerCase()}.`, 'building', 1);
}

/** Builders get first claim on a new home; then friends and whoever is still homeless. */
export function assignResidents(w: World, hut: Structure): void {
  const cap = BLUEPRINTS[hut.kind].capacity;
  if (adultResidents(w, hut) >= cap) return;
  const candidates = homeless(w, hut.settlementId);
  if (!candidates.length) return;
  candidates.sort((a, b) => {
    const ab = hut.builders.includes(a.id) ? 1 : 0;
    const bb = hut.builders.includes(b.id) ? 1 : 0;
    if (ab !== bb) return bb - ab;
    return (b.stats.workDone || 0) - (a.stats.workDone || 0);
  });
  const first = candidates[0];
  if (!first) return;
  const chosen = [first];
  const rest = candidates.slice(1).sort((a, b) => first.affinity(b.id) - first.affinity(a.id));
  // The others are whoever the first likes most among the homeless.
  for (const r of rest) if (chosen.length < cap - adultResidents(w, hut)) chosen.push(r);
  const name = BLUEPRINTS[hut.kind].name.toLowerCase();
  for (const a of chosen) {
    if (adultResidents(w, hut) >= cap) break;
    hut.residents.push(a.id);
    a.homeId = hut.id;
    a.addLog(w.now(a), 'event', `Moved into the new ${name}${chosen.length > 1 ? ` with ${chosen.filter((c) => c !== a).map((c) => c.name).join(', ')}` : ''}.`);
    a.needs.safety = Math.min(1, a.needs.safety + 0.2);
    // Their children come along.
    for (const k of w.agents) if (k.alive && k.isChild && k.parents.includes(a.id) && k.homeId !== hut.id && k.settlementId === hut.settlementId) {
      const old = w.structure(k.homeId);
      if (old) old.residents = old.residents.filter((id) => id !== k.id);
      k.homeId = hut.id;
      if (!hut.residents.includes(k.id)) hut.residents.push(k.id);
    }
  }
  const names = chosen.map((a) => a.name).join(' and ');
  w.log(`${names} moved into a new ${name}.`, 'home', 1, hut);
}

function plantGarden(w: World, g: Structure): void {
  for (let k = 0; k < 4; k++) {
    const a = g.rot + (k / 4) * TAU + Math.PI / 4;
    const r = 1.35;
    const node: ResourceNode = {
      id: w.nextId(),
      kind: 'berryBush',
      variant: 1,
      x: g.x + Math.cos(a) * r,
      z: g.z + Math.sin(a) * r,
      rot: a,
      scale: 0.95,
      blockRadius: 0,
      amount: 2,
      max: 6,
      regrow: 0,
      state: 'grown',
      growth: 1,
      burning: 0,
      claims: 0,
      blessed: false,
      lastUse: -1e9,
    };
    w.addResource(node);
  }
}

/** Put items into a storage structure (storehouse / campfire stash). */
export function storeItems(w: World, s: Structure, a: Agent, items: readonly ItemType[]): number {
  const bp = BLUEPRINTS[s.kind];
  let room = bp.storage;
  for (const k of ITEM_TYPES) room -= s.stored[k];
  let moved = 0;
  for (const k of items) {
    const n = Math.min(room, a.inventory[k]);
    if (n <= 0) continue;
    a.inventory[k] -= n;
    s.stored[k] += n;
    room -= n;
    moved += n;
  }
  if (moved > 0) {
    w.events.emit('structureChanged', s);
    w.events.emit('sfx', { kind: 'deposit', x: s.x, z: s.z });
  }
  return moved;
}

export function takeItems(w: World, s: Structure, a: Agent, item: ItemType, count: number): number {
  const n = Math.min(count, s.stored[item]);
  if (n <= 0) return 0;
  s.stored[item] -= n;
  a.inventory[item] += n;
  w.events.emit('structureChanged', s);
  return n;
}

export function distanceToCamp(w: World, sid: number, x: number, z: number): number {
  const c = campCenter(w, sid);
  return Math.hypot(c.x - x, c.z - z);
}
