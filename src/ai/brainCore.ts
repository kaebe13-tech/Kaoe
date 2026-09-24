import type { V2 } from '../core/math';
import type { Agent } from '../agents/Agent';
import type { World } from '../sim/World';
import type { ItemType } from '../sim/types';
import type { Action } from './Action';

export type GoalId =
  | 'flee'
  | 'drink'
  | 'eat'
  | 'sleep'
  | 'shelter'
  | 'comfort'
  | 'help'
  | 'socialize'
  | 'chat'
  | 'found'
  | 'supply'
  | 'construct'
  | 'haul'
  | 'tendFire'
  | 'explore'
  | 'idle'
  | 'pray'
  | 'play'
  | 'recover'
  | 'envoy';

export type IconId =
  | 'food'
  | 'water'
  | 'sleep'
  | 'warning'
  | 'rain'
  | 'home'
  | 'heart'
  | 'social'
  | 'build'
  | 'wood'
  | 'hammer'
  | 'fire'
  | 'explore'
  | 'idle'
  | 'star'
  | 'heal';

export interface Claims {
  resource?: number;
  site?: { id: number; item: ItemType; promised: number };
}

/** A concrete option produced by a goal: score + explanation + a plan to achieve it. */
export interface Candidate {
  goal: GoalId;
  label: string;
  icon: IconId;
  score: number;
  reason: string;
  targetLabel?: string;
  target?: V2 | null;
  targetId?: number;
  urgent?: boolean;
  /** Identifies the specific option (goal + target) for cooldowns. */
  key?: string;
  claims?: Claims;
  thought?: string;
  build: () => Action[];
  onComplete?: (a: Agent, w: World) => string | void;
}

export interface ActiveGoal {
  goal: GoalId;
  label: string;
  icon: IconId;
  reason: string;
  targetLabel: string;
  target: V2 | null;
  targetId?: number;
  key: string;
  score: number;
  urgent: boolean;
  plan: Action[];
  step: number;
  since: number;
  claims: Claims;
  onComplete?: (a: Agent, w: World) => string | void;
}

export interface BrainState {
  active: ActiveGoal | null;
  nextThink: number;
  cooldowns: Map<string, number>;
  lastSwitch: { from: GoalId; at: number } | null;
  /** Rolling count of goal switches, for the anti-dithering stats. */
  switches: number;
}

export function newBrain(): BrainState {
  return { active: null, nextThink: 0, cooldowns: new Map(), lastSwitch: null, switches: 0 };
}

export function currentAction(a: Agent): Action | null {
  const act = a.brain.active;
  return act ? (act.plan[act.step] ?? null) : null;
}

export function setCooldown(a: Agent, key: string, until: number): void {
  a.brain.cooldowns.set(key, Math.max(a.brain.cooldowns.get(key) ?? 0, until));
}

export function onCooldown(a: Agent, key: string, now: number): boolean {
  const t = a.brain.cooldowns.get(key);
  return t !== undefined && t > now;
}

function applyClaims(w: World, c: Claims, sign: 1 | -1): void {
  if (c.resource !== undefined) {
    const r = w.resources.get(c.resource);
    if (r) r.claims = Math.max(0, r.claims + sign);
  }
  if (c.site) {
    const s = w.structure(c.site.id);
    if (s) {
      const cur = s.incoming[c.site.item] ?? 0;
      s.incoming[c.site.item] = Math.max(0, cur + sign * c.site.promised);
    }
  }
}

export function adopt(a: Agent, w: World, c: Candidate): void {
  const plan = c.build();
  const active: ActiveGoal = {
    goal: c.goal,
    label: c.label,
    icon: c.icon,
    reason: c.reason,
    targetLabel: c.targetLabel ?? '',
    target: c.target ?? null,
    key: c.key ?? c.goal,
    score: c.score,
    urgent: !!c.urgent,
    plan,
    step: 0,
    since: w.time,
    claims: c.claims ? { ...c.claims, site: c.claims.site ? { ...c.claims.site } : undefined } : {},
  };
  if (c.targetId !== undefined) active.targetId = c.targetId;
  if (c.onComplete) active.onComplete = c.onComplete;
  applyClaims(w, active.claims, 1);
  a.brain.active = active;
  a.thought = c.thought ?? a.thought;
  const target = c.targetLabel ? ` → ${c.targetLabel}` : '';
  a.addLog(w.time, 'decide', `${c.label}: ${c.reason}${target}`);
}

function endActive(a: Agent, w: World, status: 'success' | 'failure' | 'aborted'): void {
  const act = a.brain.active;
  if (!act) return;
  const cur = act.plan[act.step];
  if (cur && cur.begun) cur.finish(a, w, status === 'success' ? 'success' : status === 'failure' ? 'failure' : 'aborted');
  applyClaims(w, act.claims, -1);
  a.brain.active = null;
  a.focus = null;
}

export function abortActive(a: Agent, w: World, why: string): void {
  const act = a.brain.active;
  if (!act) return;
  a.addLog(w.time, 'switch', `Stopped "${act.label}" — ${why}`);
  endActive(a, w, 'aborted');
}

/** Replace whatever the agent is doing (used for conversations and reactions). */
export function injectPlan(a: Agent, w: World, c: Candidate): void {
  if (a.brain.active) endActive(a, w, 'aborted');
  adopt(a, w, c);
  a.brain.nextThink = w.time + 1.5;
}

/** Reduce a hauling promise once materials are actually delivered. */
export function fulfilPromise(a: Agent, w: World, delivered: number): void {
  const site = a.brain.active?.claims.site;
  if (!site || delivered <= 0) return;
  const n = Math.min(site.promised, delivered);
  site.promised -= n;
  const s = w.structure(site.id);
  if (s) s.incoming[site.item] = Math.max(0, (s.incoming[site.item] ?? 0) - n);
}

/** Tick the active plan. Returns the outcome when the plan ends this tick. */
export function runPlan(a: Agent, w: World, dt: number): 'running' | 'success' | 'failure' | 'idle' {
  const act = a.brain.active;
  if (!act) return 'idle';
  const step = act.plan[act.step];
  if (!step) {
    completeActive(a, w, '');
    return 'success';
  }
  if (!step.begun) {
    step.begun = true;
    const r = step.begin(a, w);
    if (r === 'failure') {
      step.finish(a, w, 'failure');
      step.begun = false;
      failActive(a, w, step.failReason || 'Could not start');
      return 'failure';
    }
  }
  const status = step.tick(a, w, dt);
  if (status === 'running') return 'running';
  if (status === 'failure') {
    step.finish(a, w, 'failure');
    step.begun = false;
    failActive(a, w, step.failReason || 'Something went wrong');
    return 'failure';
  }
  step.finish(a, w, 'success');
  const summary = step.summary;
  act.step++;
  if (act.step >= act.plan.length) {
    completeActive(a, w, summary);
    return 'success';
  }
  return 'running';
}

function completeActive(a: Agent, w: World, lastSummary: string): void {
  const act = a.brain.active;
  if (!act) return;
  const msg = act.onComplete?.(a, w) || lastSummary;
  applyClaims(w, act.claims, -1);
  a.brain.active = null;
  a.focus = null;
  if (msg) a.addLog(w.time, 'done', msg);
  a.brain.nextThink = w.time;
}

function failActive(a: Agent, w: World, reason: string): void {
  const act = a.brain.active;
  if (!act) return;
  a.addLog(w.time, 'fail', `${act.label} failed: ${reason}`);
  applyClaims(w, act.claims, -1);
  // Don't immediately retry the exact same option.
  setCooldown(a, act.key, w.time + 40);
  setCooldown(a, `goal:${act.goal}`, w.time + 3);
  a.brain.active = null;
  a.focus = null;
  a.brain.nextThink = w.time + 0.3;
}
