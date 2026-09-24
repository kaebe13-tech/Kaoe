import { ADULT_AGE, Agent, randomAppearance } from '../agents/Agent';
import { makeName } from '../agents/names';
import { TRAITS, TRAIT_IDS, type TraitId } from '../agents/traits';
import { DAY_LENGTH, HOUR } from '../world/config';
import { BLUEPRINTS } from './blueprints';
import { adultResidents, tribeFood } from './settlement';
import type { Structure } from './types';
import type { World } from './World';

const MAX_POPULATION = 32;

/**
 * Families: couples who share a hut and like each other may have a child when the tribe
 * is doing well. Children grow up over a few days and eventually need homes of their own —
 * the slow engine that keeps the settlement growing.
 */
export class Families {
  private acc = 0;
  private readonly lastBirth = new Map<number, number>();

  update(w: World, dt: number): void {
    this.acc += dt;
    if (this.acc < HOUR / 2) return;
    const step = this.acc;
    this.acc = 0;
    this.age(w, step);
    const h = w.hour;
    if (h >= 21 && h < 21.5) for (const hut of w.structures) if (hut.kind === 'hut' && hut.complete) this.tryBirth(w, hut);
  }

  private age(w: World, dt: number): void {
    for (const a of w.agents) {
      if (!a.alive) continue;
      const wasChild = a.isChild;
      a.age += (dt / DAY_LENGTH) * (a.isChild ? 3 : 1 / 12);
      if (wasChild && !a.isChild) this.growUp(w, a);
    }
  }

  private growUp(w: World, a: Agent): void {
    a.addLog(w.time, 'event', 'Grew up! Ready to work alongside the others.');
    w.log(`${a.name} has grown up and joins the work of the tribe.`, 'star', 2, a, a.id);
    const home = w.structure(a.homeId);
    if (home && adultResidents(w, home) > BLUEPRINTS.hut.capacity) {
      home.residents = home.residents.filter((id) => id !== a.id);
      a.homeId = null;
      a.addLog(w.time, 'event', "The family hut is getting crowded — I'll need a place of my own.");
    }
  }

  private tryBirth(w: World, hut: Structure): void {
    const adults = hut.residents.map((id) => w.agent(id)).filter((x): x is Agent => !!x && x.alive && !x.isChild);
    if (adults.length < 2) return;
    const [a, b] = adults as [Agent, Agent];
    if (w.living.length >= MAX_POPULATION) return;
    const last = this.lastBirth.get(hut.id) ?? -Infinity;
    if (w.time - last < DAY_LENGTH * 1.6) return;
    const kids = w.living.filter((k) => k.isChild && k.homeId === hut.id).length;
    if (kids >= 2) return;
    if (a.affinity(b.id) < 0.55 || b.affinity(a.id) < 0.55) return;
    const fed = a.needs.hunger > 0.45 && b.needs.hunger > 0.45 && a.needs.health > 0.6 && b.needs.health > 0.6;
    const stocked = tribeFood(w) >= w.living.length * 1.5;
    if (!fed && !stocked) return;
    if (!w.rng.chance(0.4)) return;
    this.lastBirth.set(hut.id, w.time);
    this.birth(w, hut, a, b);
  }

  birth(w: World, hut: Structure, a: Agent, b: Agent): Agent {
    const rng = w.rng;
    const taken = new Set(w.agents.map((x) => x.name));
    const r = BLUEPRINTS.hut.blockRadius + 0.7;
    const p = w.nav.nearestWalkable(hut.x + Math.sin(hut.rot) * r, hut.z + Math.cos(hut.rot) * r, 6) ?? { x: hut.x, z: hut.z };
    const look = randomAppearance(rng);
    look.skin = rng.chance(0.5) ? a.look.skin : b.look.skin;
    look.hair = rng.chance(0.5) ? a.look.hair : b.look.hair;
    const traits: TraitId[] = [];
    for (const t of [rng.pick(a.traits), rng.pick(b.traits), rng.pick(TRAIT_IDS)]) {
      if (traits.length >= 2 || traits.includes(t)) continue;
      if (traits.some((o) => TRAITS[o].conflicts?.includes(t))) continue;
      traits.push(t);
    }
    const child = new Agent(w.nextId(), makeName(rng, taken), p.x, p.z, traits, look, 0.5);
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
    for (const k of w.agents) {
      if (k === child || k === a || k === b || !k.alive) continue;
      child.relations.set(k.id, 0.4);
    }
    // A newborn knows what its parents know.
    for (const m of a.memory.resources.values()) child.memory.rememberResource({ ...m, source: 'told' });
    for (const [id, wm] of a.memory.water) child.memory.water.set(id, { ...wm });
    hut.residents.push(child.id);
    w.addAgent(child);
    w.stats.births++;
    for (const parent of [a, b]) {
      parent.needs.social = Math.min(1, parent.needs.social + 0.3);
      parent.addLog(w.time, 'event', `Our child ${child.name} was born!`);
      parent.emote = { icon: 'heart', until: w.time + 6 };
    }
    child.addLog(w.time, 'event', `Born to ${a.name} and ${b.name}.`);
    w.log(`A baby, ${child.name}, was born to ${a.name} and ${b.name}!`, 'heart', 3, child, child.id);
    w.events.emit('fx', { kind: 'hearts', x: p.x, z: p.z, y: 1.4, count: 12 });
    void ADULT_AGE;
    return child;
  }
}
