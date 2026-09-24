import type { V2 } from '../core/math';
import type { World } from '../sim/World';
import type { Agent } from '../agents/Agent';
import { DAY_LENGTH } from '../world/config';
import { Civilization, type DivineKind, type GodRequest, type Reputation, type RequestKind } from './Civilization';
import { civHistory, leaderOf, territoryAt } from './civSystem';
import { leaderMemory, requestLeaderThought, say } from './leader';
import { campCenter } from '../sim/settlement';

type RepDelta = Partial<Reputation> & { valence: number };

/** How an act of god lands on the people who experience it. */
const EFFECT: Record<DivineKind, RepDelta> = {
  lightning: { fear: 0.12, awe: 0.05, faith: 0.04, trust: -0.04, anger: 0.03, valence: -0.4 },
  rain: { faith: 0.04, trust: 0.03, valence: 0.3 },
  storm: { fear: 0.06, faith: 0.02, awe: 0.02, valence: -0.2 },
  food: { faith: 0.06, trust: 0.08, awe: 0.03, anger: -0.05, valence: 0.8 },
  forest: { faith: 0.04, awe: 0.05, trust: 0.03, valence: 0.5 },
  heal: { trust: 0.1, faith: 0.08, awe: 0.06, anger: -0.08, valence: 0.9 },
  bless: { faith: 0.06, trust: 0.07, awe: 0.04, anger: -0.04, valence: 0.8 },
  curse: { fear: 0.14, anger: 0.12, trust: -0.14, faith: 0.02, valence: -0.8 },
  meteor: { fear: 0.18, awe: 0.12, anger: 0.06, trust: -0.08, faith: 0.05, valence: -0.6 },
  quake: { fear: 0.15, awe: 0.06, anger: 0.06, trust: -0.08, valence: -0.6 },
  fire: { fear: 0.12, anger: 0.08, trust: -0.08, valence: -0.6 },
  wind: { awe: 0.03, fear: 0.03, valence: -0.05 },
  fog: { awe: 0.04, fear: 0.03, valence: 0 },
  drought: { anger: 0.06, fear: 0.05, trust: -0.05, valence: -0.5 },
  clear: { trust: 0.02, faith: 0.02, valence: 0.2 },
  resurrect: { awe: 0.25, faith: 0.18, trust: 0.12, fear: 0.05, anger: -0.1, valence: 1 },
  spring: { awe: 0.1, faith: 0.08, trust: 0.08, valence: 0.8 },
  fertile: { faith: 0.07, trust: 0.08, awe: 0.05, valence: 0.8 },
  harvest: { faith: 0.08, trust: 0.08, anger: -0.05, valence: 0.9 },
  sanctuary: { trust: 0.08, faith: 0.06, fear: -0.06, valence: 0.7 },
  revelation: { faith: 0.08, awe: 0.1, trust: 0.05, valence: 0.6 },
  knowledge: { faith: 0.06, awe: 0.06, trust: 0.04, valence: 0.5 },
  inspire: { faith: 0.03, awe: 0.02, valence: 0.3 },
  peace: { trust: 0.05, faith: 0.03, valence: 0.3 },
  wrath: { fear: 0.2, faith: 0.06, anger: 0.05, trust: -0.05, valence: -0.7 },
  manifest: { awe: 0.15, faith: 0.1, fear: 0.05, valence: 0.3 },
  teleport: { awe: 0.08, fear: 0.06, valence: 0 },
  timeFreeze: { awe: 0.04, fear: 0.02, valence: 0 },
  timeRush: { awe: 0.04, valence: 0 },
  answered: { trust: 0.15, faith: 0.1, anger: -0.05, valence: 0.9 },
  ignored: { trust: -0.08, faith: -0.05, anger: 0.03, valence: -0.4 },
  refused: { anger: 0.1, trust: -0.06, valence: -0.5 },
  spoke: { awe: 0.05, faith: 0.04, valence: 0.2 },
  landmark: { awe: 0.08, faith: 0.05, valence: 0.4 },
  deposit: { faith: 0.04, trust: 0.04, awe: 0.03, valence: 0.5 },
  raise: { awe: 0.08, fear: 0.04, valence: 0 },
  animal: { faith: 0.02, trust: 0.02, valence: 0.3 },
};

const REQUEST_ANSWERS: Record<RequestKind, DivineKind[]> = {
  rain: ['rain', 'storm'],
  food: ['food', 'harvest', 'fertile', 'bless', 'forest', 'animal'],
  protection: ['sanctuary', 'peace', 'wrath', 'bless'],
  sign: ['manifest', 'spoke', 'rain', 'food', 'bless', 'heal', 'spring', 'landmark', 'revelation', 'harvest', 'fertile', 'forest'],
  heal: ['heal', 'resurrect'],
  blessing: ['bless', 'inspire', 'harvest', 'fertile', 'sanctuary'],
  peace: ['peace'],
  guidance: ['spoke', 'knowledge', 'revelation'],
};

export interface DivineAct {
  kind: DivineKind;
  x: number;
  z: number;
  /** Radius within which people notice it. */
  radius: number;
  text: string;
  /** Specific target (heal/bless person, civ-level powers). */
  agent?: Agent;
  civ?: Civilization;
  /** Consequences, for interpretation. */
  harmed?: number;
  killed?: number;
  damaged?: number;
}

function clampRep(r: Reputation): void {
  for (const k of Object.keys(r) as Array<keyof Reputation>) r[k] = Math.max(0, Math.min(1, r[k]));
}

/**
 * Something the god did. Each people who saw it (or whose land it touched) updates how they feel
 * about their god, remembers it, and may treat it as an answer to a prayer. Acts that hurt their
 * enemies read very differently from acts that hurt them.
 */
export function divineEvent(w: World, act: DivineAct): void {
  const base = EFFECT[act.kind];
  for (const civ of w.civs) {
    if (civ.population === 0) continue;
    const targeted = act.civ === civ || (act.agent && act.agent.civId === civ.id);
    let witnesses = 0;
    let members = 0;
    for (const a of civ.members) {
      if (!a.alive) continue;
      members++;
      if (Math.hypot(a.x - act.x, a.z - act.z) < act.radius + 12) witnesses++;
    }
    const inLand = territoryAt(w, act.x, act.z) === civ.id;
    if (!targeted && !witnesses && !inLand) {
      // Word of acts against enemies travels.
      const victim = territoryAt(w, act.x, act.z);
      const rel = victim >= 0 ? civ.relations.get(victim) : undefined;
      if (base.valence < 0 && rel && (rel.state === 'hostile' || rel.state === 'tense')) {
        const r = civ.rep;
        r.faith += 0.03;
        r.trust += 0.02;
        r.awe += 0.02;
        clampRep(r);
        civ.addDivine({ time: w.worldTime, kind: act.kind, text: `The sky struck our enemies, ${w.civs[victim]!.name}.`, valence: 0.5 });
        leaderMemory(civ, `The god struck our enemies, ${w.civs[victim]!.name}. Perhaps we are favoured.`, 2);
      }
      continue;
    }
    const reach = targeted ? 1 : Math.min(1, 0.35 + (witnesses / Math.max(1, members)) * 0.9 + (inLand ? 0.25 : 0));
    let valence = base.valence;
    const r = civ.rep;
    const hurtThem = (act.harmed ?? 0) + (act.killed ?? 0) * 3 + (act.damaged ?? 0);
    for (const k of ['faith', 'fear', 'trust', 'anger', 'awe'] as const) {
      const d = base[k];
      if (d) r[k] += d * reach;
    }
    if (hurtThem > 0 && base.valence < 0.3) {
      r.anger += 0.04 * Math.min(3, hurtThem) * reach;
      r.trust -= 0.03 * Math.min(3, hurtThem) * reach;
      valence = Math.min(valence, -0.6);
    } else if (base.valence < 0 && !hurtThem) {
      // Frightening, but nobody was hurt: more awe than anger.
      r.anger -= (base.anger ?? 0) * reach * 0.6;
      r.awe += 0.02 * reach;
      valence = Math.max(valence, -0.2);
    }
    clampRep(r);
    civ.addDivine({ time: w.worldTime, kind: act.kind, text: act.text, valence });
    const important = Math.abs(valence) >= 0.6 || act.kind === 'manifest' || act.kind === 'resurrect' || (act.killed ?? 0) > 0;
    if (important) {
      civHistory(w, civ, act.text, 'divine', (act.killed ?? 0) > 0 || act.kind === 'resurrect' || act.kind === 'meteor' ? 3 : 2);
      leaderMemory(civ, act.text, (act.killed ?? 0) > 0 ? 3 : 2);
      requestLeaderThought(w, civ, `divine act: ${act.kind}`);
    }
    // Did this answer something they asked for?
    for (const req of civ.requests) {
      if (req.status !== 'open') continue;
      if (!REQUEST_ANSWERS[req.kind].includes(act.kind)) continue;
      const near = Math.hypot(req.x - act.x, req.z - act.z) < 60 || targeted || inLand;
      if (!near) continue;
      resolveRequest(w, civ, req, 'granted');
    }
    // Helping one people against another sours or warms their feelings for each other.
    if (act.kind === 'peace') for (const [, rel] of civ.relations) if (rel.state !== 'unknown') rel.truceUntil = Math.max(rel.truceUntil, w.worldTime + DAY_LENGTH * 2);
  }
}

/** The watcher answered, was ignored, or refused. */
export function resolveRequest(w: World, civ: Civilization, req: GodRequest, status: 'granted' | 'ignored' | 'refused'): void {
  if (req.status !== 'open') return;
  req.status = status;
  const r = civ.rep;
  const d = EFFECT[status === 'granted' ? 'answered' : status];
  for (const k of ['faith', 'fear', 'trust', 'anger', 'awe'] as const) if (d[k]) r[k] += d[k]!;
  clampRep(r);
  const leader = leaderOf(w, civ);
  const text =
    status === 'granted'
      ? `The watcher answered our prayer: ${req.text.replace(/^[A-Z]/, (c) => c.toLowerCase())}`
      : status === 'refused'
        ? `We asked the sky for help, and it refused us.`
        : `We asked the sky for help, and nothing came.`;
  civ.addDivine({ time: w.worldTime, kind: status === 'granted' ? 'answered' : status, text, valence: d.valence });
  civHistory(w, civ, status === 'granted' ? `Their prayer was answered (${req.kind}).` : status === 'refused' ? `The god refused their plea for ${req.kind}.` : `Their plea for ${req.kind} went unanswered.`, 'divine', status === 'granted' ? 2 : 1);
  leaderMemory(civ, text, status === 'granted' ? 3 : 2);
  if (leader) {
    const line =
      status === 'granted'
        ? pick(civ, ['You heard us. We will not forget this.', 'Thank you, Great One. The people saw it with their own eyes.', 'Our prayer was answered! Tonight we sing for you.'])
        : status === 'refused'
          ? pick(civ, ['So be it. We will manage without you.', 'You refuse us? Then we will remember that too.', 'I will tell the people the sky has turned its face away.'])
          : pick(civ, ['We called and nobody came. Some are saying there is no one up there at all.', 'The sky stayed silent. I do not know what to tell them.']);
    say(w, civ, line, status === 'granted' ? 'grateful' : 'bitter');
  }
  w.log(`${civ.name}: ${status === 'granted' ? 'prayer answered' : status === 'refused' ? 'the god refused them' : 'a prayer went unanswered'}.`, status === 'granted' ? 'divine' : 'warning', 2, req);
}

function pick(civ: Civilization, lines: string[]): string {
  return lines[(civ.id * 7 + civ.divine.length) % lines.length]!;
}

/** Ask the god for something (leaders do this when it makes sense). */
export function openRequest(w: World, civ: Civilization, kind: RequestKind, text: string, by: Agent, at?: V2): GodRequest | null {
  if (civ.requests.some((r) => r.status === 'open' && r.kind === kind)) return null;
  const p = at ?? campCenter(w, by.settlementId);
  const req: GodRequest = { id: w.nextId(), kind, text, by: by.id, time: w.worldTime, expires: w.worldTime + DAY_LENGTH * 0.75, status: 'open', x: p.x, z: p.z };
  civ.requests.push(req);
  if (civ.requests.length > 12) civ.requests.shift();
  w.log(`${by.name} of ${civ.name} prays: "${text}"`, 'divine', 3, p, by.id);
  w.events.emit('civEvent', { civId: civ.id, kind: 'request', text, x: p.x, z: p.z });
  civHistory(w, civ, `${by.name} prayed to the sky: "${text}"`, 'divine', 1);
  return req;
}

let driftT = 0;

/** Slow drift of feelings and the expiry of unanswered prayers (world context). */
export function divineUpdate(w: World, dt: number): void {
  driftT += dt;
  if (driftT < 2) return;
  const step = driftT;
  driftT = 0;
  const day = step / DAY_LENGTH;
  for (const civ of w.civs) {
    const r = civ.rep;
    const faithRest = 0.08 + civ.def.priorities.faith * 0.06;
    r.faith += (faithRest - r.faith) * day * 0.25;
    r.fear += (0 - r.fear) * day * 0.5;
    r.anger += (0 - r.anger) * day * 0.35;
    r.awe += (0.05 - r.awe) * day * 0.4;
    r.trust += (0.25 - r.trust) * day * 0.08;
    clampRep(r);
    for (const req of civ.requests) if (req.status === 'open' && req.expires < w.worldTime) resolveRequest(w, civ, req, 'ignored');
    civ.godView = godView(civ);
    // Individual faith follows the people's mood a little.
    for (const a of civ.members) if (a.alive && a.faith < r.faith * 0.8) a.faith += (r.faith * 0.8 - a.faith) * day * 0.5;
  }
}

/** A short phrase for how a people see their god, drawn from what they have lived through. */
export function godView(civ: Civilization): string {
  const r = civ.rep;
  const recent = civ.divine.slice(-12);
  const rainy = recent.filter((d) => d.kind === 'rain' || d.kind === 'answered').length;
  const strikes = recent.filter((d) => d.kind === 'lightning' || d.kind === 'meteor' || d.kind === 'quake' || d.kind === 'curse' || d.kind === 'fire').length;
  const gifts = recent.filter((d) => d.valence > 0.5).length;
  const name = civ.def.godName;
  if (r.anger > 0.6 && r.trust < 0.25) return `${name}, a cruel power they resent`;
  if (r.fear > 0.55 && strikes >= 2) return `${name}, an angry sky that must be appeased`;
  if (r.faith > 0.55 && r.trust > 0.5 && rainy >= 2) return `${name}, the rain-giver who answers prayers`;
  if (r.faith > 0.55 && r.trust > 0.5) return `${name}, a generous provider`;
  if (r.awe > 0.55) return `${name}, a power beyond understanding`;
  if (gifts >= 2 && strikes >= 2) return `${name}, who gives and takes in equal measure`;
  if (r.faith < 0.12 && recent.length === 0) return 'a story for children; maybe no one is up there';
  if (r.fear > 0.4) return `${name}, whose moods are feared`;
  if (r.faith > 0.35) return `${name}, who watches over them`;
  return 'a distant, silent watcher';
}
