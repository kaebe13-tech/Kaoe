import { ADULT_AGE, Agent, randomAppearance } from '../agents/Agent';
import { TRAITS, TRAIT_IDS, type TraitId } from '../agents/traits';
import { DAY_LENGTH, HOUR } from '../world/config';
import { BLUEPRINTS } from './blueprints';
import { adultResidents, isHome, settlementFood } from './settlement';
import { HOMES, type Structure } from './types';
import type { World } from './World';
import type { Civilization } from '../civ/Civilization';
import { CULTURES, cultureName } from '../civ/cultures';
import { randomPersona } from '../civ/persona';
import { civHistory } from '../civ/civSystem';

/** Population caps keep the simulation affordable. */
export const MAX_CIV_POPULATION = 40;
export const MAX_WORLD_POPULATION = 170;

/**
 * Families: couples who share a hut and like each other may have a child when the tribe
 * is doing well. Children grow up over a few days and eventually need homes of their own —
 * the slow engine that keeps the settlement growing.
 */
export class Families {
  private readonly acc = new Map<number, number>();
  readonly lastBirth = new Map<number, number>();

  /** Runs inside a civilization's time context. */
  update(w: World, dt: number, civ: Civilization): void {
    const acc = (this.acc.get(civ.id) ?? 0) + dt;
    if (acc < HOUR / 2) {
      this.acc.set(civ.id, acc);
      return;
    }
    this.acc.set(civ.id, 0);
    this.age(w, acc, civ);
    const h = w.hour;
    if (h >= 21 && h < 21.5) for (const hut of w.structures) if (hut.civId === civ.id && isHome(hut) && hut.complete) this.tryBirth(w, hut, civ);
    civ.stats.peak = Math.max(civ.stats.peak, civ.population);
  }

  private age(w: World, dt: number, civ: Civilization): void {
    for (const a of civ.members) {
      if (!a.alive) continue;
      const wasChild = a.isChild;
      a.age += (dt / DAY_LENGTH) * (a.isChild ? 3 : 1 / 12);
      if (wasChild && !a.isChild) this.growUp(w, a);
    }
  }

  private growUp(w: World, a: Agent): void {
    a.addLog(w.now(a), 'event', 'Grew up! Ready to work alongside the others.');
    w.log(`${a.name} of ${w.civOf(a)?.name ?? 'the tribe'} has grown up.`, 'star', 1, a, a.id);
    const home = w.structure(a.homeId);
    if (home && adultResidents(w, home) > BLUEPRINTS[home.kind].capacity) {
      home.residents = home.residents.filter((id) => id !== a.id);
      a.homeId = null;
      a.addLog(w.now(a), 'event', "The family home is getting crowded. I'll need a place of my own.");
    }
  }

  private tryBirth(w: World, hut: Structure, civ: Civilization): void {
    const adults = hut.residents.map((id) => w.agent(id)).filter((x): x is Agent => !!x && x.alive && !x.isChild);
    if (adults.length < 2) return;
    const [a, b] = adults as [Agent, Agent];
    if (civ.population >= MAX_CIV_POPULATION) return;
    let worldPop = 0;
    for (const c of w.civs) worldPop += c.population;
    if (worldPop >= MAX_WORLD_POPULATION) return;
    const last = this.lastBirth.get(hut.id) ?? -Infinity;
    if (w.time - last < DAY_LENGTH * 1.6) return;
    const kids = civ.members.filter((k) => k.alive && k.isChild && k.homeId === hut.id).length;
    if (kids >= (hut.kind === 'house' ? 3 : 2)) return;
    if (a.affinity(b.id) < 0.55 || b.affinity(a.id) < 0.55) return;
    const fed = a.needs.hunger > 0.45 && b.needs.hunger > 0.45 && a.needs.health > 0.6 && b.needs.health > 0.6;
    const settlers = w.settlers(hut.settlementId).length;
    const stocked = settlementFood(w, hut.settlementId) >= settlers * 1.5;
    if (!fed && !stocked) return;
    const blessed = civ.hasEffect('blessed', w.worldTime) ? 0.15 : 0;
    const cursed = civ.hasEffect('cursed', w.worldTime) ? 0.2 : 0;
    if (!w.rng.chance(0.4 + blessed - cursed)) return;
    this.lastBirth.set(hut.id, w.time);
    this.birth(w, hut, a, b);
  }

  birth(w: World, hut: Structure, a: Agent, b: Agent): Agent {
    const rng = w.rng;
    const civ = w.civOf(a);
    const r = BLUEPRINTS[hut.kind].blockRadius + 0.7;
    const p = w.nav.nearestWalkable(hut.x + Math.sin(hut.rot) * r, hut.z + Math.cos(hut.rot) * r, 6) ?? { x: hut.x, z: hut.z };
    const look = randomAppearance(rng, civ?.culture);
    look.skin = rng.chance(0.5) ? a.look.skin : b.look.skin;
    look.hair = rng.chance(0.5) ? a.look.hair : b.look.hair;
    const traits: TraitId[] = [];
    for (const t of [rng.pick(a.traits), rng.pick(b.traits), rng.pick(TRAIT_IDS)]) {
      if (traits.length >= 2 || traits.includes(t)) continue;
      if (traits.some((o) => TRAITS[o].conflicts?.includes(t))) continue;
      traits.push(t);
    }
    const child = new Agent(w.nextId(), cultureName(rng, CULTURES[civ?.culture ?? 'vale'], w.takenNames()), p.x, p.z, traits, look, 0.5);
    child.civId = a.civId;
    child.settlementId = hut.settlementId >= 0 ? hut.settlementId : a.settlementId;
    child.persona = rng.chance(0.5) ? randomPersona(rng, [...a.persona, ...b.persona]) : randomPersona(rng);
    child.parents = [a.id, b.id];
    child.bornAt = w.time;
    child.homeId = hut.id;
    child.faith = (a.faith + b.faith) / 2;
    child.needs = { hunger: 0.9, thirst: 0.9, energy: 0.8, health: 1, safety: 1, social: 0.9 };
    child.heading = hut.rot;
    child.relations.set(a.id, 0.95);
    child.relations.set(b.id, 0.95);
    a.relations.set(child.id, 0.95);
    b.relations.set(child.id, 0.95);
    for (const k of civ?.members ?? []) {
      if (k === child || k === a || k === b || !k.alive) continue;
      child.relations.set(k.id, 0.4);
    }
    // A newborn knows what its parents know.
    for (const m of a.memory.resources.values()) child.memory.rememberResource({ ...m, source: 'told' });
    for (const [id, wm] of a.memory.water) child.memory.water.set(id, { ...wm });
    hut.residents.push(child.id);
    w.addAgent(child);
    w.stats.births++;
    if (civ) civ.stats.births++;
    for (const parent of [a, b]) {
      parent.needs.social = Math.min(1, parent.needs.social + 0.3);
      parent.addLog(w.now(parent), 'event', `Our child ${child.name} was born!`);
      parent.emote = { icon: 'heart', until: w.now(parent) + 6 };
    }
    child.addLog(w.now(child), 'event', `Born to ${a.name} and ${b.name}.`);
    if (civ && civ.stats.births <= 3) civHistory(w, civ, `The first children were born: ${child.name}, to ${a.name} and ${b.name}.`, 'growth', civ.stats.births === 1 ? 2 : 1);
    w.log(`A baby, ${child.name}, was born to ${a.name} and ${b.name}!`, 'heart', 3, child, child.id);
    w.events.emit('fx', { kind: 'hearts', x: p.x, z: p.z, y: 1.4, count: 12 });
    void ADULT_AGE;
    void HOMES;
    return child;
  }
}
