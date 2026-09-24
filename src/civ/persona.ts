import type { Rng } from '../core/rng';
import type { Priorities } from './cultures';

/** Leader-level personality. Every adult has one, so any of them can end up leading. */
export type PersonaTrait =
  | 'ambitious'
  | 'cautious'
  | 'curious'
  | 'merciful'
  | 'proud'
  | 'spiritual'
  | 'pragmatic'
  | 'aggressive'
  | 'patient'
  | 'paranoid'
  | 'generous';

export interface PersonaDef {
  label: string;
  /** What it means as a leader. */
  desc: string;
  /** Multipliers on civilization priorities while this person leads. */
  weights: Partial<Priorities>;
  /** Added to the chance of obeying the god (-1..1 scale contributions). */
  obedience: number;
  /** Willingness to take risks (exploration far away, founding settlements). */
  risk: number;
  /** Warmth toward other peoples (opinion drift). */
  diplomacy: number;
  /** How they sound. */
  tone: string;
  conflicts?: PersonaTrait[];
}

export const PERSONAS: Record<PersonaTrait, PersonaDef> = {
  ambitious: { label: 'Ambitious', desc: 'Wants the people to grow and spread.', weights: { expand: 1.35, build: 1.15 }, obedience: -0.05, risk: 0.25, diplomacy: -0.05, tone: 'confident and forward-looking', conflicts: ['patient'] },
  cautious: { label: 'Cautious', desc: 'Keeps the people close to home and safe.', weights: { explore: 0.75, defend: 1.25, expand: 0.8 }, obedience: 0.05, risk: -0.3, diplomacy: 0, tone: 'careful and measured', conflicts: ['aggressive'] },
  curious: { label: 'Curious', desc: 'Sends explorers to every horizon.', weights: { explore: 1.45 }, obedience: 0, risk: 0.15, diplomacy: 0.1, tone: 'inquisitive, full of questions' },
  merciful: { label: 'Merciful', desc: 'Avoids conflict and helps those in need.', weights: { social: 1.15, defend: 0.85 }, obedience: 0.05, risk: -0.05, diplomacy: 0.3, tone: 'gentle and forgiving', conflicts: ['aggressive'] },
  proud: { label: 'Proud', desc: 'Bows to no one, not even gods.', weights: { build: 1.15, defend: 1.1 }, obedience: -0.25, risk: 0.1, diplomacy: -0.15, tone: 'proud, formal, easily slighted' },
  spiritual: { label: 'Spiritual', desc: 'Sees the hand of the watcher in everything.', weights: { faith: 1.5 }, obedience: 0.2, risk: 0, diplomacy: 0.05, tone: 'reverent and poetic' },
  pragmatic: { label: 'Pragmatic', desc: 'Food first, stores full, no wasted effort.', weights: { gather: 1.3, build: 1.1, faith: 0.85 }, obedience: -0.05, risk: -0.05, diplomacy: 0.05, tone: 'blunt and practical' },
  aggressive: { label: 'Aggressive', desc: 'Treats neighbours as rivals to be pushed back.', weights: { defend: 1.35, expand: 1.2, social: 0.9 }, obedience: -0.1, risk: 0.3, diplomacy: -0.35, tone: 'hard, short-tempered', conflicts: ['merciful', 'cautious'] },
  patient: { label: 'Patient', desc: 'Builds slowly and surely; hard to rush.', weights: { build: 1.1, expand: 0.8 }, obedience: 0.05, risk: -0.15, diplomacy: 0.1, tone: 'slow, calm and wise', conflicts: ['ambitious'] },
  paranoid: { label: 'Paranoid', desc: 'Suspects everyone, including the sky.', weights: { defend: 1.4, explore: 0.9 }, obedience: -0.1, risk: -0.2, diplomacy: -0.3, tone: 'suspicious and wary' },
  generous: { label: 'Generous', desc: 'Shares freely and welcomes strangers.', weights: { social: 1.2, gather: 1.05 }, obedience: 0.05, risk: 0, diplomacy: 0.3, tone: 'warm and open-handed' },
};

export const PERSONA_IDS = Object.keys(PERSONAS) as PersonaTrait[];

export function randomPersona(rng: Rng, bias: PersonaTrait[] = []): PersonaTrait[] {
  const out: PersonaTrait[] = [];
  const pool = [...PERSONA_IDS, ...bias, ...bias];
  for (let i = 0; i < 40 && out.length < 2; i++) {
    const t = rng.pick(pool);
    if (out.includes(t)) continue;
    if (out.some((o) => PERSONAS[o].conflicts?.includes(t) || PERSONAS[t].conflicts?.includes(o))) continue;
    out.push(t);
  }
  return out;
}

export function personaText(traits: PersonaTrait[]): string {
  return traits.map((t) => PERSONAS[t].label.toLowerCase()).join(' and ');
}
