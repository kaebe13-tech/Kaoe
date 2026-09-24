import type { World } from '../sim/World';
import type { Agent } from '../agents/Agent';
import type { Region } from '../world/biomes';
import { DAY_LENGTH } from '../world/config';
import { TRAITS } from '../agents/traits';
import { Civilization, RELATION_LABEL, type ObjectiveKind, type RequestKind } from './Civilization';
import { PERSONAS, personaText } from './persona';
import { civHistory, leaderOf, setObjective } from './civSystem';
import { assess, leaderMemory } from './leader';
import { divineEvent, promisesOf } from './divine';
import { civFood } from '../sim/settlement';
import { activityText, mood as moodOf } from '../ui/agentInfo';

// ---------------------------------------------------------------------------
// Understanding what the god said
// ---------------------------------------------------------------------------

export type Intent = 'QUESTION' | 'COMMAND' | 'PROMISE' | 'THREAT' | 'BLESSING' | 'GENERAL';

export type Topic = 'food' | 'home' | 'god' | 'people' | 'feelings' | 'plans' | 'others' | 'place' | 'leader' | 'family' | 'work' | 'past' | 'name' | 'needs' | 'none';

export interface Parsed {
  intent: Intent;
  text: string;
  /** What a command asks for, when it maps to something the people can do. */
  objective?: ObjectiveKind;
  /** The words of a command that asked for war (there is no war in this world). */
  war?: boolean;
  region?: Region;
  civ?: Civilization;
  /** What a promise (or threat) is about. */
  promise?: RequestKind;
  topic: Topic;
  /** A command or promise wrapped in a threat ("... or I will burn you"). */
  coerced?: boolean;
}

const has = (t: string, words: RegExp) => words.test(t);

const THREAT = /\b(or else|or i will|or i'll|or you will|i will (destroy|burn|punish|curse|smite|strike|crush|drown|kill|end)|i'll (destroy|burn|punish|curse|smite|strike|crush|drown|kill|end)|you will (suffer|burn|die|regret|pay)|fear me|tremble|beware|feel my wrath|my wrath|obey or|doom|i will make you)\b/;
const PROMISE = /\b(i (will|shall|'ll) (send|give|bring|protect|heal|guard|save|feed|help|make it rain|bless|keep)|i promise|i swear|you (will|shall) (have|receive|get) |i give you my word|trust me)\b/;
const BLESS = /^(bless|i bless|blessed|may you|be well|be at peace|go in peace|i love|i am proud|i'm proud|well done|you have done well|thank you|thanks|good work|you are doing well|peace be)/;
const QUESTION_START = /^(who|what|where|why|how|when|which|whose|do|does|did|are|is|am|can|could|will|would|should|have|has|tell me|explain)\b/;
const COMMAND_CUE = /^(build|make|explore|go|find|gather|collect|harvest|hunt|farm|plant|grow|mine|chop|cut|settle|found|expand|spread|move|migrate|leave|abandon|flee|seek|trade|befriend|avoid|stay|keep|defend|prepare|guard|fortify|attack|fight|raid|destroy|kill|war|pray|worship|honou?r|kneel|bow|sacrifice|rest|sleep|celebrate|feast|sing|dance|stop|send|bring|obey|cease|return|come|scout|search|look for|dig|forgive|reconcile|share|help|feed|heal)\b/;
const COMMAND_PHRASE = /\b(you must|you shall|you will|i command|i order|i want you to|i demand|i decree|i wish you to|it is my will|go and|you should|you need to)\b/;

function topicOf(t: string): Topic {
  if (/\b(food|hungry|hunger|eat|berries|fruit|harvest|starv)/.test(t)) return 'food';
  if (/\b(home|house|hut|village|town|build|built|shelter)/.test(t)) return 'home';
  if (/\b(me|god|gods|sky|watcher|divine|pray|believe|faith)\b/.test(t)) return 'god';
  if (/\b(leader|chief|lead|rules?|king|queen|elder)\b/.test(t)) return 'leader';
  if (/\b(family|child|children|kids?|mother|father|parents?|partner|wife|husband|son|daughter)\b/.test(t)) return 'family';
  if (/\b(other|others|strangers|neighbou?rs|peoples?|tribes?|enem(y|ies)|friends?)\b/.test(t)) return 'others';
  if (/\b(plan|plans|want|wish|goal|next|future|going to|intend)\b/.test(t)) return 'plans';
  if (/\b(feel|feeling|happy|sad|afraid|scared|okay|ok|well|how are you|mood)\b/.test(t)) return 'feelings';
  if (/\b(where|land|place|region|live|world|map)\b/.test(t)) return 'place';
  if (/\b(doing|work|job|busy)\b/.test(t)) return 'work';
  if (/\b(remember|past|history|before|happened|story)\b/.test(t)) return 'past';
  if (/\b(name|who are you|who is)\b/.test(t)) return 'name';
  if (/\b(need|lack|missing|help you)\b/.test(t)) return 'needs';
  return 'none';
}

function promiseKind(t: string): RequestKind {
  if (/\b(rain|water|storm|clouds?)\b/.test(t)) return 'rain';
  if (/\b(food|fruit|berries|harvest|feed|hunger|eat)\b/.test(t)) return 'food';
  if (/\b(protect|guard|safe|shield|save you)\b/.test(t)) return 'protection';
  if (/\b(heal|cure|mend|sick|hurt)\b/.test(t)) return 'heal';
  if (/\b(peace)\b/.test(t)) return 'peace';
  if (/\b(bless|blessing)\b/.test(t)) return 'blessing';
  if (/\b(sign|show myself|appear|come down)\b/.test(t)) return 'sign';
  return 'guidance';
}

function findRegion(w: World, t: string): Region | undefined {
  let best: Region | undefined;
  for (const r of w.terrain.regions) {
    const n = r.name.toLowerCase().replace(/^the /, '');
    if (n.length >= 3 && t.includes(n)) {
      if (!best || n.length > best.name.length) best = r;
    }
  }
  if (best) return best;
  // Biome words ("the ash lands", "the forest") point at the nearest region of that kind.
  const biomeWord: Array<[RegExp, string]> = [
    [/\b(ash|ashen|volcan|burnt)/, 'ash'],
    [/\b(crystal|glass|shining)/, 'crystal'],
    [/\b(high|mountain|peak|stone)/, 'high'],
    [/\b(forest|wood|trees)/, 'wood'],
    [/\b(isle|island)/, 'isle'],
  ];
  for (const [re, key] of biomeWord) if (re.test(t)) return w.terrain.regions.find((r) => r.name.toLowerCase().includes(key));
  return undefined;
}

function findCiv(w: World, self: Civilization | undefined, t: string): Civilization | undefined {
  for (const c of w.civs) {
    if (c === self) continue;
    const n = c.name.toLowerCase().replace(/^the /, '');
    const p = c.people.toLowerCase().replace(/^the /, '');
    if (t.includes(n) || t.includes(p) || (p.endsWith('s') && t.includes(p.slice(0, -1)))) return c;
  }
  // "the others", "your neighbours", "the strangers" -> the one they know best.
  if (self && /\b(neighbou?rs?|strangers|the others|other people|enemies|enemy)\b/.test(t)) {
    const known = [...self.relations.values()].filter((r) => r.state !== 'unknown').sort((a, b) => a.opinion - b.opinion);
    if (known.length) return w.civs[known[0]!.civId];
  }
  return undefined;
}

function commandObjective(t: string): { objective?: ObjectiveKind; war?: boolean } {
  if (/\b(war|attack|fight|raid|kill|destroy|conquer|burn their|slaughter|invade)\b/.test(t)) return { objective: 'PREPARE_DEFENSE', war: true };
  if (/\b(peace|reconcile|forgive|make up|mend|apolog)/.test(t)) return { objective: 'SEEK_PEACE' };
  if (/\b(trade|gift|befriend|friends? with|share with|welcome)/.test(t)) return { objective: 'TRADE' };
  if (/\b(avoid|stay away|keep away|keep clear|do not go near|don't go near|hide from)/.test(t)) return { objective: 'AVOID_CIVILIZATION' };
  if (/\b(defend|guard|fortify|watchtower|tower|walls?|prepare|arm yourselves|be ready)/.test(t)) return { objective: 'PREPARE_DEFENSE' };
  if (/\b(shrine|temple|altar|pray|worship|honou?r|kneel|bow|sacrifice|monument to me|praise)/.test(t)) return { objective: 'HONOR_GOD' };
  if (/\b(migrate|move (away|on|your people|everyone)|leave (this|your)|abandon|flee|new home for all)/.test(t)) return { objective: 'MIGRATE' };
  if (/\b(settle|found|new (village|settlement|town|camp)|colon|expand|spread|grow your (people|land|lands))/.test(t)) return { objective: 'ESTABLISH_SETTLEMENT' };
  if (/\b(explore|scout|discover|search|find|go to|travel|journey|look for|see the)/.test(t)) return { objective: 'EXPLORE_REGION' };
  if (/\b(food|eat|harvest|gather|berries|fruit|hunt|farm|plant|garden|store|feed)/.test(t)) return { objective: 'PRIORITIZE_FOOD' };
  if (/\b(wood|stone|crystal|materials|mine|quarry|chop|timber|logs)/.test(t)) return { objective: 'GATHER_MATERIALS' };
  if (/\b(build|construct|houses?|homes?|huts?|hall|workshop|make (a|more)|raise)/.test(t)) return { objective: 'PRIORITIZE_BUILDING' };
  if (/\b(rest|sleep|celebrate|feast|sing|dance|relax|enjoy|stop working)/.test(t)) return { objective: 'REST' };
  return {};
}

/** Classify what the god said. Deterministic and local: the model never decides this. */
export function classifyIntent(w: World, text: string, civ?: Civilization): Parsed {
  const raw = text.trim();
  const t = raw.toLowerCase().replace(/[’']/g, "'");
  const topic = topicOf(t);
  const out: Parsed = { intent: 'GENERAL', text: raw, topic };
  const cmd = commandObjective(t);
  const commandy = COMMAND_CUE.test(t) || COMMAND_PHRASE.test(t) || /^(now|you|all of you|people of)\b.*\b(must|shall|will)\b/.test(t);
  const question = t.endsWith('?') || (QUESTION_START.test(t) && !COMMAND_PHRASE.test(t));
  if (has(t, THREAT)) {
    out.intent = 'THREAT';
    out.promise = promiseKind(t);
    if (cmd.objective && commandy) {
      out.objective = cmd.objective;
      out.war = cmd.war;
      out.coerced = true;
    }
  } else if (has(t, PROMISE) && !question) {
    out.intent = 'PROMISE';
    out.promise = promiseKind(t);
  } else if (question) {
    out.intent = 'QUESTION';
  } else if (BLESS.test(t) && !commandy) {
    out.intent = 'BLESSING';
  } else if (commandy || cmd.objective) {
    out.intent = 'COMMAND';
    out.objective = cmd.objective;
    out.war = cmd.war;
  }
  if (out.objective || out.intent === 'QUESTION') {
    out.region = findRegion(w, t);
    out.civ = findCiv(w, civ, t);
    if (out.objective === 'EXPLORE_REGION' && !out.region && out.civ) out.objective = 'TRADE';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Will they do it?
// ---------------------------------------------------------------------------

export interface Verdict {
  intent: Intent;
  accept: boolean;
  /** Plain explanation (also given to the model so its words agree). */
  reason: string;
  objective?: ObjectiveKind;
}

/**
 * Does the leader obey a command? Deterministic: faith, fear, trust, awe and anger toward the
 * god, the leader's personality, whether it can be done at all, and whether it goes against what
 * the people need right now.
 */
export function judgeCommand(w: World, civ: Civilization, leader: Agent | undefined, p: Parsed): Verdict {
  const intent = p.intent;
  if (!p.objective) return { intent, accept: false, reason: 'they could not understand what the voice wants from them' };
  const s = assess(w, civ);
  const r = civ.rep;
  const persona = leader?.persona ?? [];
  let will = r.faith * 0.9 + r.fear * (p.coerced ? 1.2 : 0.8) + r.trust * 0.6 + r.awe * 0.45 - r.anger * 0.9;
  for (const t of persona) will += PERSONAS[t].obedience;
  const obeyedBefore = civ.mind.commands.filter((c) => c.accepted).length;
  will += Math.min(0.15, obeyedBefore * 0.03);
  let need = 0.42;
  let reason = '';
  const name = leader?.name ?? 'The elders';
  const k = p.objective;
  // Can it be done at all?
  if (k === 'SEEK_PEACE' || k === 'TRADE' || k === 'AVOID_CIVILIZATION' || (k === 'PREPARE_DEFENSE' && p.war)) {
    if (!p.civ && k !== 'PREPARE_DEFENSE') return { intent, accept: false, reason: 'the voice named no people they know', objective: k };
    if (p.civ && !civ.knows(p.civ.id)) return { intent, accept: false, reason: `they have never met ${p.civ.name} and do not know where they live`, objective: k };
  }
  if (k === 'ESTABLISH_SETTLEMENT' || k === 'EXPAND') {
    if (s.adults < 6) return { intent, accept: false, reason: `there are too few of them (${s.adults} grown) to found another village`, objective: k };
    if (civ.settlements.length >= 4) return { intent, accept: false, reason: 'they already hold all the villages they can', objective: k };
    if (!civ.knowledge.prospects.length) need += 0.05;
  }
  if (k === 'EXPLORE_REGION') {
    if (p.region && civ.knowledge.regions.has(p.region.id)) need -= 0.05;
    if (!s.unknownRegions.length && !p.region) return { intent, accept: false, reason: 'they have already walked every land they know of', objective: k };
  }
  // How much it asks of them.
  if (k === 'MIGRATE') need += 0.3;
  if (p.war) {
    need += 0.25;
    if (persona.includes('aggressive') || persona.includes('proud')) need -= 0.2;
    if (persona.includes('merciful') || persona.includes('generous')) need += 0.3;
    if (civ.relation(p.civ?.id ?? -1).state === 'friendly') need += 0.2;
  }
  if (k === 'SEEK_PEACE' || k === 'TRADE') {
    if (persona.includes('merciful') || persona.includes('generous')) need -= 0.15;
    if (persona.includes('aggressive') || persona.includes('paranoid')) need += 0.15;
    if (civ.relation(p.civ?.id ?? -1).state === 'hostile') need += 0.1;
  }
  if (k === 'HONOR_GOD') {
    need -= 0.1;
    if (persona.includes('spiritual')) need -= 0.15;
    if (persona.includes('pragmatic') && s.foodPerHead < 1.5) need += 0.2;
  }
  if (k === 'PRIORITIZE_FOOD') need -= s.foodPerHead < 2 ? 0.25 : 0.05;
  if (k === 'REST' && (s.foodPerHead < 1 || s.hunger < 0.45)) {
    return { intent, accept: false, reason: `their children are hungry; ${name} will not let the people rest`, objective: k };
  }
  if (k === 'EXPLORE_REGION' && persona.includes('curious')) need -= 0.15;
  if (k === 'EXPLORE_REGION' && persona.includes('cautious')) need += 0.1;
  const accept = will >= need;
  if (accept) {
    reason =
      r.fear > 0.45 && r.fear >= r.faith
        ? 'they are afraid of what the sky might do if they refuse'
        : r.faith > 0.45
          ? 'they believe in the voice and want to please it'
          : r.trust > 0.4
            ? 'the voice has been good to them, and they trust it'
            : 'it seems wise enough, and nobody dares to argue with the sky';
  } else {
    reason =
      r.anger > 0.4
        ? 'they are angry with the sky for what it has done to them'
        : persona.includes('proud')
          ? `${name} is proud and bows to no one`
          : p.war
            ? 'they have no wish for bloodshed'
            : r.faith < 0.15
              ? 'they barely believe anyone is up there'
              : k === 'MIGRATE'
                ? 'leaving their homes is too much to ask'
                : 'it does not seem right for the people just now';
  }
  return { intent, accept, reason, objective: k };
}

// ---------------------------------------------------------------------------
// Consequences of the god's words
// ---------------------------------------------------------------------------

/**
 * The god spoke to a people (through their leader). Apply the simulation side: reputation,
 * memory, objectives. Returns the verdict for commands.
 */
export function godSpeaks(w: World, civ: Civilization, p: Parsed, via: Agent | undefined): Verdict {
  const leader = leaderOf(w, civ);
  const quote = p.text.length > 90 ? `${p.text.slice(0, 88)}…` : p.text;
  let verdict: Verdict = { intent: p.intent, accept: true, reason: '' };
  const where = via ?? leader;
  // Hearing a voice from the sky at all is remarkable.
  divineEvent(w, { kind: 'spoke', x: where?.x ?? civ.home.x, z: where?.z ?? civ.home.z, radius: 6, text: `A voice spoke from the sky to ${where?.name ?? 'the people'}: "${quote}"`, civ });
  const r = civ.rep;
  const clamp = () => {
    for (const k of Object.keys(r) as Array<keyof typeof r>) r[k] = Math.max(0, Math.min(1, r[k]));
  };
  switch (p.intent) {
    case 'COMMAND':
    case 'THREAT': {
      if (p.intent === 'THREAT') {
        r.fear += 0.1;
        r.anger += 0.05;
        r.trust -= 0.05;
        clamp();
        leaderMemory(civ, `The voice threatened us: "${quote}"`, 3);
        civHistory(w, civ, `The god threatened the ${civ.people}.`, 'divine', 2);
      }
      if (p.objective) {
        verdict = judgeCommand(w, civ, leader, p);
        civ.mind.commands.push({ time: w.worldTime, text: quote, accepted: verdict.accept });
        if (civ.mind.commands.length > 12) civ.mind.commands.shift();
        if (verdict.accept) {
          const target = p.region ? { x: p.region.x, z: p.region.z } : p.civ?.capital ? { x: p.civ.capital.x, z: p.civ.capital.z } : undefined;
          setObjective(w, civ, {
            kind: p.objective,
            reason: `The god commanded: "${quote}"`,
            source: 'god',
            target: p.objective === 'ESTABLISH_SETTLEMENT' || p.objective === 'MIGRATE' ? civ.knowledge.prospects[0] ?? target : target,
            region: p.region?.id,
            civ: p.civ?.id,
            until: w.worldTime + DAY_LENGTH * 2.5,
          });
          civHistory(w, civ, `${leader?.name ?? 'The people'} obeyed the god's command: "${quote}"`, 'objective', 2);
          leaderMemory(civ, `The voice commanded "${quote}" and we obeyed, because ${verdict.reason}.`, 3);
          w.log(`${civ.name} will obey: "${quote}"`, 'divine', 2, where ?? civ.home, where?.id);
        } else {
          civHistory(w, civ, `${leader?.name ?? 'The people'} refused the god's command: "${quote}"`, 'divine', 2);
          leaderMemory(civ, `The voice commanded "${quote}" and I refused, because ${verdict.reason}.`, 3);
          w.log(`${civ.name} refused the god: "${quote}"`, 'warning', 2, where ?? civ.home, where?.id);
        }
      } else if (p.intent === 'COMMAND') {
        verdict = { intent: p.intent, accept: false, reason: 'they could not understand what the voice wants from them' };
      }
      break;
    }
    case 'PROMISE': {
      const kind = p.promise ?? 'guidance';
      const list = promisesOf(civ);
      if (!list.some((x) => x.status === 'open' && x.kind === kind)) {
        list.push({ kind, text: quote, time: w.worldTime, until: w.worldTime + DAY_LENGTH, status: 'open' });
        if (list.length > 8) list.shift();
      }
      r.trust += 0.03;
      r.faith += 0.02;
      clamp();
      leaderMemory(civ, `The voice promised: "${quote}"`, 2);
      break;
    }
    case 'BLESSING': {
      r.faith += 0.03;
      r.trust += 0.03;
      r.anger = Math.max(0, r.anger - 0.03);
      clamp();
      leaderMemory(civ, `The voice blessed us: "${quote}"`, 2);
      for (const a of civ.members) if (a.alive) a.needs.social = Math.min(1, a.needs.social + 0.05);
      break;
    }
    default:
      leaderMemory(civ, `The voice said: "${quote}"`, 1);
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// Local voices (used when no language model is connected, and as fallback)
// ---------------------------------------------------------------------------

function pickLine(seed: number, lines: string[]): string {
  return lines[Math.abs(seed) % lines.length]!;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const OBJ_WORDS: Record<ObjectiveKind, string> = {
  EXPAND: 'spread into new land',
  ESTABLISH_SETTLEMENT: 'found a new village',
  EXPLORE_REGION: 'send explorers out',
  PRIORITIZE_FOOD: 'fill the stores with food',
  PRIORITIZE_BUILDING: 'build',
  GATHER_MATERIALS: 'gather wood and stone',
  MIGRATE: 'leave for new land',
  SEEK_PEACE: 'make peace',
  AVOID_CIVILIZATION: 'keep our distance',
  TRADE: 'bring gifts',
  PREPARE_DEFENSE: 'make ready to defend ourselves',
  HONOR_GOD: 'honour you',
  REST: 'rest',
};

export interface LocalReply {
  speech: string;
  mood: string;
}

/** A leader answers the god in their own voice, from what is true in the world right now. */
export function leaderReply(w: World, civ: Civilization, leader: Agent | undefined, p: Parsed, v: Verdict): LocalReply {
  const s = assess(w, civ);
  const r = civ.rep;
  const persona = leader?.persona ?? [];
  const seed = hash(p.text) + civ.id * 7 + civ.mind.commands.length;
  const god = civ.def.godName.replace(/^the /, 'the ');
  const address = r.fear > 0.5 ? 'Mighty one' : r.faith > 0.5 ? 'Great One' : r.anger > 0.5 ? 'Sky' : r.faith < 0.15 ? 'Voice' : `${god[0]!.toUpperCase()}${god.slice(1)}`;
  const proud = persona.includes('proud');
  const blunt = persona.includes('pragmatic');
  const poetic = persona.includes('spiritual');
  let speech = '';
  let mood = civ.mind.mood || 'calm';
  const planText = civ.objectives.length ? OBJ_WORDS[civ.objectives[civ.objectives.length - 1]!.kind] : 'keep the people fed and safe';
  switch (p.intent) {
    case 'COMMAND':
    case 'THREAT': {
      if (!p.objective) {
        speech = p.intent === 'THREAT'
          ? pickLine(seed, [`${address}, we hear your anger. Tell us what you want of us.`, `${address}... why do you threaten us? What have we done?`, 'Your words chill the people. What would you have us do?'])
          : pickLine(seed, [`${address}, I do not understand what you ask of us.`, 'Your words are strange to us. Speak plainly, and we will listen.', 'I hear you, but I cannot tell what you want.']);
        mood = p.intent === 'THREAT' ? 'afraid' : 'curious';
        break;
      }
      const what = p.war ? `take up spears against ${p.civ?.name ?? 'them'}` : OBJ_WORDS[p.objective] + (p.region ? ` toward ${p.region.name}` : p.civ && p.objective !== 'PREPARE_DEFENSE' ? ` with ${p.civ.name}` : '');
      if (v.accept) {
        speech = proud
          ? pickLine(seed, [`Very well. We will ${what}, and do it well.`, `It will be done. Not because we must, but because it is wise.`])
          : blunt
            ? pickLine(seed, [`Fine. We ${what}. Starting now.`, `Understood. I'll put people on it: we ${what}.`])
            : poetic
              ? pickLine(seed, [`Your will is the wind at our backs. We will ${what}.`, `${address}, we hear you. We will ${what}, and sing your name as we go.`])
              : pickLine(seed, [`${address}, it will be done. We will ${what}.`, `Yes, ${address.toLowerCase()}. The people will ${what}.`, `As you say. We will ${what}.`]);
        if (p.war) speech += ' But we will not strike first.';
        mood = r.fear > r.faith ? 'afraid' : 'reverent';
      } else {
        const why = v.reason;
        speech = proud
          ? pickLine(seed, [`No. ${cap(why)}. We will not ${what}.`, `You ask us to ${what}? No. ${cap(why)}.`])
          : r.fear > 0.5
            ? pickLine(seed, [`Forgive me, ${address.toLowerCase()}... we cannot ${what}. ${cap(why)}.`, `Please do not be angry. We cannot ${what}: ${why}.`])
            : pickLine(seed, [`I hear you, but we will not ${what}. ${cap(why)}.`, `${address}, I must refuse. ${cap(why)}.`, `We cannot ${what}. ${cap(why)}.`]);
        mood = proud || r.anger > 0.4 ? 'defiant' : 'worried';
      }
      break;
    }
    case 'PROMISE':
      speech = r.trust > 0.5
        ? pickLine(seed, [`Then we will wait for it, ${address.toLowerCase()}. You have not failed us before.`, 'Your word is enough for us. Thank you.'])
        : r.trust < 0.2
          ? pickLine(seed, ['Words from the sky are cheap. We will believe it when we see it.', 'You have promised before. We will see.'])
          : pickLine(seed, [`We will hold you to that, ${address.toLowerCase()}.`, 'If you do this, the people will never forget it.', 'Then we will watch the sky.']);
      mood = r.trust > 0.5 ? 'hopeful' : 'tense';
      break;
    case 'BLESSING':
      speech = r.anger > 0.5
        ? pickLine(seed, ['Kind words, after all you have done to us?', 'Blessings are easy to give from up there.'])
        : poetic
          ? pickLine(seed, ['Your blessing warms us like the first sun of spring.', 'We feel it. The whole camp feels it.'])
          : pickLine(seed, ['Thank you. The people will be glad to hear it.', 'We are grateful. We will do our best to deserve it.', 'Your words lift us.']);
      mood = r.anger > 0.5 ? 'bitter' : 'grateful';
      break;
    case 'QUESTION':
      speech = answerQuestion(w, civ, leader, p, s);
      mood = s.foodPerHead < 1 ? 'worried' : civ.mind.mood || 'calm';
      break;
    default: {
      const state = s.foodPerHead < 1 ? `Our stores are nearly empty and the people are hungry.` : s.hostile.length ? `${s.hostile[0]!.name} mean us harm.` : `Right now we ${planText}.`;
      speech = r.faith < 0.15
        ? pickLine(seed, [`Who... who is speaking? ${state}`, `A voice from nowhere. I must be tired. ${state}`])
        : pickLine(seed, [`We hear you, ${address.toLowerCase()}. ${state}`, `${address}. ${state}`, `You are with us, then. ${state}`]);
      mood = r.faith < 0.15 ? 'curious' : civ.mind.mood || 'calm';
    }
  }
  return { speech, mood };
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function answerQuestion(w: World, civ: Civilization, leader: Agent | undefined, p: Parsed, s: ReturnType<typeof assess>): string {
  const t = p.text.toLowerCase();
  const name = leader?.name ?? 'I';
  switch (p.topic) {
    case 'food':
      return s.foodPerHead < 1 ? `Badly. There are only ${s.food} portions in the stores for ${s.pop} mouths.` : s.foodPerHead < 3 ? `We get by. ${s.food} portions stored, but winter would hurt.` : `Well, thanks to the land. The stores hold ${s.food} portions.`;
    case 'home':
      return `We are ${s.pop} people in ${s.settlements === 1 ? 'one' : s.settlements} ${s.settlements === 1 ? 'settlement' : 'settlements'}. Our home is a ${s.era.toLowerCase()} now.`;
    case 'god':
      return `The people say you are ${civ.godView}. ${civ.rep.anger > 0.4 ? 'Many are angry with you.' : civ.rep.fear > 0.4 ? 'Many fear you.' : civ.rep.faith > 0.4 ? 'Most pray to you each night.' : 'Some doubt you exist at all.'}`;
    case 'leader':
      return leader ? `I lead them: ${name}, ${personaText(leader.persona)}. ${civ.leaders.length > 1 ? `Before me, ${civ.leaders[civ.leaders.length - 2]!.name} led us.` : 'I was the first they chose.'}` : 'We have no leader right now.';
    case 'others': {
      if (p.civ) {
        const rel = civ.relation(p.civ.id);
        return rel.state === 'unknown' ? `${p.civ.name}? We have never met them.` : `${p.civ.name}, the ${p.civ.people}. We are ${RELATION_LABEL[rel.state].toLowerCase()} with them.`;
      }
      if (!s.known.length) return 'We have met no one. Sometimes we see smoke far away and wonder.';
      return `We know ${s.known.map((c) => `${c.name} (${RELATION_LABEL[civ.relation(c.id).state].toLowerCase()})`).join(', ')}.`;
    }
    case 'plans': {
      const o = civ.objectives[civ.objectives.length - 1];
      return o ? `We mean to ${OBJ_WORDS[o.kind]}. ${o.reason}.` : 'Nothing grand. Keep the fires lit and the children fed.';
    }
    case 'feelings':
      return s.hunger < 0.45 ? 'Tired and hungry, if I am honest.' : s.hostile.length ? `Uneasy. ${s.hostile[0]!.name} watch us.` : 'Well enough. The people are in good spirits.';
    case 'place': {
      const home = civ.capital;
      const region = home ? w.terrain.regionAt(home.x, home.z) : null;
      return `We live in ${region?.name ?? 'the wilds'}. Our explorers have seen ${civ.knowledge.regions.size} of the lands of this world.`;
    }
    case 'past': {
      const h = civ.history.filter((e) => e.importance >= 2).slice(-2);
      return h.length ? `I remember: ${h.map((e) => e.text.replace(/\.$/, '')).join('. And ')}.` : 'We are a young people. Our story has barely begun.';
    }
    case 'name':
      return `I am ${name}, and we are ${civ.name}, the ${civ.people}. ${civ.def.identity}`;
    case 'needs':
      return s.foodPerHead < 1 ? 'Food. Above all, food.' : s.needsStone ? 'Stone for our builders.' : s.hurt.length ? `Healing, for ${s.hurt[0]!.name}.` : s.unknownRegions.length ? 'To know what lies beyond the hills.' : 'Only that you keep watching over us.';
    default:
      if (/\bwhy\b/.test(t)) return 'Because it is how we have always lived, and how we mean to go on.';
      return `${cap(civ.def.identity.split('.')[0]!.toLowerCase())}. That is who we are.`;
  }
}

/** An ordinary villager hears the voice. They cannot command the people, but they have a life. */
export function villagerReply(w: World, a: Agent, p: Parsed): LocalReply {
  const civ = w.civOf(a);
  const leader = civ ? leaderOf(w, civ) : undefined;
  const seed = hash(p.text) + a.id * 13;
  const m = moodOf(a).text.toLowerCase();
  const act = activityText(a).text.toLowerCase().replace(/\.+$/, '');
  const believer = a.faith > 0.4;
  const doubter = a.faith < 0.12;
  const hello = believer ? pickLine(seed, ['Great One! You speak to me?', 'Is it... is it really you?', 'I knew you were there!']) : doubter ? pickLine(seed, ['W-who said that?', 'Is someone there?', 'I must be hearing things...']) : pickLine(seed, ['A voice... from the sky?', 'Oh! You startled me.', 'I hear you.']);
  if (a.isChild) {
    const kid = pickLine(seed, ['Are you a sky spirit? Can you fly? Can I fly?', 'Mama says you live in the clouds!', 'Do you see everything? Even when I hide?']);
    return { speech: `${hello} ${kid}`, mood: 'curious' };
  }
  switch (p.intent) {
    case 'COMMAND':
      return {
        speech: `${hello} I am only one ${traitWord(a)} ${a.age < 25 ? 'youth' : 'villager'}. ${leader && leader !== a ? `I will tell ${leader.name} what you said.` : 'I will tell the others.'}`,
        mood: believer ? 'reverent' : 'worried',
      };
    case 'THREAT':
      return { speech: `${pickLine(seed, ['Please! Please do not hurt us!', 'No... what did we do wrong?', 'I will tell everyone, I swear!'])}`, mood: 'afraid' };
    case 'PROMISE':
      return { speech: `${hello} ${pickLine(seed, ['Truly? I will tell everyone!', 'Then I will wait for it with open hands.', 'The others will never believe me.'])}`, mood: 'hopeful' };
    case 'BLESSING':
      return { speech: `${pickLine(seed, ['Thank you... I feel lighter already.', 'I will carry your blessing with me.', 'Did you hear that? The sky blessed me!'])}`, mood: 'joyful' };
    case 'QUESTION': {
      let ans: string;
      switch (p.topic) {
        case 'feelings':
        case 'needs':
          ans = a.needs.hunger < 0.35 ? 'Hungry. The bushes near camp are picked bare.' : a.needs.thirst < 0.35 ? 'So thirsty...' : a.needs.energy < 0.3 ? 'Tired to the bone.' : a.needs.safety < 0.5 ? 'Frightened, if I am honest.' : `I am ${m}.`;
          break;
        case 'work':
          ans = `I am ${act}.`;
          break;
        case 'name': {
          const traits = a.traits.map((t) => TRAITS[t].label.toLowerCase()).join(' and ');
          ans = `I am ${a.name}, ${Math.floor(a.age)} summers old. They say I am ${traits}.`;
          break;
        }
        case 'family': {
          const kids = w.agents.filter((o) => o.parents.includes(a.id) && o.alive).map((o) => o.name);
          const parents = a.parents.map((id) => w.agent(id)?.name).filter(Boolean);
          const best = [...a.relations.entries()].sort((x, y) => y[1] - x[1])[0];
          const friend = best ? w.agent(best[0]) : undefined;
          ans = kids.length ? `My children are ${kids.join(' and ')}.` : parents.length ? `I am the child of ${parents.join(' and ')}.` : friend ? `No family of my own, but ${friend.name} is dear to me.` : 'I have no family here.';
          break;
        }
        case 'god':
          ans = believer ? `We pray to you every night. ${civ ? `We call you ${civ.def.godName}.` : ''}` : doubter ? 'I did not think anyone was really up there.' : `Some say you are ${civ?.godView ?? 'watching'}. I was never sure.`;
          break;
        case 'leader':
          ans = leader ? (leader === a ? 'I lead them, for my sins.' : `${leader.name} leads us. ${leader.persona.includes('proud') ? 'Proud, but strong.' : leader.persona.includes('merciful') ? 'Kind to everyone.' : 'We trust them.'}`) : 'Nobody leads us now.';
          break;
        case 'food':
          ans = civ ? `There are ${civFood(w, civ)} portions in the stores. ${a.needs.hunger < 0.4 ? 'Not enough.' : 'We get by.'}` : 'We find what we can.';
          break;
        case 'past': {
          const last = [...a.log].reverse().find((e) => e.kind === 'event');
          ans = last ? `I remember... ${last.text.replace(/\.$/, '')}.` : 'Nothing much has happened to me yet.';
          break;
        }
        default:
          ans = `I am ${act}. ${a.needs.hunger < 0.4 ? 'And hungry.' : ''}`.trim();
      }
      return { speech: `${believer ? '' : `${hello} `}${ans}`, mood: a.needs.safety < 0.5 ? 'afraid' : believer ? 'reverent' : 'curious' };
    }
    default:
      return { speech: `${hello} ${pickLine(seed, [`I was just ${act}.`, 'What should I tell the others?', 'Are you watching over us?'])}`, mood: believer ? 'reverent' : 'curious' };
  }
}

function traitWord(a: Agent): string {
  const t = a.traits[0];
  return t ? TRAITS[t].label.toLowerCase() : 'simple';
}

/** The villager side of being spoken to: feelings change, and word may reach the leader. */
export function villagerHears(w: World, a: Agent, p: Parsed): void {
  const civ = w.civOf(a);
  const t = w.now(a);
  a.emote = { icon: p.intent === 'THREAT' ? 'warning' : 'star', until: t + 5 };
  a.brain.nextThink = t;
  if (p.intent === 'THREAT') {
    a.needs.safety = Math.max(0, a.needs.safety - 0.35);
    a.faith = Math.min(1, a.faith + 0.05);
    a.addLog(t, 'event', `A voice from the sky threatened me: "${p.text.slice(0, 60)}"`);
  } else {
    a.faith = Math.min(1, a.faith + (p.intent === 'BLESSING' ? 0.14 : 0.08));
    if (p.intent === 'BLESSING') a.needs.social = Math.min(1, a.needs.social + 0.2);
    a.addLog(t, 'event', `The voice from the sky spoke to me: "${p.text.slice(0, 60)}"`);
  }
  if (!civ) return;
  // Others nearby hear something too.
  for (const o of civ.members) {
    if (!o.alive || o === a) continue;
    if (Math.hypot(o.x - a.x, o.z - a.z) < 10) {
      o.faith = Math.min(1, o.faith + 0.03);
      o.emote = { icon: 'star', until: w.now(o) + 3 };
    }
  }
  const leader = leaderOf(w, civ);
  if (p.intent === 'COMMAND' && leader && leader !== a) leaderMemory(civ, `${a.name} says the voice from the sky told them: "${p.text.slice(0, 80)}"`, 2);
  divineEvent(w, { kind: 'spoke', x: a.x, z: a.z, radius: 4, text: `A voice from the sky spoke to ${a.name}.`, agent: a });
}

/** Everything a model needs to speak for someone, compact. Also used for display. */
export function speakerContext(w: World, civ: Civilization, a: Agent | undefined, role: 'leader' | 'villager'): Record<string, unknown> {
  const s = assess(w, civ);
  const leader = leaderOf(w, civ);
  const who = a ?? leader;
  return {
    civ: { name: civ.name, people: civ.people, identity: civ.def.identity },
    leader: leader ? { name: leader.name, persona: leader.persona, tone: leader.persona.map((t) => PERSONAS[t].tone).join('; ') } : null,
    speaker: who
      ? {
          name: who.name,
          role: role === 'leader' ? 'leader' : who.isChild ? 'child' : 'villager',
          age: Math.floor(who.age),
          traits: who.traits.map((t) => TRAITS[t].label.toLowerCase()),
          mood: moodOf(who).text.toLowerCase(),
          doing: activityText(who).text,
          faith: Math.round(who.faith * 100) / 100,
          recent: who.log.slice(-4).map((e) => e.text),
        }
      : null,
    state: {
      people: s.pop,
      food: s.food,
      hunger: s.hunger < 0.4 ? 'hungry' : s.hunger < 0.6 ? 'getting by' : 'well fed',
      settlements: s.settlements,
      era: s.era,
      hurt: s.hurt.length,
      plans: civ.objectives.map((o) => `${o.kind}: ${o.reason}`),
    },
    relations: s.known.map((c) => ({ name: c.name, people: c.people, state: civ.relation(c.id).state })),
    god: { name: civ.def.godName, view: civ.godView, faith: civ.rep.faith, fear: civ.rep.fear, trust: civ.rep.trust, anger: civ.rep.anger, awe: civ.rep.awe },
    memories: civ.mind.memories.slice(-10),
    summary: civ.mind.summary,
    commands: civ.mind.commands.slice(-4).map((c) => `${c.accepted ? 'obeyed' : 'refused'}: ${c.text}`),
  };
}
