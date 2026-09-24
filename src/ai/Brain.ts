import { hash01 } from '../core/rng';
import type { Agent } from '../agents/Agent';
import type { World } from '../sim/World';
import { abortActive, adopt, onCooldown, runPlan, type Candidate } from './brainCore';
import { GOALS, buildContext } from './goals';
import { perceive } from './perception';

/** Bonus the current goal gets when compared against alternatives (hysteresis). */
const COMMITMENT = 0.12;
/** Extra stickiness right after adopting a goal. */
const EARLY_COMMITMENT = 0.1;
const EARLY_WINDOW = 4;
/** Don't switch back to a goal we just abandoned for this long (unless urgent). */
const NO_BOUNCE = 10;

export interface ThinkResult {
  candidates: Candidate[];
  chosen: Candidate | null;
}

/** Last evaluated options per agent — shown in the debug overlay. */
export const lastThink = new Map<number, ThinkResult>();

function jitter(a: Agent, c: Candidate, now: number): number {
  // Small personal variation that changes slowly, so identical agents don't act in lockstep.
  return 1 + (hash01(a.id * 31 + c.goal.length * 7, Math.floor(now / 25)) - 0.5) * 0.08;
}

export function think(a: Agent, w: World): void {
  perceive(a, w);
  const ctx = buildContext(a, w);
  const now = w.time;
  const all: Candidate[] = [];
  for (const g of GOALS) {
    const r = g(a, w, ctx);
    if (!r) continue;
    if (Array.isArray(r)) all.push(...r);
    else all.push(r);
  }
  const valid = all.filter((c) => c.score > 0 && !onCooldown(a, c.key ?? c.goal, now) && !onCooldown(a, `goal:${c.goal}`, now));
  let best: Candidate | null = null;
  let bestScore = -Infinity;
  for (const c of valid) {
    const s = c.score * jitter(a, c, now);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  lastThink.set(a.id, { candidates: valid, chosen: best });

  const act = a.brain.active;
  if (!act) {
    if (best) adopt(a, w, best);
    return;
  }
  if (!best) return;
  // Refresh how much the current goal still matters.
  let cur = -Infinity;
  for (const c of valid) if (c.goal === act.goal) cur = Math.max(cur, c.score);
  if (cur === -Infinity) cur = act.score * 0.85;
  act.score = cur;
  if (best.goal === act.goal) return;

  const step = act.plan[act.step];
  const locked = !!step && !step.interruptible;
  const commit = COMMITMENT + (now - act.since < EARLY_WINDOW ? EARLY_COMMITMENT : 0);
  const bounce = a.brain.lastSwitch && a.brain.lastSwitch.from === best.goal && now - a.brain.lastSwitch.at < NO_BOUNCE;
  let switchNow = false;
  if (best.urgent && !act.urgent) switchNow = true;
  else if (!locked && !bounce && bestScore > cur + commit) switchNow = true;
  if (!switchNow) return;

  abortActive(a, w, best.urgent ? best.reason.toLowerCase() : `${best.label.toLowerCase()} became more important`);
  a.brain.lastSwitch = { from: act.goal, at: now };
  a.brain.switches++;
  adopt(a, w, best);
}

/** Per-step brain update: think when due, then advance the current plan. */
export function updateBrain(a: Agent, w: World, dt: number): void {
  if (w.time >= a.brain.nextThink) {
    const sleeping = a.anim === 'sleep';
    a.brain.nextThink = w.time + (sleeping ? 3 : 0.8) + hash01(a.id, Math.floor(w.time)) * 0.5;
    think(a, w);
  }
  const res = runPlan(a, w, dt);
  if (res === 'idle' && a.anim !== 'idle' && a.anim !== 'knocked') a.setAnim('idle');
}
