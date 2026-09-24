import { TAU, type V2 } from '../core/math';
import type { World } from '../sim/World';
import type { Agent } from '../agents/Agent';
import type { Civilization } from '../civ/Civilization';
import { stateFromOpinion } from '../civ/Civilization';
import { lightningStrike } from '../sim/hazards';
import { DAY_LENGTH, HOUR } from '../world/config';
import { describePlace } from '../ai/describe';
import { siteClear, campCenter } from '../sim/settlement';
import { TreeVariant, type ResourceKind, type ResourceNode } from '../sim/types';
import { Biome } from '../world/biomes';
import { igniteResource, igniteStructure } from '../sim/ecology';
import { kill } from '../sim/needs';
import { abortActive } from '../ai/brainCore';
import { stopNav } from '../ai/locomotion';
import { divineEvent } from '../civ/divine';
import { civHistory, leaderOf, mapIndex, territoryAt } from '../civ/civSystem';
import { leaderMemory, requestLeaderThought } from '../civ/leader';
import { BLUEPRINTS } from '../sim/blueprints';
import { editBlocked, editTerrain } from '../sim/terrainEdit';
import { MAP_CELL, MAP_N, WORLD_HALF } from '../world/config';

export type PowerId =
  | 'bless'
  | 'forest'
  | 'spring'
  | 'deposit'
  | 'lightning'
  | 'meteor'
  | 'quake'
  | 'wildfire'
  | 'rain'
  | 'storm'
  | 'fog'
  | 'drought'
  | 'clear'
  | 'heal'
  | 'resurrect'
  | 'harvest'
  | 'fertility'
  | 'raise'
  | 'teleport'
  | 'vision'
  | 'inspire'
  | 'peace'
  | 'sanctuary'
  | 'curse'
  | 'wrath'
  | 'manifest'
  | 'sign';

export type PowerCategory = 'creation' | 'destruction' | 'weather' | 'life' | 'world' | 'peoples' | 'miracles';

/** What a power is aimed at: a spot on the land, a living person, the dead, or a whole people. */
export type PowerTarget = 'ground' | 'person' | 'body' | 'civ';

export interface PowerDef {
  id: PowerId;
  name: string;
  category: PowerCategory;
  target: PowerTarget;
  /** Radius shown under the cursor (0 = a point). */
  radius: number;
  /** Real seconds before it can be used again. */
  cooldown: number;
  icon: string;
  hint: string;
}

export const CATEGORIES: Array<{ id: PowerCategory; name: string; icon: string; color: string }> = [
  { id: 'creation', name: 'Creation', icon: 'bless', color: '#9be27a' },
  { id: 'destruction', name: 'Destruction', icon: 'fire', color: '#ff8a5c' },
  { id: 'weather', name: 'Weather', icon: 'rain', color: '#8fd3ff' },
  { id: 'life', name: 'Life', icon: 'heal', color: '#7ef0b0' },
  { id: 'world', name: 'World', icon: 'globe', color: '#e0c07a' },
  { id: 'peoples', name: 'Peoples', icon: 'crown', color: '#f2c46b' },
  { id: 'miracles', name: 'Miracles', icon: 'star', color: '#ffe38a' },
];

export const POWERS: PowerDef[] = [
  { id: 'bless', name: 'Fruit Tree', category: 'creation', target: 'ground', radius: 2, cooldown: 1.5, icon: 'bless', hint: 'Grow a tree heavy with fruit. Watch who finds it first.' },
  { id: 'forest', name: 'Grow Forest', category: 'creation', target: 'ground', radius: 13, cooldown: 5, icon: 'tree', hint: 'Young trees spring up across the land.' },
  { id: 'spring', name: 'Spring', category: 'creation', target: 'ground', radius: 7, cooldown: 15, icon: 'water', hint: 'Open a spring of clean water in the earth: a new pond for thirsty people.' },
  { id: 'deposit', name: 'Stone & Crystal', category: 'creation', target: 'ground', radius: 5, cooldown: 6, icon: 'stone', hint: 'Raise boulders and crystal from the ground for builders.' },
  { id: 'lightning', name: 'Lightning', category: 'destruction', target: 'ground', radius: 2.4, cooldown: 0.5, icon: 'lightning', hint: 'Strike the land. Sets trees ablaze and terrifies anyone nearby.' },
  { id: 'meteor', name: 'Meteor', category: 'destruction', target: 'ground', radius: 11, cooldown: 12, icon: 'meteor', hint: 'Call down a falling star. It leaves a smoking crater.' },
  { id: 'quake', name: 'Earthquake', category: 'destruction', target: 'ground', radius: 38, cooldown: 18, icon: 'quake', hint: 'Shake the earth: buildings crack, trees topple, people fall.' },
  { id: 'wildfire', name: 'Wildfire', category: 'destruction', target: 'ground', radius: 7, cooldown: 5, icon: 'fire', hint: 'Set the land alight.' },
  { id: 'rain', name: 'Rain', category: 'weather', target: 'ground', radius: 18, cooldown: 2, icon: 'rain', hint: 'Summon a rain cloud. Puts out fires, waters plants, quenches thirst.' },
  { id: 'storm', name: 'Storm', category: 'weather', target: 'ground', radius: 42, cooldown: 18, icon: 'storm', hint: 'A great storm with thunder and wild lightning of its own.' },
  { id: 'fog', name: 'Mist', category: 'weather', target: 'ground', radius: 50, cooldown: 12, icon: 'fog', hint: 'A strange mist rolls in. People see less and wonder.' },
  { id: 'drought', name: 'Drought', category: 'weather', target: 'ground', radius: 60, cooldown: 25, icon: 'sun', hint: 'Withhold the rain. Fruit withers on the branch and fires spread.' },
  { id: 'clear', name: 'Clear Skies', category: 'weather', target: 'ground', radius: 80, cooldown: 6, icon: 'sun', hint: 'Part the clouds, lift the mist, end a drought.' },
  { id: 'heal', name: 'Heal', category: 'life', target: 'person', radius: 3, cooldown: 1.2, icon: 'heal', hint: 'Mend a human: restores health, calms fear, lifts them up.' },
  { id: 'resurrect', name: 'Resurrect', category: 'life', target: 'body', radius: 4, cooldown: 40, icon: 'resurrect', hint: 'Call someone back from death (a body or a fresh grave).' },
  { id: 'harvest', name: 'Bounty', category: 'life', target: 'ground', radius: 26, cooldown: 20, icon: 'food', hint: 'Every bush and tree nearby bursts with fruit.' },
  { id: 'fertility', name: 'Fertility', category: 'life', target: 'civ', radius: 0, cooldown: 45, icon: 'heart', hint: 'Bless a people with children.' },
  { id: 'raise', name: 'Shape Land', category: 'world', target: 'ground', radius: 16, cooldown: 1.5, icon: 'mountain', hint: 'Raise a hill. Hold Shift to lower the land instead.' },
  { id: 'teleport', name: 'Carry', category: 'world', target: 'person', radius: 1.5, cooldown: 2, icon: 'hand', hint: 'Pick someone up, then click where to set them down.' },
  { id: 'vision', name: 'Vision', category: 'world', target: 'civ', radius: 0, cooldown: 30, icon: 'eye', hint: 'Show a people a land they have never seen, and good ground to settle.' },
  { id: 'inspire', name: 'Inspire', category: 'peoples', target: 'civ', radius: 0, cooldown: 35, icon: 'bulb', hint: 'Fill a people with ambition: they explore and build with new zeal.' },
  { id: 'peace', name: 'Peace', category: 'peoples', target: 'civ', radius: 0, cooldown: 35, icon: 'dove', hint: 'Calm the hearts of a people toward all their neighbours.' },
  { id: 'sanctuary', name: 'Sanctuary', category: 'peoples', target: 'civ', radius: 0, cooldown: 40, icon: 'shield', hint: 'Shelter a people for a day: no hunger, no harm.' },
  { id: 'curse', name: 'Curse', category: 'peoples', target: 'civ', radius: 0, cooldown: 30, icon: 'curse', hint: 'Lay a curse on a people: sickness, slow work, few children.' },
  { id: 'wrath', name: 'Wrath', category: 'peoples', target: 'civ', radius: 0, cooldown: 30, icon: 'lightning', hint: 'Show your anger over their homes without killing anyone.' },
  { id: 'manifest', name: 'Manifest', category: 'miracles', target: 'ground', radius: 10, cooldown: 60, icon: 'sun', hint: 'Come down among them as a pillar of light. People gather to kneel.' },
  { id: 'sign', name: 'Sign in the Sky', category: 'miracles', target: 'civ', radius: 0, cooldown: 25, icon: 'star', hint: 'Paint the sky above a people with light. Answers a plea for a sign.' },
];

export const POWER = Object.fromEntries(POWERS.map((p) => [p.id, p])) as Record<PowerId, PowerDef>;

export interface PowerResult {
  ok: boolean;
  /** Shown to the player (why it failed, or what happened). */
  message?: string;
}

const fail = (message: string): PowerResult => ({ ok: false, message });
const OK: PowerResult = { ok: true };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Which people a click means: the person clicked, the land clicked, or the nearest village. */
export function civAt(w: World, x: number, z: number, humanId: number | null): Civilization | null {
  const a = w.agent(humanId);
  if (a && a.alive) return w.civs[a.civId] ?? null;
  const owner = territoryAt(w, x, z);
  if (owner >= 0 && w.civs[owner]!.population > 0) return w.civs[owner]!;
  let best: Civilization | null = null;
  let bd = 90;
  for (const s of w.settlements) {
    const c = w.civs[s.civId];
    if (!c || c.population === 0) continue;
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

function capitalOf(w: World, civ: Civilization): V2 {
  return campCenter(w, civ.capital?.id ?? -1);
}

function spawnResource(w: World, kind: ResourceKind, x: number, z: number, opts: Partial<ResourceNode> = {}): ResourceNode {
  const amount = opts.amount ?? 3;
  const r: ResourceNode = {
    id: w.nextId(),
    kind,
    variant: 0,
    x,
    z,
    rot: w.rng.range(0, TAU),
    scale: 1,
    blockRadius: 0,
    amount,
    max: amount,
    regrow: 0,
    state: 'grown',
    growth: 1,
    burning: 0,
    claims: 0,
    blessed: false,
    lastUse: -1e9,
    ...opts,
  };
  w.addResource(r);
  return r;
}

/** Nothing solid within `r` (resources, buildings, people). */
function spotFree(w: World, x: number, z: number, r: number): boolean {
  if (!w.nav.terrainWalkable(x, z) || w.terrain.isWater(x, z) || w.terrain.heightAt(x, z) < 0.6) return false;
  let blocked = false;
  w.resourceHash.query(x, z, r + 1.2, (o) => {
    if (Math.hypot(o.x - x, o.z - z) < r + Math.max(0.5, o.blockRadius)) blocked = true;
  });
  if (blocked) return false;
  for (const s of w.structures) if (Math.hypot(s.x - x, s.z - z) < BLUEPRINTS[s.kind].radius + r + 1) return false;
  for (const a of w.agents) if (a.alive && Math.hypot(a.x - x, a.z - z) < 1.6) return false;
  return true;
}

function witnesses(w: World, x: number, z: number, r: number, line: string, faith = 0.05): number {
  let n = 0;
  for (const a of w.agents) {
    if (!a.alive || a.inside !== null) continue;
    const d = Math.hypot(a.x - x, a.z - z);
    if (d > r) continue;
    n++;
    a.faith = Math.min(1, a.faith + faith * (1 - d / r));
    a.emote = { icon: 'star', until: w.now(a) + 3 };
    a.addLog(w.now(a), 'event', line);
    a.brain.nextThink = w.now(a);
  }
  return n;
}

function treeVariantAt(w: World, x: number, z: number): number {
  const b = w.terrain.biomeAt(x, z);
  const roll = w.rng.next();
  if (b === Biome.Highlands) return roll < 0.85 ? TreeVariant.Pine : TreeVariant.Birch;
  if (b === Biome.Elderwood) return roll < 0.2 ? TreeVariant.Elder : roll < 0.5 ? TreeVariant.Pine : TreeVariant.Broadleaf;
  if (b === Biome.CrystalWilds) return roll < 0.7 ? TreeVariant.Silverbark : TreeVariant.Pine;
  if (b === Biome.Ashen) return roll < 0.6 ? TreeVariant.Deadwood : TreeVariant.Pine;
  if (w.terrain.heightAt(x, z) < 1.8) return TreeVariant.Palm;
  return roll < 0.2 ? TreeVariant.Birch : TreeVariant.Broadleaf;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/** Grow a blessed fruit tree (or berry bushes where a tree won't fit). */
export function bless(w: World, x: number, z: number): boolean {
  if (!w.nav.terrainWalkable(x, z) || w.terrain.heightAt(x, z) < 0.6) return false;
  const treeOk = siteClear(w, x, z, 1.2) && spotFree(w, x, z, 0.6);
  if (treeOk) {
    spawnResource(w, 'fruitTree', x, z, { amount: 7, blockRadius: 0.4, scale: 1.12, blessed: true });
  } else {
    let any = false;
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU;
      const px = x + Math.cos(a) * 1.4;
      const pz = z + Math.sin(a) * 1.4;
      if (!w.nav.terrainWalkable(px, pz)) continue;
      spawnResource(w, 'berryBush', px, pz, { amount: 6, blessed: true });
      any = true;
    }
    if (!any) return false;
  }
  w.events.emit('fx', { kind: 'sparkle', x, z, y: 1, count: 40 });
  w.events.emit('fx', { kind: 'bloom', x, z, count: 24 });
  w.events.emit('sfx', { kind: 'bless', x, z });
  w.log(`The land is blessed ${describePlace(w, x, z)}: a fruit tree springs up!`, 'bless', 2, { x, z });
  witnesses(w, x, z, 22, 'A tree grew out of the ground in front of my eyes!', 0.18);
  divineEvent(w, { kind: 'food', x, z, radius: 22, text: `A fruit tree sprang from the ground ${describePlace(w, x, z)}.` });
  return true;
}

function growForest(w: World, x: number, z: number): PowerResult {
  let n = 0;
  for (let k = 0; k < 60 && n < 14; k++) {
    const a = w.rng.range(0, TAU);
    const r = Math.sqrt(w.rng.next()) * 13;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    if (!spotFree(w, px, pz, 2)) continue;
    const variant = treeVariantAt(w, px, pz);
    const grown = w.rng.chance(0.35);
    spawnResource(w, 'tree', px, pz, { variant, amount: grown ? 3 : 0, max: 4, blockRadius: 0.45, scale: w.rng.range(0.85, 1.15), state: grown ? 'grown' : 'sapling', growth: grown ? 1 : w.rng.range(0.45, 0.8) });
    if (w.rng.chance(0.3)) {
      const bx = px + w.rng.range(-2, 2);
      const bz = pz + w.rng.range(-2, 2);
      if (spotFree(w, bx, bz, 0.8)) spawnResource(w, 'berryBush', bx, bz, { amount: 4 });
    }
    n++;
  }
  if (!n) return fail('Nothing can take root there.');
  w.events.emit('fx', { kind: 'bloom', x, z, count: 40 });
  w.events.emit('fx', { kind: 'leaves', x, z, y: 2, count: 30 });
  w.events.emit('sfx', { kind: 'bless', x, z });
  w.log(`A forest springs up ${describePlace(w, x, z)}.`, 'bless', 2, { x, z });
  witnesses(w, x, z, 30, 'Trees rose from the bare earth!', 0.12);
  divineEvent(w, { kind: 'forest', x, z, radius: 30, text: `A forest sprang up ${describePlace(w, x, z)}.` });
  return OK;
}

function openSpring(w: World, x: number, z: number): PowerResult {
  const why = editBlocked(w, 'spring', x, z, 7);
  if (why) return fail(why);
  editTerrain(w, { kind: 'spring', x, z, r: 6.5, amount: 2.4 });
  w.events.emit('fx', { kind: 'splash', x, z, count: 40 });
  w.events.emit('fx', { kind: 'sparkle', x, z, y: 0.5, count: 50 });
  w.events.emit('sfx', { kind: 'splash', x, z, volume: 1 });
  w.log(`Clear water wells up from the earth ${describePlace(w, x, z)}!`, 'water', 3, { x, z });
  witnesses(w, x, z, 35, 'Water burst out of the ground! A spring, from nowhere!', 0.15);
  for (const a of w.agents) if (a.alive && Math.hypot(a.x - x, a.z - z) < 60) a.memory.water.set(w.water[w.water.length - 1]!.id, { pondId: w.water[w.water.length - 1]!.id, x, z, seenAt: w.now(a), avoidUntil: 0 });
  divineEvent(w, { kind: 'spring', x, z, radius: 35, text: `The god opened a spring ${describePlace(w, x, z)}.` });
  return OK;
}

function deposit(w: World, x: number, z: number): PowerResult {
  let n = 0;
  for (let k = 0; k < 40 && n < 5; k++) {
    const a = w.rng.range(0, TAU);
    const r = Math.sqrt(w.rng.next()) * 5;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    const crystal = n >= 3;
    if (!spotFree(w, px, pz, crystal ? 0.8 : 1.3)) continue;
    if (crystal) spawnResource(w, 'crystal', px, pz, { amount: 3, max: 3, blockRadius: 0.5, scale: w.rng.range(0.8, 1.1) });
    else spawnResource(w, 'rock', px, pz, { variant: w.rng.int(0, 2), amount: 7, max: 7, blockRadius: 0.9, scale: w.rng.range(0.8, 1.2) });
    n++;
  }
  if (!n) return fail('There is no room for stone there.');
  w.events.emit('fx', { kind: 'stoneChips', x, z, count: 24 });
  w.events.emit('fx', { kind: 'dust', x, z, count: 16 });
  w.events.emit('sfx', { kind: 'rumble', x, z, volume: 0.6 });
  w.log(`Stone and crystal rise from the ground ${describePlace(w, x, z)}.`, 'stone', 2, { x, z });
  witnesses(w, x, z, 20, 'Rocks pushed up out of the earth!', 0.06);
  divineEvent(w, { kind: 'deposit', x, z, radius: 20, text: `Stone and crystal rose from the earth ${describePlace(w, x, z)}.` });
  return OK;
}

// ---------------------------------------------------------------------------
// Destruction
// ---------------------------------------------------------------------------

/** A bolt from the sky, aimed by the player. */
export function castLightning(w: World, x: number, z: number): void {
  const r = lightningStrike(w, x, z, true);
  divineEvent(w, { kind: 'lightning', x, z, radius: 14, text: `Lightning struck ${describePlace(w, x, z)}${r.killed ? ', killing someone' : r.hurt ? ', hurting someone' : ''}.`, harmed: r.hurt, killed: r.killed, damaged: r.buildings });
}

function meteor(w: World, x: number, z: number): PowerResult {
  if (w.terrain.heightAt(x, z) < -1) return fail('It would only fall into the sea.');
  const fall = 2.2;
  w.scheduled.push({ at: w.worldTime + fall, kind: 'meteor', x, z, r: 10 });
  w.events.emit('divineFx', { kind: 'meteorFall', x, z, t: fall });
  w.events.emit('sfx', { kind: 'wind', x, z, volume: 0.8 });
  // Everyone looks up.
  for (const a of w.agents) {
    if (!a.alive) continue;
    if (Math.hypot(a.x - x, a.z - z) < 90) {
      a.emote = { icon: 'warning', until: w.now(a) + 4 };
      a.needs.safety = Math.max(0, a.needs.safety - 0.2);
    }
  }
  return OK;
}

/** The falling star lands (called from the simulation step when its time comes). */
export function meteorImpact(w: World, x: number, z: number, r: number): void {
  const why = editBlocked(w, 'crater', x, z, r);
  if (!why && w.terrain.heightAt(x, z) > -1) editTerrain(w, { kind: 'crater', x, z, r: r * 0.85, amount: 3.2 });
  let harmed = 0;
  let killed = 0;
  let damaged = 0;
  for (const a of w.agents) {
    if (!a.alive) continue;
    const d = Math.hypot(a.x - x, a.z - z);
    if (d > r * 3.5) continue;
    if (d < r * 0.55) {
      if (a.protectedUntil > w.worldTime) {
        a.needs.health = 0.3;
        a.knocked = 5;
        harmed++;
      } else {
        a.inside = null;
        kill(a, w, 'meteor');
        killed++;
      }
      continue;
    }
    if (d < r * 1.3) {
      a.inside = null;
      a.needs.health = Math.max(a.protectedUntil > w.worldTime ? 0.3 : 0.02, a.needs.health - 0.55 * (1 - d / (r * 1.3)));
      a.knocked = 4;
      harmed++;
      a.addLog(w.now(a), 'event', 'A star fell from the sky and threw me off my feet!');
    } else if (a.inside === null) {
      a.knocked = Math.max(a.knocked, d < r * 2 ? 2 : 0);
    }
    a.needs.safety = Math.max(0, a.needs.safety - 0.7 * (1 - d / (r * 3.5)));
    a.memory.addDanger({ x, z, at: w.now(a), kind: 'lightning' });
    a.brain.nextThink = w.now(a);
  }
  for (const s of [...w.structures]) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < r * 0.75 && s.kind !== 'grave') {
      const bp = BLUEPRINTS[s.kind];
      w.log(`The falling star destroyed ${w.civs[s.civId] ? `${w.civs[s.civId]!.name}'s` : 'a'} ${bp.name.toLowerCase()}.`, 'fire', 3, s);
      w.removeStructure(s);
      damaged++;
    } else if (d < r * 1.5 && s.kind !== 'grave') {
      s.damage = Math.min(0.95, s.damage + 0.4);
      igniteStructure(w, s);
      damaged++;
    }
  }
  w.resourceHash.query(x, z, r * 1.7, (res) => {
    const d = Math.hypot(res.x - x, res.z - z);
    if (res.kind === 'rock' || res.kind === 'crystal') return;
    if (d < r * 0.9) {
      if (res.state !== 'burnt') {
        res.amount = 0;
        w.setResourceState(res, 'burnt');
      }
    } else if (d < r * 1.7 && w.rng.chance(0.6)) igniteResource(w, res);
  });
  // A few boulders thrown from the crater, and shards of the star itself.
  for (let k = 0; k < 4; k++) {
    const a = w.rng.range(0, TAU);
    const d = r * w.rng.range(1.1, 1.6);
    const px = x + Math.cos(a) * d;
    const pz = z + Math.sin(a) * d;
    if (spotFree(w, px, pz, 1)) spawnResource(w, k === 0 ? 'crystal' : 'rock', px, pz, k === 0 ? { amount: 4, max: 4, blockRadius: 0.5 } : { variant: 2, amount: 5, max: 5, blockRadius: 0.8, scale: w.rng.range(0.7, 1) });
  }
  w.scorches.push({ id: w.nextId(), x, z, radius: r * 1.1, age: 0 });
  w.dangers.push({ id: w.nextId(), x, z, radius: r * 2, ttl: HOUR, kind: 'fire' });
  w.events.emit('divineFx', { kind: 'meteorImpact', x, z, r });
  w.events.emit('sfx', { kind: 'impact', x, z, volume: 1 });
  w.events.emit('sfx', { kind: 'rumble', x, z, volume: 1 });
  w.log(`A star fell from the sky ${describePlace(w, x, z)}!${killed ? ` ${killed} ${killed === 1 ? 'person was' : 'people were'} killed.` : ''}`, 'fire', 3, { x, z });
  divineEvent(w, { kind: 'meteor', x, z, radius: r * 4, text: `A star fell from the sky ${describePlace(w, x, z)}${killed ? ` and killed ${killed}` : ''}.`, harmed, killed, damaged });
}

function quake(w: World, x: number, z: number): PowerResult {
  const r = 38;
  let harmed = 0;
  let damaged = 0;
  let fell = 0;
  for (const a of w.agents) {
    if (!a.alive) continue;
    const d = Math.hypot(a.x - x, a.z - z);
    if (d > r) continue;
    const k = 1 - d / r;
    if (a.inside !== null && w.rng.chance(0.5 * k)) {
      a.inside = null;
      a.needs.health = Math.max(0.1, a.needs.health - 0.2 * k);
      harmed++;
    }
    a.knocked = Math.max(a.knocked, 1 + k * 2.5);
    a.needs.safety = Math.max(0, a.needs.safety - 0.55 * k);
    a.addLog(w.now(a), 'event', d < r * 0.5 ? 'The ground heaved under my feet!' : 'The earth shook!');
    a.memory.addDanger({ x, z, at: w.now(a), kind: 'lightning' });
    a.brain.nextThink = w.now(a);
  }
  for (const s of [...w.structures]) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d > r || s.kind === 'grave') continue;
    const k = 1 - d / r;
    const frail = s.kind === 'tent' ? 1.6 : s.kind === 'hut' || s.kind === 'storage' ? 1.2 : s.kind === 'monument' || s.kind === 'hall' ? 0.6 : 1;
    s.damage += w.rng.range(0.25, 0.6) * k * frail * (s.complete ? 1 : 1.5);
    damaged++;
    if (s.damage >= 1) {
      w.log(`The earthquake brought down ${w.civs[s.civId] ? `${w.civs[s.civId]!.name}'s` : 'a'} ${BLUEPRINTS[s.kind].name.toLowerCase()}.`, 'warning', 3, s);
      w.events.emit('fx', { kind: 'buildDust', x: s.x, z: s.z, count: 16 });
      w.removeStructure(s);
    } else w.events.emit('structureChanged', s);
  }
  w.resourceHash.query(x, z, r * 0.8, (res) => {
    if (res.kind !== 'tree' || res.state !== 'grown' || res.burning > 0) return;
    const d = Math.hypot(res.x - x, res.z - z);
    if (!w.rng.chance(0.14 * (1 - d / (r * 0.8)))) return;
    const a = w.rng.range(0, TAU);
    w.setResourceState(res, 'stump');
    w.events.emit('treeFelled', { resource: res, dirX: Math.cos(a), dirZ: Math.sin(a) });
    fell++;
  });
  w.events.emit('divineFx', { kind: 'quake', x, z, r });
  w.events.emit('sfx', { kind: 'rumble', x, z, volume: 1 });
  w.log(`The earth shakes ${describePlace(w, x, z)}!${fell ? ` ${fell} trees came down.` : ''}`, 'warning', 3, { x, z });
  divineEvent(w, { kind: 'quake', x, z, radius: r, text: `The earth shook ${describePlace(w, x, z)}.`, harmed, damaged });
  return OK;
}

function wildfire(w: World, x: number, z: number): PowerResult {
  let n = 0;
  w.resourceHash.query(x, z, 7, (r) => {
    if (r.kind === 'rock' || r.kind === 'crystal' || r.state === 'burnt' || r.state === 'stump') return;
    if (Math.hypot(r.x - x, r.z - z) > 7) return;
    igniteResource(w, r);
    n++;
  });
  let damaged = 0;
  for (const s of w.structures) {
    if (Math.hypot(s.x - x, s.z - z) < 4.5 && s.kind !== 'grave') {
      igniteStructure(w, s);
      damaged++;
    }
  }
  if (!n && !damaged) return fail('There is nothing there to burn.');
  w.dangers.push({ id: w.nextId(), x, z, radius: 12, ttl: HOUR * 0.8, kind: 'fire' });
  w.events.emit('fx', { kind: 'embers', x, z, count: 40 });
  w.events.emit('sfx', { kind: 'ignite', x, z });
  w.log(`Fire leaps up ${describePlace(w, x, z)}!`, 'fire', 2, { x, z });
  divineEvent(w, { kind: 'fire', x, z, radius: 18, text: `Fire fell on the land ${describePlace(w, x, z)}.`, damaged });
  return OK;
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

export function summonRain(w: World, x: number, z: number): void {
  // Merge with a nearby god cloud instead of stacking many.
  const near = w.weather.clouds.find((c) => c.god && Math.hypot(c.x - x, c.z - z) < c.radius);
  if (near) {
    near.ttl = Math.max(near.ttl, HOUR * 2.5);
    near.peak = 1;
    near.radius = Math.min(28, near.radius + 3);
    w.log('The rain grows heavier.', 'rain', 1, { x, z });
  } else {
    w.weather.summon(x, z, true, 18, HOUR * 2.5, 1);
    w.log(`Rain clouds gather ${describePlace(w, x, z)}.`, 'rain', 2, { x, z });
  }
  // Rain breaks a drought where it falls.
  for (const d of w.weather.droughts) if (Math.hypot(d.x - x, d.z - z) < d.radius) d.until = Math.min(d.until, w.worldTime + HOUR);
  for (const civ of w.civs) if (civ.capital && Math.hypot(civ.capital.x - x, civ.capital.z - z) < 80) civ.timers.set('lastRain', w.worldTime);
  divineEvent(w, { kind: 'rain', x, z, radius: 20, text: `Rain was sent ${describePlace(w, x, z)}.` });
}

function storm(w: World, x: number, z: number): PowerResult {
  w.weather.summon(x, z, false, 42, HOUR * 3.5, 1);
  w.events.emit('sfx', { kind: 'thunder', x, z, volume: 0.7 });
  w.log(`A great storm gathers ${describePlace(w, x, z)}!`, 'rain', 3, { x, z });
  for (const civ of w.civs) if (civ.capital && Math.hypot(civ.capital.x - x, civ.capital.z - z) < 80) civ.timers.set('lastRain', w.worldTime);
  divineEvent(w, { kind: 'storm', x, z, radius: 42, text: `A storm was called down ${describePlace(w, x, z)}.` });
  return OK;
}

function mist(w: World, x: number, z: number): PowerResult {
  w.weather.addFog(x, z, 55, HOUR * 4, 0.9);
  w.events.emit('sfx', { kind: 'wind', x, z, volume: 0.4 });
  w.log(`A strange mist rolls in ${describePlace(w, x, z)}.`, 'rain', 2, { x, z });
  witnesses(w, x, z, 55, 'A mist came from nowhere. It feels... watched.', 0.03);
  divineEvent(w, { kind: 'fog', x, z, radius: 55, text: `A strange mist covered the land ${describePlace(w, x, z)}.` });
  return OK;
}

function drought(w: World, x: number, z: number): PowerResult {
  w.weather.droughts.push({ x, z, radius: 60, until: w.worldTime + DAY_LENGTH * 1.5 });
  for (const c of w.weather.clouds) if (Math.hypot(c.x - x, c.z - z) < 70) c.ttl = Math.min(c.ttl, 5);
  w.log(`The sky turns hard and dry ${describePlace(w, x, z)}. No rain will fall.`, 'warning', 3, { x, z });
  divineEvent(w, { kind: 'drought', x, z, radius: 60, text: `A drought was laid on the land ${describePlace(w, x, z)}.` });
  return OK;
}

function clearSkies(w: World, x: number, z: number): PowerResult {
  let n = 0;
  for (const c of w.weather.clouds) if (Math.hypot(c.x - x, c.z - z) < 90) {
    c.ttl = Math.min(c.ttl, 3);
    n++;
  }
  for (const f of w.weather.fogs) if (Math.hypot(f.x - x, f.z - z) < 90) {
    f.ttl = Math.min(f.ttl, 3);
    n++;
  }
  for (const d of w.weather.droughts) if (Math.hypot(d.x - x, d.z - z) < d.radius + 40) {
    d.until = w.worldTime;
    n++;
  }
  if (!n) return fail('The sky is already clear there.');
  w.log(`The clouds part ${describePlace(w, x, z)}.`, 'star', 2, { x, z });
  divineEvent(w, { kind: 'clear', x, z, radius: 80, text: `The sky was cleared ${describePlace(w, x, z)}.` });
  return OK;
}

// ---------------------------------------------------------------------------
// Life
// ---------------------------------------------------------------------------

export function healAt(w: World, x: number, z: number, targetId: number | null): number {
  let healed = 0;
  let first: Agent | undefined;
  for (const a of w.agents) {
    if (!a.alive || a.inside !== null) continue;
    const d = Math.hypot(a.x - x, a.z - z);
    if (a.id !== targetId && d > 3) {
      if (d < 14) {
        a.faith = Math.min(1, a.faith + 0.1);
        a.addLog(w.now(a), 'event', 'Saw a light from the sky heal someone!');
      }
      continue;
    }
    a.faith = Math.min(1, a.faith + 0.35);
    a.needs.health = 1;
    a.needs.safety = Math.max(a.needs.safety, 0.95);
    a.needs.energy = Math.min(1, Math.max(a.needs.energy, 0.5) + 0.25);
    a.knocked = 0;
    a.emote = { icon: 'heal', until: w.now(a) + 4 };
    a.addLog(w.now(a), 'event', 'Bathed in a warm light — all pain gone.');
    a.thought = 'I feel... blessed. Is someone watching over us?';
    w.events.emit('fx', { kind: 'sparkle', x: a.x, z: a.z, y: 1, count: 24 });
    healed++;
    first ??= a;
    w.log(`${a.name} was healed by a warm light from the sky.`, 'heal', 2, a, a.id);
  }
  if (healed) {
    w.events.emit('sfx', { kind: 'heal', x, z });
    divineEvent(w, { kind: 'heal', x, z, radius: 12, text: `${first!.name} was healed by a light from the sky.`, agent: first });
  }
  return healed;
}

/** The dead near a spot: a body not yet buried, or someone recently laid in a grave. */
export function findDead(w: World, x: number, z: number): Agent | undefined {
  let best: Agent | undefined;
  let bd = 5;
  for (const a of w.agents) {
    if (a.alive) continue;
    const civ = w.civOf(a);
    const since = (civ ? civ.clock : w.worldTime) - a.diedAt;
    if (since > DAY_LENGTH * 2.5) continue;
    let px = a.x;
    let pz = a.z;
    if (a.buried) {
      const g = w.structures.find((s) => s.kind === 'grave' && s.foundedBy === a.id);
      if (!g) continue;
      px = g.x;
      pz = g.z;
    }
    const d = Math.hypot(px - x, pz - z);
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  return best;
}

function resurrect(w: World, x: number, z: number): PowerResult {
  const a = findDead(w, x, z);
  if (!a) return fail('No one here died recently enough to be called back.');
  const civ = w.civOf(a);
  const grave = w.structures.find((s) => s.kind === 'grave' && s.foundedBy === a.id);
  if (grave) {
    a.x = a.prevX = grave.x;
    a.z = a.prevZ = grave.z;
    w.removeStructure(grave);
  }
  const p = w.nav.nearestWalkable(a.x, a.z, 6);
  if (p) {
    a.x = a.prevX = p.x;
    a.z = a.prevZ = p.z;
  }
  const wasBuried = a.buried;
  a.alive = true;
  a.buried = false;
  a.deathCause = '';
  a.inside = null;
  a.knocked = 3;
  a.needs = { hunger: 0.7, thirst: 0.7, energy: 0.7, health: 0.8, safety: 0.6, social: 0.6 };
  a.faith = Math.min(1, a.faith + 0.6);
  a.brain.active = null;
  a.brain.nextThink = w.now(a);
  a.nav.status = 'idle';
  a.nav.path = [];
  a.setAnim('idle');
  a.thought = 'I was... somewhere else. And then a voice called me back.';
  a.addLog(w.now(a), 'event', 'Called back from death by the god.');
  if (wasBuried || !w.agentHash.has(a)) w.agentHash.insert(a);
  if (civ && !civ.members.includes(a)) civ.members.push(a);
  if (civ) civ.stats.deaths = Math.max(0, civ.stats.deaths - 1);
  w.stats.deaths = Math.max(0, w.stats.deaths - 1);
  w.events.emit('fx', { kind: 'sparkle', x: a.x, z: a.z, y: 1, count: 70 });
  w.events.emit('divineFx', { kind: 'beam', x: a.x, z: a.z });
  w.events.emit('sfx', { kind: 'choir', x: a.x, z: a.z, volume: 1 });
  w.log(`${a.name}${civ ? ` of ${civ.name}` : ''} rose from the dead!`, 'star', 3, a, a.id);
  witnesses(w, a.x, a.z, 40, `${a.name} came back from the dead! I saw it!`, 0.3);
  for (const o of civ?.members ?? []) if (o.alive && o !== a) o.needs.safety = Math.min(1, o.needs.safety + 0.2);
  if (civ) civHistory(w, civ, `${a.name} was raised from the dead by the god.`, 'divine', 3);
  divineEvent(w, { kind: 'resurrect', x: a.x, z: a.z, radius: 40, text: `${a.name} was brought back from death.`, agent: a });
  return OK;
}

function bounty(w: World, x: number, z: number): PowerResult {
  let n = 0;
  w.resourceHash.query(x, z, 26, (r) => {
    if (r.kind !== 'berryBush' && r.kind !== 'fruitTree' && r.kind !== 'mushroom') return;
    if (Math.hypot(r.x - x, r.z - z) > 26 || r.burning > 0) return;
    if (r.state !== 'grown') w.setResourceState(r, 'grown', 1);
    r.amount = r.max = Math.max(r.max, r.kind === 'fruitTree' ? 7 : 5);
    r.blessed = true;
    w.events.emit('resourceChanged', r);
    n++;
  });
  if (!n) return fail('No fruit-bearing plants grow there.');
  w.events.emit('fx', { kind: 'bloom', x, z, count: 60 });
  w.events.emit('fx', { kind: 'sparkle', x, z, y: 1, count: 30 });
  w.events.emit('sfx', { kind: 'bless', x, z });
  w.log(`Every bush and tree ${describePlace(w, x, z)} bursts with fruit!`, 'food', 3, { x, z });
  witnesses(w, x, z, 40, 'The bushes are so full the branches bend!', 0.1);
  divineEvent(w, { kind: 'harvest', x, z, radius: 30, text: `A great bounty ripened overnight ${describePlace(w, x, z)}.` });
  return OK;
}

function fertility(w: World, civ: Civilization): PowerResult {
  civ.addEffect('fertile', DAY_LENGTH * 2, 1, w.worldTime);
  const c = capitalOf(w, civ);
  w.events.emit('fx', { kind: 'hearts', x: c.x, z: c.z, count: 24 });
  w.events.emit('fx', { kind: 'bloom', x: c.x, z: c.z, count: 30 });
  for (const a of civ.members) if (a.alive && !a.isChild) for (const [id, v] of a.relations) if (v > 0.45) a.relations.set(id, Math.min(1, v + 0.1));
  w.log(`${civ.name} is blessed with fertility. There will be children.`, 'heart', 3, c);
  divineEvent(w, { kind: 'fertile', x: c.x, z: c.z, radius: 30, text: `The god blessed the ${civ.people} with children.`, civ });
  return OK;
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

function shapeLand(w: World, x: number, z: number, lower: boolean): PowerResult {
  const why = editBlocked(w, lower ? 'lower' : 'raise', x, z, 16);
  if (why) return fail(why);
  for (const s of w.structures) if (Math.hypot(s.x - x, s.z - z) < 10 && s.kind !== 'grave') return fail('People live there. Shape the land away from their homes.');
  editTerrain(w, { kind: lower ? 'lower' : 'raise', x, z, r: 16, amount: 3.2 });
  w.events.emit('divineFx', { kind: 'quake', x, z, r: 14 });
  w.events.emit('fx', { kind: 'dust', x, z, count: 16 });
  w.events.emit('sfx', { kind: 'rumble', x, z, volume: 0.8 });
  witnesses(w, x, z, 40, lower ? 'The ground sank before my eyes!' : 'A hill rose out of the ground!', 0.06);
  w.log(lower ? `The land sinks ${describePlace(w, x, z)}.` : `A hill rises ${describePlace(w, x, z)}.`, 'star', 2, { x, z });
  divineEvent(w, { kind: 'raise', x, z, radius: 30, text: lower ? `The land sank ${describePlace(w, x, z)}.` : `A hill rose ${describePlace(w, x, z)}.` });
  return OK;
}

/** Pick someone up and set them down somewhere else. */
export function carry(w: World, id: number, x: number, z: number): PowerResult {
  const a = w.agent(id);
  if (!a || !a.alive) return fail('They are gone.');
  const p = w.nav.nearestWalkable(x, z, 4);
  if (!p) return fail('They cannot stand there.');
  const home = campCenter(w, a.settlementId);
  if (!w.nav.connected(p.x, p.z, home.x, home.z)) return fail('They could never walk home from there.');
  const from = { x: a.x, z: a.z };
  abortActive(a, w, 'Carried off by the god');
  stopNav(a, w);
  a.inside = null;
  a.x = a.prevX = p.x;
  a.z = a.prevZ = p.z;
  w.agentHash.update(a);
  a.knocked = 1.5;
  a.needs.safety = Math.max(0, a.needs.safety - 0.3);
  a.faith = Math.min(1, a.faith + 0.2);
  a.memory.explored[mapIndexSafe(p.x, p.z)] = 1;
  a.addLog(w.now(a), 'event', `Lifted into the air and set down ${describePlace(w, p.x, p.z)}!`);
  a.thought = 'Where... where am I? The sky carried me!';
  a.brain.nextThink = w.now(a);
  w.events.emit('fx', { kind: 'sparkle', x: from.x, z: from.z, y: 1, count: 30 });
  w.events.emit('fx', { kind: 'sparkle', x: p.x, z: p.z, y: 1, count: 30 });
  w.events.emit('divineFx', { kind: 'beam', x: p.x, z: p.z });
  w.log(`${a.name} was carried through the air by an unseen hand.`, 'star', 2, p, a.id);
  divineEvent(w, { kind: 'teleport', x: p.x, z: p.z, radius: 20, text: `${a.name} was lifted up and carried away by the god.`, agent: a });
  return OK;
}

function mapIndexSafe(x: number, z: number): number {
  const i = mapIndex(x, z);
  return i < 0 ? 0 : i;
}

function vision(w: World, civ: Civilization): PowerResult {
  const home = capitalOf(w, civ);
  const unknown = w.terrain.regions.filter((r) => !civ.knowledge.regions.has(r.id)).sort((a, b) => Math.hypot(a.x - home.x, a.z - home.z) - Math.hypot(b.x - home.x, b.z - home.z));
  const region = unknown[0];
  if (!region) return fail(`${civ.name} already know every land there is.`);
  civ.knowledge.regions.add(region.id);
  const r = Math.ceil(region.radius / MAP_CELL);
  const cx0 = Math.floor((region.x + WORLD_HALF) / MAP_CELL);
  const cz0 = Math.floor((region.z + WORLD_HALF) / MAP_CELL);
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    const cx = cx0 + dx;
    const cz = cz0 + dz;
    if (cx >= 0 && cz >= 0 && cx < MAP_N && cz < MAP_N) civ.knowledge.map[cz * MAP_N + cx] = 1;
  }
  // Show them good ground: near water, unclaimed.
  let best: { x: number; z: number; score: number } | null = null;
  for (let k = 0; k < 80; k++) {
    const a = w.rng.range(0, TAU);
    const d = Math.sqrt(w.rng.next()) * region.radius;
    const x = region.x + Math.cos(a) * d;
    const z = region.z + Math.sin(a) * d;
    if (!w.nav.walkable(x, z) || territoryAt(w, x, z) >= 0 || w.terrain.slopeAt(x, z) > 0.35) continue;
    let water = 99;
    for (const wb of w.water) water = Math.min(water, Math.hypot(wb.x - x, wb.z - z) - wb.radius);
    if (water > 40) continue;
    const score = 3 - water / 30;
    if (!best || score > best.score) best = { x, z, score };
  }
  if (best && !civ.knowledge.prospects.some((p) => Math.hypot(p.x - best!.x, p.z - best!.z) < 40)) {
    civ.knowledge.prospects.unshift({ x: best.x, z: best.z, score: 5, note: `good land in ${region.name}, shown in a vision`, foundAt: civ.clock });
    if (civ.knowledge.prospects.length > 6) civ.knowledge.prospects.length = 6;
  }
  const c = capitalOf(w, civ);
  const leader = leaderOf(w, civ);
  w.events.emit('divineFx', { kind: 'beam', x: leader?.x ?? c.x, z: leader?.z ?? c.z });
  w.log(`${leader?.name ?? civ.name} dreamed of ${region.name}, a land they had never seen.`, 'discovery', 3, c, leader?.id);
  civHistory(w, civ, `A vision showed ${leader?.name ?? 'the elders'} the land of ${region.name}.`, 'discovery', 3);
  leaderMemory(civ, `The god showed me ${region.name} in a vision${best ? ', and good land to settle there' : ''}.`, 3);
  requestLeaderThought(w, civ, `vision of ${region.name}`);
  divineEvent(w, { kind: 'revelation', x: c.x, z: c.z, radius: 20, text: `The god sent ${leader?.name ?? 'them'} a vision of ${region.name}.`, civ });
  return OK;
}

// ---------------------------------------------------------------------------
// Peoples
// ---------------------------------------------------------------------------

function inspire(w: World, civ: Civilization): PowerResult {
  civ.addEffect('inspireExplore', DAY_LENGTH * 1.5, 1, w.worldTime);
  civ.addEffect('inspireBuild', DAY_LENGTH * 1.5, 1, w.worldTime);
  for (const a of civ.members) {
    if (!a.alive) continue;
    a.needs.energy = Math.min(1, a.needs.energy + 0.25);
    a.needs.social = Math.min(1, a.needs.social + 0.15);
    a.brain.nextThink = w.now(a);
  }
  const c = capitalOf(w, civ);
  w.events.emit('fx', { kind: 'sparkle', x: c.x, z: c.z, y: 2, count: 50 });
  w.events.emit('sfx', { kind: 'horn', x: c.x, z: c.z });
  w.log(`${civ.name} are filled with a restless fire: to explore, to build!`, 'star', 3, c);
  requestLeaderThought(w, civ, 'divine inspiration');
  divineEvent(w, { kind: 'inspire', x: c.x, z: c.z, radius: 30, text: `The god filled the ${civ.people} with ambition.`, civ });
  return OK;
}

function peace(w: World, civ: Civilization): PowerResult {
  const known = [...civ.relations.values()].filter((r) => r.state !== 'unknown');
  if (!known.length) return fail(`${civ.name} have not met anyone to make peace with.`);
  for (const r of known) {
    const other = w.civs[r.civId]!;
    const back = other.relation(civ.id);
    r.opinion = Math.min(1, r.opinion + 0.35);
    back.opinion = Math.min(1, back.opinion + 0.25);
    r.truceUntil = back.truceUntil = w.worldTime + DAY_LENGTH * 3;
    r.state = stateFromOpinion(r.state, r.opinion);
    if (back.state !== 'unknown') back.state = stateFromOpinion(back.state, back.opinion);
    for (const o of civ.objectives) if (o.kind === 'PREPARE_DEFENSE' && o.civ === other.id) o.until = w.worldTime;
  }
  const c = capitalOf(w, civ);
  w.events.emit('fx', { kind: 'sparkle', x: c.x, z: c.z, y: 2, count: 40 });
  w.log(`A deep calm settles over ${civ.name}. Old grudges feel far away.`, 'social', 3, c);
  civHistory(w, civ, 'The god calmed their hearts toward their neighbours.', 'relation', 2);
  divineEvent(w, { kind: 'peace', x: c.x, z: c.z, radius: 40, text: `The god laid peace on the ${civ.people}.`, civ });
  return OK;
}

function sanctuary(w: World, civ: Civilization): PowerResult {
  for (const a of civ.members) {
    if (!a.alive) continue;
    a.protectedUntil = w.worldTime + DAY_LENGTH;
    a.needs.safety = Math.max(a.needs.safety, 0.9);
  }
  civ.addEffect('blessed', DAY_LENGTH, 1, w.worldTime);
  const c = capitalOf(w, civ);
  w.events.emit('divineFx', { kind: 'dome', x: c.x, z: c.z, r: 40 });
  w.events.emit('sfx', { kind: 'choir', x: c.x, z: c.z, volume: 0.7 });
  w.log(`${civ.name} are sheltered: for a day no hunger, thirst or harm can touch them.`, 'heal', 3, c);
  divineEvent(w, { kind: 'sanctuary', x: c.x, z: c.z, radius: 40, text: `The god sheltered the ${civ.people} from all harm.`, civ });
  return OK;
}

function curse(w: World, civ: Civilization): PowerResult {
  civ.addEffect('cursed', DAY_LENGTH * 1.5, 1, w.worldTime);
  for (const a of civ.members) if (a.alive) a.cursedUntil = w.worldTime + DAY_LENGTH * 1.5;
  const c = capitalOf(w, civ);
  w.events.emit('fx', { kind: 'anger', x: c.x, z: c.z, count: 40 });
  w.events.emit('sfx', { kind: 'rumble', x: c.x, z: c.z, volume: 0.6 });
  w.log(`A curse falls on ${civ.name}. The air itself feels heavy.`, 'warning', 3, c);
  divineEvent(w, { kind: 'curse', x: c.x, z: c.z, radius: 40, text: `The god cursed the ${civ.people}.`, civ });
  return OK;
}

function wrath(w: World, civ: Civilization): PowerResult {
  const c = capitalOf(w, civ);
  w.weather.summon(c.x, c.z, true, 36, HOUR * 1.5, 0.9);
  let strikes = 0;
  for (let k = 0; k < 16 && strikes < 4; k++) {
    const a = w.rng.range(0, TAU);
    const d = w.rng.range(16, 34);
    const x = c.x + Math.cos(a) * d;
    const z = c.z + Math.sin(a) * d;
    if (w.agents.some((o) => o.alive && Math.hypot(o.x - x, o.z - z) < 6)) continue;
    if (w.structures.some((s) => Math.hypot(s.x - x, s.z - z) < BLUEPRINTS[s.kind].radius + 4)) continue;
    lightningStrike(w, x, z, true);
    strikes++;
  }
  civ.addEffect('wrath', DAY_LENGTH, 1, w.worldTime);
  w.log(`The sky rages over ${civ.name}!`, 'lightning', 3, c);
  divineEvent(w, { kind: 'wrath', x: c.x, z: c.z, radius: 40, text: `The sky raged over the ${civ.people}.`, civ });
  return OK;
}

// ---------------------------------------------------------------------------
// Miracles
// ---------------------------------------------------------------------------

function manifest(w: World, x: number, z: number): PowerResult {
  if (w.terrain.heightAt(x, z) < 0.3) return fail('Come down on the land, where they can reach you.');
  w.presence = { x, z, since: w.worldTime, until: w.worldTime + HOUR * 1.6 };
  w.events.emit('divineFx', { kind: 'manifest', x, z, t: HOUR * 1.6 });
  w.events.emit('sfx', { kind: 'choir', x, z, volume: 1 });
  const n = witnesses(w, x, z, 95, 'The god came down to the land as a pillar of light!', 0.2);
  w.log(`The god walks among the peoples ${describePlace(w, x, z)}!${n ? ` ${n} ${n === 1 ? 'person comes' : 'people come'} to see.` : ''}`, 'star', 3, { x, z });
  divineEvent(w, { kind: 'manifest', x, z, radius: 95, text: `The god came down as a pillar of light ${describePlace(w, x, z)}.` });
  return OK;
}

function sign(w: World, civ: Civilization): PowerResult {
  const c = capitalOf(w, civ);
  w.events.emit('divineFx', { kind: 'sign', x: c.x, z: c.z, civId: civ.id });
  w.events.emit('sfx', { kind: 'chime', x: c.x, z: c.z, volume: 1 });
  witnesses(w, c.x, c.z, 140, 'Lights danced across the sky! It must be a sign!', 0.1);
  w.log(`Lights dance across the sky above ${civ.name}.`, 'star', 3, c);
  divineEvent(w, { kind: 'revelation', x: c.x, z: c.z, radius: 140, text: `Lights danced across the sky above the ${civ.people}.`, civ });
  return OK;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface PowerUse {
  x: number;
  z: number;
  humanId: number | null;
  /** Shift held (shape land lowers). */
  alt?: boolean;
}

/** Use a power on the world (world context). Carry is two-step and handled by the caller. */
export function usePower(w: World, id: PowerId, u: PowerUse): PowerResult {
  const { x, z } = u;
  const def = POWER[id];
  let civ: Civilization | null = null;
  if (def.target === 'civ') {
    civ = civAt(w, x, z, u.humanId);
    if (!civ) return fail("Click on a people's land, a village, or one of their people.");
  }
  switch (id) {
    case 'bless':
      return bless(w, x, z) ? OK : fail('Nothing can grow there.');
    case 'forest':
      return growForest(w, x, z);
    case 'spring':
      return openSpring(w, x, z);
    case 'deposit':
      return deposit(w, x, z);
    case 'lightning':
      castLightning(w, x, z);
      return OK;
    case 'meteor':
      return meteor(w, x, z);
    case 'quake':
      return quake(w, x, z);
    case 'wildfire':
      return wildfire(w, x, z);
    case 'rain':
      summonRain(w, x, z);
      return OK;
    case 'storm':
      return storm(w, x, z);
    case 'fog':
      return mist(w, x, z);
    case 'drought':
      return drought(w, x, z);
    case 'clear':
      return clearSkies(w, x, z);
    case 'heal':
      return healAt(w, x, z, u.humanId) ? OK : fail('Click on or near a human to heal them.');
    case 'resurrect':
      return resurrect(w, x, z);
    case 'harvest':
      return bounty(w, x, z);
    case 'fertility':
      return fertility(w, civ!);
    case 'raise':
      return shapeLand(w, x, z, !!u.alt);
    case 'teleport':
      return fail('Pick someone up first.');
    case 'vision':
      return vision(w, civ!);
    case 'inspire':
      return inspire(w, civ!);
    case 'peace':
      return peace(w, civ!);
    case 'sanctuary':
      return sanctuary(w, civ!);
    case 'curse':
      return curse(w, civ!);
    case 'wrath':
      return wrath(w, civ!);
    case 'manifest':
      return manifest(w, x, z);
    case 'sign':
      return sign(w, civ!);
  }
}

/** Divine acts whose time has come (world context, every step). */
export function processScheduled(w: World): void {
  if (!w.scheduled.length) return;
  for (let i = w.scheduled.length - 1; i >= 0; i--) {
    const s = w.scheduled[i]!;
    if (s.at > w.worldTime) continue;
    w.scheduled.splice(i, 1);
    if (s.kind === 'meteor') meteorImpact(w, s.x, s.z, s.r);
  }
  if (w.presence && w.presence.until < w.worldTime) w.presence = null;
}
