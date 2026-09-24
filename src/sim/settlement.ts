import { TAU, type V2 } from '../core/math';
import type { Agent } from '../agents/Agent';
import { BLUEPRINTS } from './blueprints';
import { FOOD_ITEMS, ITEM_TYPES, type Inventory, type ItemType, type Structure, type StructureKind } from './types';
import type { World } from './World';

/** Tribe-level helpers: where the camp is, what it needs next, where to build. */

export function campfire(w: World): Structure | undefined {
  return w.structures.find((s) => s.kind === 'campfire');
}

export function campCenter(w: World): V2 {
  const c = campfire(w);
  return c ? { x: c.x, z: c.z } : w.start;
}

export function sitesOf(w: World, kind?: StructureKind): Structure[] {
  return w.structures.filter((s) => !s.complete && s.kind !== 'grave' && (!kind || s.kind === kind));
}

export function completed(w: World, kind: StructureKind): Structure[] {
  return w.structures.filter((s) => s.complete && s.kind === kind);
}

/** Where items can be stored: storehouses first, the campfire stash as a fallback. */
export function storages(w: World): Structure[] {
  const list = w.structures.filter((s) => s.complete && BLUEPRINTS[s.kind].storage > 0);
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

export function tribeStored(w: World, item: ItemType): number {
  let n = 0;
  for (const s of storages(w)) n += s.stored[item];
  return n;
}

export function tribeFood(w: World): number {
  let n = 0;
  for (const k of FOOD_ITEMS) n += tribeStored(w, k);
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

/** Adults without a home (children live with their parents). */
export function homeless(w: World): Agent[] {
  return w.living.filter((a) => !a.isChild && (a.homeId === null || !w.structure(a.homeId)));
}

/** Adults living in a hut; children don't take up a bed. */
export function adultResidents(w: World, hut: Structure): number {
  let n = 0;
  for (const id of hut.residents) {
    const a = w.agent(id);
    if (a && a.alive && !a.isChild) n++;
  }
  return n;
}

export function hasFreeBed(w: World, hut: Structure): boolean {
  return hut.kind === 'hut' && adultResidents(w, hut) < BLUEPRINTS.hut.capacity;
}

export function tribeFaith(w: World): number {
  const adults = w.living.filter((a) => !a.isChild);
  if (!adults.length) return 0;
  return adults.reduce((s, a) => s + a.faith, 0) / adults.length;
}

export interface Project {
  kind: StructureKind;
  reason: string;
}

/** What the tribe should build next (if anything), judged from the current state. */
export function nextProject(w: World): Project | null {
  if (!campfire(w)) return { kind: 'campfire', reason: 'The tribe has no campfire to gather around' };
  const pop = w.living.length;
  const adults = w.living.filter((a) => !a.isChild).length;
  const sites = sitesOf(w);
  const huts = w.structures.filter((s) => s.kind === 'hut');
  const bedsPlanned = huts.length * BLUEPRINTS.hut.capacity;
  // One project at a time while the tribe is small keeps effort focused.
  if (sites.length >= (pop >= 9 ? 2 : 1)) return null;
  if (bedsPlanned < adults) {
    const short = adults - bedsPlanned;
    return { kind: 'hut', reason: `${short} ${short === 1 ? 'person has' : 'people have'} no place to sleep` };
  }
  if (!w.structures.some((s) => s.kind === 'shrine') && tribeFaith(w) > 0.28 && huts.some((h) => h.complete)) {
    return { kind: 'shrine', reason: 'They have seen miracles, and want to honour whoever watches over them' };
  }
  const stores = w.structures.filter((s) => s.kind === 'storage');
  if (stores.length === 0 && huts.filter((h) => h.complete).length >= 2) {
    return { kind: 'storage', reason: 'Food keeps running short; the tribe needs a storehouse' };
  }
  const gardens = w.structures.filter((s) => s.kind === 'garden');
  if (stores.length > 0 && gardens.length < Math.floor(pop / 4) && gardens.length < 3) {
    return { kind: 'garden', reason: 'Wild berries are far away; a garden near camp would help' };
  }
  if (stores.length > 0 && stores.length < Math.ceil(pop / 10)) {
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
  if (!w.nav.terrainWalkable(x, z)) return false;
  if (t.slopeAt(x, z) > 0.32) return false;
  const h0 = t.heightAt(x, z);
  if (h0 < 1.1) return false;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    const px = x + Math.cos(a) * radius;
    const pz = z + Math.sin(a) * radius;
    if (!w.nav.terrainWalkable(px, pz)) return false;
    if (Math.abs(t.heightAt(px, pz) - h0) > 0.9) return false;
  }
  let clear = true;
  w.resourceHash.query(x, z, radius + 2, (r) => {
    if (r.blockRadius > 0 && Math.hypot(r.x - x, r.z - z) < radius + r.blockRadius + 0.3 && r.state !== 'stump') {
      clear = false;
      return true;
    }
    if ((r.kind === 'berryBush') && Math.hypot(r.x - x, r.z - z) < radius + 0.5) {
      clear = false;
      return true;
    }
    return false;
  });
  if (!clear) return false;
  for (const s of w.structures) {
    if (s.id === ignoreId) continue;
    const need = radius + BLUEPRINTS[s.kind].radius + 0.8;
    if (Math.hypot(s.x - x, s.z - z) < need) return false;
  }
  for (const wb of w.water) {
    if (Math.hypot(wb.x - x, wb.z - z) < wb.radius * 1.5 + radius) return false;
  }
  return true;
}

/** Pick a spot for a new structure in a pleasant ring layout around the campfire. */
export function chooseSite(w: World, kind: StructureKind, near?: V2): SiteChoice | null {
  const bp = BLUEPRINTS[kind];
  if (kind === 'campfire') return chooseCampfireSite(w, near ?? w.start);
  const c = campCenter(w);
  const rings: Record<string, [number, number]> = {
    hut: [6.5, 12],
    storage: [4.5, 8],
    garden: [11, 17],
    shrine: [8, 14],
    grave: [16, 24],
  };
  const [r0, r1base] = rings[kind] ?? [6, 12];
  // If the preferred ring is crowded, keep looking a bit further out.
  const r1 = r1base + 10;
  // Deterministic but varied order of candidate angles.
  const offset = (w.structures.length * 2.39996) % TAU;
  let best: SiteChoice | null = null;
  let bestScore = -Infinity;
  for (let ring = r0; ring <= r1; ring += 1.5) {
    if (best && ring > r1base) break;
    for (let k = 0; k < 16; k++) {
      const a = offset + (k / 16) * TAU;
      const x = c.x + Math.cos(a) * ring;
      const z = c.z + Math.sin(a) * ring;
      if (!siteClear(w, x, z, bp.radius)) continue;
      // Prefer compact camps and flat ground; face the door toward the fire.
      const score = -ring * 0.6 - w.terrain.slopeAt(x, z) * 10 + (kind === 'garden' ? w.terrain.moistureAt(x, z) * 4 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { x, z, rot: Math.atan2(c.x - x, c.z - z) };
      }
    }
    if (best && ring >= r0 + 3) break;
  }
  return best;
}

function chooseCampfireSite(w: World, near: V2): SiteChoice | null {
  let best: SiteChoice | null = null;
  let bestScore = -Infinity;
  for (let r = 0; r <= 14; r += 1.5) {
    const n = r === 0 ? 1 : 12;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      const x = near.x + Math.cos(a) * r;
      const z = near.z + Math.sin(a) * r;
      if (!siteClear(w, x, z, 3.5)) continue;
      // Flat, open ground with room for huts around it; close to water but not too close.
      let water = Infinity;
      for (const wb of w.water) water = Math.min(water, Math.hypot(wb.x - x, wb.z - z) - wb.radius);
      const score = -r * 0.3 - w.terrain.slopeAt(x, z) * 12 - Math.abs(water - 12) * 0.15;
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

/** The doorway of a hut / storehouse (in front, facing the camp). */
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
