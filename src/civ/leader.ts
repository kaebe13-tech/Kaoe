import type { World } from '../sim/World';
import type { Agent } from '../agents/Agent';
import { DAY_LENGTH, HOUR } from '../world/config';
import { Civilization, RELATION_LABEL, type ObjectiveKind, type RequestKind } from './Civilization';
import { PERSONAS, personaText } from './persona';
import { civFood, civStored, campCenter, sitesOf, siteMissing, eraOf } from '../sim/settlement';
import { civHistory, leaderOf, setObjective } from './civSystem';
import { openRequest } from './divine';
import { LANDMARK_INFO } from '../world/biomes';

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const MAX_MEMORIES = 24;

/** Add a compact memory; older minor ones are folded into a running summary. */
export function leaderMemory(civ: Civilization, text: string, importance: 1 | 2 | 3): void {
  const m = civ.mind;
  const line = `${importance === 3 ? '!! ' : importance === 2 ? '! ' : ''}Day ${civ.day}: ${text}`;
  if (m.memories.some((x) => x.endsWith(text))) return;
  m.memories.push(line);
  if (m.memories.length > MAX_MEMORIES) compressMemories(civ);
}

/** Fold the oldest, least important memories into the summary so the list stays small. */
export function compressMemories(civ: Civilization): void {
  const m = civ.mind;
  const scored = m.memories.map((t, i) => ({ t, i, w: (t.startsWith('!! ') ? 3 : t.startsWith('! ') ? 2 : 1) * 10 + i * 0.5 }));
  scored.sort((a, b) => a.w - b.w);
  const drop = scored.slice(0, Math.max(0, m.memories.length - (MAX_MEMORIES - 6)));
  const dropped = new Set(drop.map((d) => d.i));
  const folded = drop.map((d) => d.t.replace(/^!+ /, '').replace(/^Day \d+: /, '')).slice(0, 6);
  m.summary = trimSummary(`${m.summary ? `${m.summary} ` : ''}Earlier: ${folded.join('; ')}.`);
  m.memories = m.memories.filter((_, i) => !dropped.has(i));
}

function trimSummary(s: string): string {
  return s.length > 700 ? `…${s.slice(s.length - 700)}` : s;
}

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

/** The leader says something to the god (shown in the civ panel and conversation). */
export function say(w: World, civ: Civilization, line: string, mood?: string): void {
  civ.mind.lastSpeech = line;
  if (mood) civ.mind.mood = mood;
  const l = leaderOf(w, civ);
  w.events.emit('civEvent', { civId: civ.id, kind: 'speech', text: line, x: l?.x, z: l?.z });
}

// ---------------------------------------------------------------------------
// Situation
// ---------------------------------------------------------------------------

export interface Situation {
  pop: number;
  adults: number;
  food: number;
  foodPerHead: number;
  hunger: number;
  hurt: Agent[];
  stone: number;
  needsStone: boolean;
  unknownRegions: number[];
  prospects: number;
  hostile: Civilization[];
  tense: Civilization[];
  friendly: Civilization[];
  known: Civilization[];
  era: string;
  settlements: number;
  lastDivineAgo: number;
  fires: boolean;
  dryDays: number;
}

export function assess(w: World, civ: Civilization): Situation {
  const living = civ.living;
  const adults = living.filter((a) => !a.isChild);
  const food = civFood(w, civ);
  const hunger = living.length ? living.reduce((s, a) => s + a.needs.hunger, 0) / living.length : 1;
  const hurt = living.filter((a) => a.needs.health < 0.35);
  const needsStone = civ.settlements.some((s) => sitesOf(w, s.id).some((site) => (siteMissing(site).stone ?? 0) > 0));
  const unknownRegions = w.terrain.regions.filter((r) => !civ.knowledge.regions.has(r.id)).map((r) => r.id);
  const known = w.civs.filter((c) => c !== civ && civ.knows(c.id));
  const rel = (c: Civilization) => civ.relations.get(c.id)?.state;
  const home = civ.capital;
  let fires = false;
  if (home) for (const d of w.dangers) if (d.kind === 'fire' && Math.hypot(d.x - home.x, d.z - home.z) < 60) fires = true;
  const lastDivine = civ.divine[civ.divine.length - 1];
  return {
    pop: living.length,
    adults: adults.length,
    food,
    foodPerHead: food / Math.max(1, living.length),
    hunger,
    hurt,
    stone: civStored(w, civ, 'stone'),
    needsStone,
    unknownRegions,
    prospects: civ.knowledge.prospects.length,
    hostile: known.filter((c) => rel(c) === 'hostile'),
    tense: known.filter((c) => rel(c) === 'tense'),
    friendly: known.filter((c) => rel(c) === 'friendly'),
    known,
    era: home ? eraOf(w, home.id) : 'Camp',
    settlements: civ.settlements.length,
    lastDivineAgo: lastDivine ? (w.worldTime - lastDivine.time) / DAY_LENGTH : 99,
    fires,
    dryDays: (w.worldTime - (civ.timers.get('lastRain') ?? w.worldTime)) / DAY_LENGTH,
  };
}

// ---------------------------------------------------------------------------
// Decisions (shared by the local planner and any external model)
// ---------------------------------------------------------------------------

export interface LeaderDecision {
  speech: string;
  priority: ObjectiveKind | 'NONE';
  reason: string;
  targetRegion?: string;
  targetCiv?: string;
  mood?: string;
  memory?: string;
  ask?: { kind: RequestKind; text: string };
}

export const OBJECTIVE_KINDS: ObjectiveKind[] = [
  'EXPAND',
  'ESTABLISH_SETTLEMENT',
  'EXPLORE_REGION',
  'PRIORITIZE_FOOD',
  'PRIORITIZE_BUILDING',
  'GATHER_MATERIALS',
  'MIGRATE',
  'SEEK_PEACE',
  'AVOID_CIVILIZATION',
  'TRADE',
  'PREPARE_DEFENSE',
  'HONOR_GOD',
  'REST',
];

/**
 * Turn a (validated) decision into simulation objectives. The simulation decides how and whether
 * it can actually happen; this only sets intentions.
 */
export function applyDecision(w: World, civ: Civilization, d: LeaderDecision, source: 'local' | 'ai' | 'god'): void {
  civ.mind.planSource = source === 'ai' ? 'ai' : 'local';
  if (d.mood) civ.mind.mood = d.mood;
  if (d.memory) leaderMemory(civ, d.memory, 2);
  const leader = leaderOf(w, civ);
  if (d.priority !== 'NONE') {
    const region = d.targetRegion ? w.terrain.regions.find((r) => r.name.toLowerCase().includes(d.targetRegion!.toLowerCase().replace(/^the /, ''))) : undefined;
    const other = d.targetCiv ? w.civs.find((c) => c !== civ && (c.name.toLowerCase().includes(d.targetCiv!.toLowerCase().replace(/^the /, '')) || c.people.toLowerCase().includes(d.targetCiv!.toLowerCase()))) : undefined;
    let target = region ? { x: region.x, z: region.z } : undefined;
    let priority = d.priority;
    if (priority === 'EXPAND' || priority === 'ESTABLISH_SETTLEMENT' || priority === 'MIGRATE') {
      // Prefer a scouted site in the named region; otherwise the best known prospect.
      const prospects = civ.knowledge.prospects;
      const p = region ? prospects.find((q) => Math.hypot(q.x - region.x, q.z - region.z) < region.radius * 1.2) ?? prospects[0] : prospects[0];
      if (p) target = { x: p.x, z: p.z };
      else if (priority !== 'MIGRATE') priority = 'EXPLORE_REGION';
    }
    if ((priority === 'SEEK_PEACE' || priority === 'AVOID_CIVILIZATION' || priority === 'TRADE') && !other) priority = 'NONE' as never;
    if (priority !== ('NONE' as string)) {
      const regionId = region?.id ?? (priority === 'EXPLORE_REGION' ? nearestUnknownRegion(w, civ) : undefined);
      setObjective(w, civ, {
        kind: priority as ObjectiveKind,
        reason: d.reason.slice(0, 160),
        source: source === 'god' ? 'god' : 'leader',
        target,
        region: regionId,
        civ: other?.id,
        until: w.worldTime + DAY_LENGTH * (source === 'god' ? 2.5 : 1.5),
      });
    }
  }
  if (d.ask && leader && civ.rep.faith > 0.1) openRequest(w, civ, d.ask.kind, d.ask.text, leader);
  if (d.speech) say(w, civ, d.speech);
}

function nearestUnknownRegion(w: World, civ: Civilization): number | undefined {
  const home = civ.capital ?? civ.settlements[0];
  if (!home) return undefined;
  let best: number | undefined;
  let bd = Infinity;
  for (const r of w.terrain.regions) {
    if (civ.knowledge.regions.has(r.id)) continue;
    const d = Math.hypot(r.x - home.x, r.z - home.z);
    if (d < bd) {
      bd = d;
      best = r.id;
    }
  }
  return best;
}

/** Local strategic judgement: what the leader wants now and why, in their own voice. */
export function localDecision(w: World, civ: Civilization, why: string): LeaderDecision {
  const s = assess(w, civ);
  const leader = leaderOf(w, civ);
  const persona = leader?.persona ?? [];
  const has = (t: string) => persona.includes(t as never);
  const focus = civ.focus(leader, w.worldTime);
  const out: LeaderDecision = { speech: '', priority: 'NONE', reason: '' };
  const faithful = civ.rep.faith > 0.25;

  if (s.foodPerHead < 1 && s.hunger < 0.5) {
    out.priority = 'PRIORITIZE_FOOD';
    out.reason = `Only ${s.food} food in the stores for ${s.pop} people`;
    out.speech = has('pragmatic') ? 'Bellies first. Everyone gathers until the stores are full.' : has('spiritual') ? 'We are hungry, and we pray. But prayers need hands: everyone gathers.' : 'The stores are nearly empty. Food comes before everything else now.';
    out.mood = 'worried';
    if (faithful && s.hunger < 0.4) out.ask = { kind: 'food', text: 'Our children are hungry. Send us food, Great One.' };
  } else if (s.hostile.length) {
    const h = s.hostile[0]!;
    if (has('merciful') || has('generous') || civ.rep.trust > 0.6) {
      out.priority = 'SEEK_PEACE';
      out.targetCiv = h.name;
      out.reason = `Relations with ${h.name} have turned hostile`;
      out.speech = `There is bad blood with ${h.name}. I will try to mend it before it becomes worse.`;
    } else {
      out.priority = 'PREPARE_DEFENSE';
      out.targetCiv = h.name;
      out.reason = `${h.name} are hostile`;
      out.speech = has('aggressive') ? `${h.name} think we are weak. Let them come; we will be ready.` : `${h.name} mean us harm. We build a watchtower and keep our eyes open.`;
      if (civ.rep.faith > 0.3) out.ask = { kind: 'protection', text: `Protect us from ${h.name}.` };
    }
    out.mood = 'tense';
  } else if (s.needsStone && s.stone < 4) {
    out.priority = 'GATHER_MATERIALS';
    out.reason = 'Their builders are waiting on stone';
    out.speech = 'Our builders stand idle for want of stone. Send people to the rocks.';
  } else if ((focus.expand > 1.15 || has('ambitious')) && s.adults >= 9 && s.prospects > 0 && s.settlements < 3) {
    out.priority = 'ESTABLISH_SETTLEMENT';
    out.reason = 'The people are many and good land has been found';
    out.speech = has('ambitious') ? 'We have outgrown this place. We will found a new village on the land our explorers found.' : 'Some of us will go and settle the good land our explorers found.';
    out.mood = 'ambitious';
    if (faithful) out.ask = { kind: 'blessing', text: 'Bless those who go to found our new home.' };
  } else if (s.unknownRegions.length && (focus.explore > 1.05 || s.prospects === 0 || has('curious'))) {
    out.priority = 'EXPLORE_REGION';
    const r = w.terrain.regions[nearestUnknownRegion(w, civ) ?? -1];
    out.targetRegion = r?.name;
    out.reason = r ? `Nobody has seen ${r.name} yet` : 'There are lands nobody has seen';
    out.speech = has('curious') ? `What lies in ${r?.name ?? 'the far lands'}? I mean to find out.` : `We should know what is out there. Explorers will go toward ${r?.name ?? 'the unknown'}.`;
  } else if (civ.rep.faith > 0.5 && (focus.faith > 1.2 || has('spiritual'))) {
    out.priority = 'HONOR_GOD';
    out.reason = 'The people feel watched over and want to give thanks';
    out.speech = 'The sky has been good to us. We will honour it.';
    out.mood = 'reverent';
  } else if (s.known.length && s.friendly.length === 0 && (has('generous') || focus.social > 1.1)) {
    const other = s.known[0]!;
    out.priority = 'TRADE';
    out.targetCiv = other.name;
    out.reason = `They want to know ${other.name} better`;
    out.speech = `We will send gifts to ${other.name}. Friends are better than strangers.`;
  } else {
    out.priority = focus.build >= 1.05 ? 'PRIORITIZE_BUILDING' : 'REST';
    out.reason = focus.build >= 1.05 ? 'Times are good; they want to build' : 'Times are good';
    out.speech = focus.build >= 1.05 ? 'The seasons are kind. Let us build something that lasts.' : 'We are well. Let the people rest and sing tonight.';
    out.mood = 'content';
  }
  // Ask for a sign now and then if they believe but have heard nothing.
  if (!out.ask && civ.rep.faith > 0.35 && s.lastDivineAgo > 2.5 && (has('spiritual') || civ.def.priorities.faith > 1.2)) {
    out.ask = { kind: 'sign', text: 'Are you still there? Give us a sign.' };
  }
  if (!out.ask && s.hurt.length >= 2 && civ.rep.faith > 0.2) out.ask = { kind: 'heal', text: `${s.hurt.map((a) => a.name).slice(0, 2).join(' and ')} are badly hurt. Heal them.` };
  if (!out.ask && s.fires && civ.rep.faith > 0.2) out.ask = { kind: 'rain', text: 'Fire is burning near our homes. Send rain!' };
  void why;
  out.speech = tone(out.speech, persona);
  return out;
}

function tone(line: string, persona: string[]): string {
  if (persona.includes('proud')) return line.replace(/^We /, 'We, the proud, ');
  return line;
}

// ---------------------------------------------------------------------------
// The leader's periodic review
// ---------------------------------------------------------------------------

/** Pluggable external cognition (set by the leader-mind service in the browser). */
export const leaderHooks: {
  think: ((w: World, civ: Civilization, reason: string) => void) | null;
} = { think: null };

/** Ask for a strategic review soon (major events trigger this). */
export function requestLeaderThought(w: World, civ: Civilization, reason: string): void {
  const pending = (civ.mind as { pending?: string[] }).pending ?? [];
  if (!pending.includes(reason)) pending.push(reason);
  if (pending.length > 5) pending.shift();
  (civ.mind as { pending?: string[] }).pending = pending;
  void w;
}

export function pendingReasons(civ: Civilization): string[] {
  return (civ.mind as { pending?: string[] }).pending ?? [];
}

/** Civ context: occasionally review strategy, and on important events. */
export function leaderUpdate(w: World, civ: Civilization): void {
  const leader = leaderOf(w, civ);
  if (!leader) return;
  const pending = pendingReasons(civ);
  const since = w.time - civ.mind.lastPlan;
  const due = since > DAY_LENGTH * 0.6 || (pending.length > 0 && since > HOUR * 1.5);
  if (!due) return;
  const reason = pending.length ? pending.join('; ') : 'regular council';
  (civ.mind as { pending?: string[] }).pending = [];
  civ.mind.lastPlan = w.time;
  const d = localDecision(w, civ, reason);
  applyDecision(w, civ, d, 'local');
  if (d.priority !== 'NONE' && civ.objectives.length) {
    const o = civ.objectives[civ.objectives.length - 1]!;
    if (o.since === w.worldTime) civHistory(w, civ, `${leader.name} decided: ${o.reason.toLowerCase()}.`, 'objective', 1);
  }
  // Let an external mind refine it asynchronously (if one is connected).
  leaderHooks.think?.(w, civ, reason);
}

/** A readable one-paragraph brief of a people, for UI and for the external model. */
export function civBrief(w: World, civ: Civilization): string {
  const s = assess(w, civ);
  const leader = leaderOf(w, civ);
  const rels = s.known.map((c) => `${c.name}: ${RELATION_LABEL[civ.relation(c.id).state].toLowerCase()}`).join(', ');
  const lm = [...civ.knowledge.landmarks].map((id) => w.terrain.landmarks.find((l) => l.id === id)).filter(Boolean).map((l) => `${l!.name} (${LANDMARK_INFO[l!.kind].title})`);
  return [
    `${civ.name}, the ${civ.people}. ${civ.def.identity}`,
    leader ? `Led by ${leader.name}, ${personaText(leader.persona)} (${leader.persona.map((t) => PERSONAS[t].tone).join('; ')}).` : 'Leaderless.',
    `${s.pop} people in ${s.settlements} settlement(s); the capital is a ${s.era.toLowerCase()}. ${s.food} food stored.`,
    rels ? `Known peoples: ${rels}.` : 'They have met no other people.',
    lm.length ? `Known wonders: ${lm.join(', ')}.` : '',
    `They see their god as ${civ.godView}.`,
  ]
    .filter(Boolean)
    .join(' ');
}

export function homeOf(w: World, civ: Civilization): { x: number; z: number } {
  return campCenter(w, civ.capital?.id ?? -1);
}
