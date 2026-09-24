export type Priority =
  | 'EXPAND'
  | 'ESTABLISH_SETTLEMENT'
  | 'EXPLORE_REGION'
  | 'PRIORITIZE_FOOD'
  | 'PRIORITIZE_BUILDING'
  | 'GATHER_MATERIALS'
  | 'MIGRATE'
  | 'SEEK_PEACE'
  | 'AVOID_CIVILIZATION'
  | 'TRADE'
  | 'PREPARE_DEFENSE'
  | 'HONOR_GOD'
  | 'REST'
  | 'NONE';
export type RequestKindName = 'rain' | 'food' | 'protection' | 'sign' | 'heal' | 'blessing' | 'peace' | 'guidance';
export type Intent = 'QUESTION' | 'COMMAND' | 'PROMISE' | 'THREAT' | 'BLESSING' | 'GENERAL';

export interface PlanValue {
  speech: string;
  priority: Priority;
  reason: string;
  targetRegion?: string;
  targetCiv?: string;
  mood?: string;
  memory?: string;
  ask?: { kind: RequestKindName; text: string };
}
export interface TalkValue {
  speech: string;
  mood?: string;
  memory?: string;
}
export type Validated<T> = { ok: true; value: T; dropped?: string[] } | { ok: false; error: string };

export interface Verdict {
  intent: Intent;
  accept?: boolean;
  reason?: string;
}
export interface HistoryTurn {
  from: 'god' | 'them';
  text: string;
}

export const OBJECTIVES: Priority[];
export const OBJECTIVE_HELP: Record<string, string>;
export const PRIORITIES: Priority[];
export const TARGETED: Priority[];
export const REQUEST_KINDS: RequestKindName[];
export const MOODS: string[];
export const INTENTS: Intent[];
export const LIMITS: {
  speech: number;
  talk: number;
  reason: number;
  memory: number;
  askText: number;
  message: number;
  history: number;
  contextBytes: number;
  bodyBytes: number;
};
export function cleanText(v: unknown, max: number): string;
export function matchName(name: unknown, allowed: readonly string[] | undefined): string | null;
export function validatePlan(raw: unknown, allowed?: { regions?: readonly string[]; civs?: readonly string[] }): Validated<PlanValue>;
export function validateTalk(raw: unknown): Validated<TalkValue>;
export function parseModelJson(text: unknown): { ok: true; value: unknown } | { ok: false; error: string };
export function sanitizeContext(ctx: unknown): Record<string, unknown> | null;
export const PLAN_SCHEMA: Record<string, unknown>;
export const TALK_SCHEMA: Record<string, unknown>;
export function planPrompt(ctx: unknown): { system: string; user: string };
export function talkPrompt(ctx: unknown, message: string, history: HistoryTurn[] | undefined, verdict: Verdict | undefined): { system: string; user: string };
