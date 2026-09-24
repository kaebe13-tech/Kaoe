import { TAU, type V2 } from '../core/math';
import { hash01 } from '../core/rng';
import type { Agent } from '../agents/Agent';
import { BLUEPRINTS } from './blueprints';
import { FOOD_ITEMS, HOMES, ITEM_TYPES, type Inventory, type ItemType, type Structure, type StructureKind } from './types';
import { WEAR_CELL, WEAR_N, type World } from './World';
import type { Civilization, Era, Settlement } from '../civ/Civilization';
import type { Priorities } from '../civ/cultures';
import { WORLD_HALF } from '../world/config';

/** Settlement-level helpers: where the camp is, what it needs next, where to build. */

export function isHome(s: Structure): boolean {
  return (HOMES as readonly string[]).includes(s.kind);
}

export function structuresOf(w: World, sid: number): Structure[] {
  return w.structures.filter((s) => s.settlementId === sid);
}

export function campfire(w: World, sid: number): Structure | undefined {
  return w.structures.find((s) => s.kind === 'campfire' && s.settlementId === sid);
}

/** Heart of a settlement: its campfire, else where it was founded. */
export function campCenter(w: World, sid: number): V2 {
  const c = campfire(w, sid);
  if (c) return { x: c.x, z: c.z };
  const s = w.settlement(sid);
  return s ? { x: s.x, z: s.z } : w.start;
}

export function sitesOf(w: World, sid: number, kind?: StructureKind): Structure[] {
  return w.structures.filter((s) => s.settlementId === sid && !s.complete && s.kind !== 'grave' && (!kind || s.kind === kind));
}

export function completed(w: World, sid: number, kind: StructureKind): Structure[] {
  return w.structures.filter((s) => s.settlementId === sid && s.complete && s.kind === kind);
}

/** Where items can be stored: storehouses first, then halls/workshops/houses, the campfire stash last. */
export function storages(w: World, sid: number): Structure[] {
  const list = w.structures.filter((s) => s.settlementId === sid && s.complete && BLUEPRINTS[s.kind].storage > 0);
  list.sort((a, b) => BLUEPRINTS[b.kind].storage - BLUEPRINTS[a.kind].storage);
  return list;
}

export function storedTotal(s: Structure): number {
  let n = 0;
  for (const k of ITEM_TYPES) n += s.stored[k];
  return n;
}

export function storageRoom(s: Structure): number {
  return Math.max(0, BLUEPRINTS[s.kind].storage - storedTotal(s));
}

export function settlementStored(w: World, sid: number, item: ItemType): number {
  let n = 0;
  for (const s of storages(w, sid)) n += s.stored[item];
  return n;
}

export function settlementFood(w: World, sid: number): number {
  let n = 0;
  for (const s of storages(w, sid)) for (const k of FOOD_ITEMS) n += s.stored[k];
  return n;
}

export function civStored(w: World, civ: Civilization, item: ItemType): number {
  let n = 0;
  for (const st of civ.settlements) n += settlementStored(w, st.id, item);
  return n;
}

export function civFood(w: World, civ: Civilization): number {
  let n = 0;
  for (const st of civ.settlements) n += settlementFood(w, st.id);
  return n;
}

/** Materials a site still needs, counting what's already on the way. */
export function siteNeeds(s: Structure): Partial<Inventory> {
  const bp = BLUEPRINTS[s.kind];
  const out: Partial<Inventory> = {};
  for (const k of ITEM_TYPES) {
    const need = (bp.cost[k] ?? 0) - (s.delivered[k] ?? 0) - (s.incoming[k] ?? 0);
    if (need > 0) out[k] = need;
  }
  return out;
}

export function siteMissing(s: Structure): Partial<Inventory> {
  const bp = BLUEPRINTS[s.kind];
  const out: Partial<Inventory> = {};
  for (const k of ITEM_TYPES) {
    const need = (bp.cost[k] ?? 0) - (s.delivered[k] ?? 0);
    if (need > 0) out[k] = need;
  }
  return out;
}

/** Fraction of the build that the delivered materials allow. */
export function allowedProgress(s: Structure): number {
  const bp = BLUEPRINTS[s.kind];
  let frac = 1;
  for (const k of ITEM_TYPES) {
    const cost = bp.cost[k] ?? 0;
    if (cost > 0) frac = Math.min(frac, (s.delivered[k] ?? 0) / cost);
  }
  return frac;
}

/** Adults of a settlement without a home (children live with their parents). */
export function homeless(w: World, sid: number): Agent[] {
  return w.agents.filter((a) => a.alive && !a.isChild && a.settlementId === sid && (a.homeId === null || !w.structure(a.homeId)));
}

/** Adults living in a home; children don't take up a bed. */
export function adultResidents(w: World, hut: Structure): number {
  let n = 0;
  for (const id of hut.residents) {
    const a = w.agent(id);
    if (a && a.alive && !a.isChild) n++;
  }
  return n;
}

export function hasFreeBed(w: World, hut: Structure): boolean {
  return isHome(hut) && hut.complete && adultResidents(w, hut) < BLUEPRINTS[hut.kind].capacity;
}

export function civFaith(civ: Civilization): number {
  const adults = civ.members.filter((a) => a.alive && !a.isChild);
  if (!adults.length) return 0;
  return adults.reduce((s, a) => s + a.faith, 0) / adults.length;
}

/** Settlement development score: buildings weighted by value, plus people. */
export function development(w: World, sid: number): number {
  let v = 0;
  for (const s of w.structures) if (s.settlementId === sid && s.complete) v += BLUEPRINTS[s.kind].value;
  return v + w.settlers(sid).length * 1.5;
}

export function eraOf(w: World, sid: number): Era {
  const done = (k: StructureKind) => w.structures.some((s) => s.settlementId === sid && s.complete && s.kind === k);
  const homes = w.structures.filter((s) => s.settlementId === sid && s.complete && (s.kind === 'hut' || s.kind === 'house')).length;
  if (done('hall') || (done('workshop') && done('house') && homes >= 5)) return 'Town';
  if (homes >= 2 && done('storage')) return 'Village';
  return 'Camp';
}

/** How far a settlement is along the road to its next era (0..1) and what it still needs. */
export function eraProgress(w: World, sid: number): { era: Era; next: Era | null; frac: number; need: string } {
  const era = eraOf(w, sid);
  const done = (k: StructureKind) => w.structures.some((s) => s.settlementId === sid && s.complete && s.kind === k);
  const homes = w.structures.filter((s) => s.settlementId === sid && s.complete && (s.kind === 'hut' || s.kind === 'house')).length;
  if (era === 'Camp') {
    const store = done('storage');
    const frac = Math.min(homes, 2) / 2 * 0.67 + (store ? 0.33 : 0);
    const need = [homes < 2 ? `${2 - homes} more home${2 - homes === 1 ? '' : 's'}` : '', store ? '' : 'a storehouse'].filter(Boolean).join(' and ');
    return { era, next: 'Village', frac, need };
  }
  if (era === 'Village') {
    const frac = Math.min(1, (done('workshop') ? 0.3 : 0) + (done('house') ? 0.2 : 0) + (Math.min(homes, 5) / 5) * 0.5);
    const need = [done('workshop') ? '' : 'a workshop', done('house') ? '' : 'a house', homes < 5 ? `${5 - homes} more homes` : ''].filter(Boolean).join(', ');
    return { era, next: 'Town', frac, need: need ? `${need} (or a great hall)` : 'a great hall' };
  }
  return { era, next: null, frac: 1, need: '' };
}

export interface Project {
  kind: StructureKind;
  reason: string;
}

/** Can this settlement plausibly get a material (stores, carried, or a known source)? */
function canGet(w: World, sid: number, item: ItemType, civ: Civilization): boolean {
  if (settlementStored(w, sid, item) > 0) return true;
  const c = campCenter(w, sid);
  let found = false;
  const kind = item === 'stone' ? 'rock' : item === 'crystal' ? 'crystal' : null;
  if (!kind) return true;
  w.resourceHash.query(c.x, c.z, item === 'stone' ? 70 : 60, (r) => {
    if (r.kind === kind && r.state === 'grown' && r.amount > 0) {
      found = true;
      return true;
    }
    return false;
  });
  if (found) return true;
  // Someone in the settlement remembers a source further away.
  for (const a of civ.members) {
    if (!a.alive || a.settlementId !== sid) continue;
    for (const m of a.memory.resources.values()) if (m.kind === kind && m.amount > 0) return true;
  }
  return false;
}

function waterNear(w: World, p: V2, r: number): boolean {
  for (const wb of w.water) if (Math.hypot(wb.x - p.x, wb.z - p.z) < r + wb.radius) return true;
  return false;
}

/** What a settlement should build next (if anything), judged from its state and its people's priorities. */
export function nextProject(w: World, sid: number, civ: Civilization, focus: Priorities): Project | null {
  if (!campfire(w, sid)) return { kind: 'campfire', reason: 'There is no fire to gather around yet' };
  const settlers = w.settlers(sid);
  const pop = settlers.length;
  const adults = settlers.filter((a) => !a.isChild).length;
  const all = structuresOf(w, sid);
  const sites = all.filter((s) => !s.complete && s.kind !== 'grave');
  const count = (k: StructureKind, done = false) => all.filter((s) => s.kind === k && (!done || s.complete)).length;
  const homes = all.filter((s) => isHome(s));
  const beds = homes.reduce((n, h) => n + BLUEPRINTS[h.kind].capacity, 0);
  const builders = Math.max(1, Math.floor((pop / 6) * Math.min(1.6, focus.build)));
  if (sites.length >= Math.min(4, builders)) return null;
  const hasStone = canGet(w, sid, 'stone', civ);
  const workshop = count('workshop', true) > 0;
  const center = campCenter(w, sid);

  if (beds < adults) {
    const short = adults - beds;
    const who = `${short} ${short === 1 ? 'person has' : 'people have'} nowhere to sleep`;
    if (count('hut') + count('house') === 0 && count('tent') < 2) return { kind: 'tent', reason: `${who}; a tent goes up fast` };
    if (workshop && hasStone && count('house') < 8) return { kind: 'house', reason: `${who}; with a workshop they can raise a proper house` };
    return { kind: 'hut', reason: who };
  }
  const faith = civFaith(civ);
  const honour = civ.objectives.some((o) => o.kind === 'HONOR_GOD');
  if (!count('shrine') && (faith > 0.28 * (1 / focus.faith) || honour || civ.rep.faith > 0.45) && homes.some((h) => h.complete)) {
    return { kind: 'shrine', reason: honour ? 'Their leader wants a place to honour the watcher above' : 'They have seen signs from above and want to give thanks' };
  }
  if (!count('storage') && homes.filter((h) => h.complete).length >= 2) {
    return { kind: 'storage', reason: 'Food keeps running short; they need a storehouse' };
  }
  const gardens = count('garden');
  const wantGardens = Math.min(focus.gather > 1.2 ? 5 : 3, Math.floor(pop / 4));
  if (count('storage') > 0 && gardens < wantGardens) {
    return { kind: 'garden', reason: 'Wild berries are far away; a garden close to home would help' };
  }
  if (!waterNear(w, center, 24) && !count('well') && pop >= 5 && hasStone) {
    return { kind: 'well', reason: 'The nearest water is a long walk away' };
  }
  if (!workshop && count('storage', true) > 0 && homes.length >= 3 && pop >= 7 && hasStone) {
    return { kind: 'workshop', reason: 'Better tools would make every job quicker' };
  }
  const tense = [...civ.relations.values()].some((r) => r.state === 'tense' || r.state === 'hostile');
  if (count('tower') < (pop > 18 ? 2 : 1) && (tense || focus.defend > 1.35) && count('storage', true) > 0 && hasStone && pop >= 6) {
    return { kind: 'tower', reason: tense ? 'Strangers nearby make them uneasy; they want a lookout' : 'They like to keep watch over their land' };
  }
  if (!count('hall') && workshop && pop >= 11 && hasStone) {
    return { kind: 'hall', reason: 'The village has grown; it needs a great hall to gather in' };
  }
  if (!count('monument') && count('shrine', true) > 0 && civ.rep.faith > 0.5 && canGet(w, sid, 'crystal', civ) && hasStone && pop >= 8) {
    return { kind: 'monument', reason: 'Their faith runs deep; they want to raise an altar to the sky' };
  }
  // Replace tents with proper huts once everyone has a bed.
  const tents = homes.filter((h) => h.kind === 'tent' && h.complete);
  if (tents.length && beds - tents.length * 2 < adults + 2) {
    return { kind: workshop && hasStone ? 'house' : 'hut', reason: 'Tents are cold and leaky; time for a real home' };
  }
  if (count('storage') > 0 && count('storage') < Math.ceil(pop / 12)) {
    return { kind: 'storage', reason: 'The storehouse is overflowing' };
  }
  return null;
}

export interface SiteChoice {
  x: number;
  z: number;
  rot: number;
}

/** Is the ground clear and flat enough for a building footprint? */
export function siteClear(w: World, x: number, z: number, radius: number, ignoreId = -1): boolean {
  const t = w.terrain;
  if (!w.nav.terrainWalkable(x, z) || t.isWater(x, z)) return false;
  if (t.slopeAt(x, z) > 0.32) return false;
  const h0 = t.heightAt(x, z);
  if (h0 < 1.1) return false;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    const px = x + Math.cos(a) * radius;
    const pz = z + Math.sin(a) * radius;
    if (!w.nav.terrainWalkable(px, pz) || t.isWater(px, pz)) return false;
    if (Math.abs(t.heightAt(px, pz) - h0) > 0.9) return false;
  }
  let clear = true;
  w.resourceHash.query(x, z, radius + 3, (r) => {
    if (r.blockRadius > 0 && Math.hypot(r.x - x, r.z - z) < radius + r.blockRadius + 0.3 && r.state !== 'stump') {
      clear = false;
      return true;
    }
    if ((r.kind === 'berryBush' || r.kind === 'mushroom') && Math.hypot(r.x - x, r.z - z) < radius + 0.5) {
      clear = false;
      return true;
    }
    return false;
  });
  if (!clear) return false;
  for (const s of w.structures) {
    if (s.id === ignoreId) continue;
    const need = radius + BLUEPRINTS[s.kind].radius + 0.8;
    if (Math.abs(s.x - x) < need && Math.abs(s.z - z) < need && Math.hypot(s.x - x, s.z - z) < need) return false;
  }
  for (const wb of w.water) {
    if (wb.kind === 'river') continue;
    if (Math.hypot(wb.x - x, wb.z - z) < wb.radius * 1.5 + radius) return false;
  }
  for (const l of w.terrain.landmarks) if (Math.hypot(l.x - x, l.z - z) < radius + Math.max(6, l.block + 4)) return false;
  return true;
}

function wearAt(w: World, x: number, z: number): number {
  const cx = Math.floor((x + WORLD_HALF) / WEAR_CELL);
  const cz = Math.floor((z + WORLD_HALF) / WEAR_CELL);
  if (cx < 0 || cz < 0 || cx >= WEAR_N || cz >= WEAR_N) return 0;
  return w.wear[cz * WEAR_N + cx]!;
}

/** Preferred distance band from the settlement heart, by building type. */
const BANDS: Partial<Record<StructureKind, [number, number]>> = {
  tent: [5, 12],
  hut: [6, 16],
  house: [7, 20],
  storage: [4, 9],
  garden: [11, 22],
  shrine: [9, 18],
  workshop: [8, 16],
  hall: [6, 12],
  well: [3, 7],
  tower: [14, 24],
  monument: [8, 15],
  grave: [18, 28],
};

/**
 * Pick a spot for a new structure. Settlements grow organically: homes cluster near other homes
 * and face the heart of the village, workshops and stores sit near the centre, gardens take the
 * moist edges, shrines and towers seek high ground, and nothing is built on the worn paths.
 */
export function chooseSite(w: World, kind: StructureKind, sid: number, near?: V2): SiteChoice | null {
  const bp = BLUEPRINTS[kind];
  const settlement = w.settlement(sid);
  if (kind === 'campfire') return chooseCampfireSite(w, near ?? (settlement ? { x: settlement.x, z: settlement.z } : w.start));
  const c = campCenter(w, sid);
  const [b0, b1] = BANDS[kind] ?? [6, 14];
  const mine = w.structures.filter((s) => s.settlementId === sid);
  const homesCount = mine.filter((s) => isHome(s)).length;
  // The village widens as it grows.
  const grow = Math.min(14, homesCount * 0.9);
  let best: SiteChoice | null = null;
  let bestScore = -Infinity;
  const seed = sid * 977 + mine.length * 131 + (kind.length << 4);
  for (let k = 0; k < 110; k++) {
    const a = hash01(seed, k) * TAU;
    const r = b0 + hash01(seed + 7, k) * (b1 - b0 + grow);
    const x = c.x + Math.cos(a) * r;
    const z = c.z + Math.sin(a) * r;
    if (!siteClear(w, x, z, bp.radius)) continue;
    let score = -Math.abs(r - (b0 + (b1 - b0) * 0.4)) * 0.25 - w.terrain.slopeAt(x, z) * 12;
    // Cluster with neighbours, but leave room to walk between them.
    let nearest = Infinity;
    for (const s of mine) {
      if (s.kind === 'grave') continue;
      nearest = Math.min(nearest, Math.hypot(s.x - x, s.z - z) - BLUEPRINTS[s.kind].radius - bp.radius);
    }
    if (nearest < Infinity) score += nearest < 2.2 ? -3 : nearest < 7 ? 2 : -(nearest - 7) * 0.35;
    score -= wearAt(w, x, z) * 8;
    const h = w.terrain.heightAt(x, z);
    if (kind === 'garden') score += w.terrain.moistureAt(x, z) * 5 + (waterNear(w, { x, z }, 14) ? 2 : 0);
    if (kind === 'shrine' || kind === 'tower' || kind === 'monument') score += (h - w.terrain.heightAt(c.x, c.z)) * 0.6;
    if (isHome({ kind } as Structure)) {
      // Homes like company of their own kind.
      let homesNear = 0;
      for (const s of mine) if (isHome(s) && Math.hypot(s.x - x, s.z - z) < 11) homesNear++;
      score += Math.min(3, homesNear) * 0.8;
    }
    score += (hash01(seed + 3, k) - 0.5) * 1.2;
    if (score > bestScore) {
      bestScore = score;
      // Face the village heart, slightly irregular.
      const rot = Math.atan2(c.x - x, c.z - z) + (hash01(seed + 11, k) - 0.5) * 0.5;
      best = { x, z, rot };
    }
  }
  return best;
}

function chooseCampfireSite(w: World, near: V2): SiteChoice | null {
  let best: SiteChoice | null = null;
  let bestScore = -Infinity;
  for (let r = 0; r <= 16; r += 1.5) {
    const n = r === 0 ? 1 : 12;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      const x = near.x + Math.cos(a) * r;
      const z = near.z + Math.sin(a) * r;
      if (!siteClear(w, x, z, 3.5)) continue;
      // Flat, open ground with room to grow; close to water but not too close.
      let water = Infinity;
      for (const wb of w.water) water = Math.min(water, Math.hypot(wb.x - x, wb.z - z) - wb.radius);
      const score = -r * 0.3 - w.terrain.slopeAt(x, z) * 12 - Math.abs(Math.min(water, 40) - 14) * 0.15;
      if (score > bestScore) {
        bestScore = score;
        best = { x, z, rot: 0 };
      }
    }
  }
  return best;
}

/** Spot around a structure where an agent can work/stand, spread out by agent id. */
export function workSpot(w: World, s: Structure, agentId: number): V2 {
  const bp = BLUEPRINTS[s.kind];
  const r = Math.max(bp.blockRadius, 0.6) + 0.75;
  for (let k = 0; k < 8; k++) {
    const a = agentId * 2.1 + k * 0.785;
    const x = s.x + Math.cos(a) * r;
    const z = s.z + Math.sin(a) * r;
    if (w.nav.walkable(x, z)) return { x, z };
  }
  return w.nav.nearestWalkable(s.x, s.z, 6) ?? { x: s.x, z: s.z };
}

/** The doorway of a home / storehouse (in front, facing the camp). */
export function doorSpot(w: World, s: Structure): V2 {
  const bp = BLUEPRINTS[s.kind];
  const r = bp.blockRadius + 0.6;
  const x = s.x + Math.sin(s.rot) * r;
  const z = s.z + Math.cos(s.rot) * r;
  if (w.nav.walkable(x, z)) return { x, z };
  return w.nav.nearestWalkable(x, z, 5) ?? { x, z };
}

/** A seat around the campfire. */
export function fireSeat(w: World, fire: Structure, agentId: number): V2 {
  for (let k = 0; k < 10; k++) {
    const a = agentId * 1.7 + k * 0.63;
    const r = 1.9 + (k % 2) * 0.5;
    const x = fire.x + Math.cos(a) * r;
    const z = fire.z + Math.sin(a) * r;
    if (w.nav.walkable(x, z)) return { x, z };
  }
  return w.nav.nearestWalkable(fire.x + 2, fire.z, 6) ?? { x: fire.x + 2, z: fire.z };
}

export type { Settlement };
