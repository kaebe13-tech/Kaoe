import type { World } from '../sim/World';
import type { Agent } from '../agents/Agent';
import type { Civilization } from '../civ/Civilization';
import { Emitter } from '../core/events';
import { applyDecision, leaderHooks, leaderMemory, localDecision } from '../civ/leader';
import { leaderOf } from '../civ/civSystem';
import { speakerContext, type Verdict as SimVerdict } from '../civ/dialogue';
import { validatePlan, type HistoryTurn, type PlanValue, type TalkValue } from '../../shared/leaderProtocol.mjs';
import { GeminiProvider, ProviderError, type AIProvider, type Allowed } from './providers';

export type MindState = 'off' | 'checking' | 'online' | 'offline' | 'unavailable';

export interface MindEvents {
  status: MindService;
  applied: { civId: number; speech: string; model: string };
}

const STORE_KEY = 'kaoe.ai';
/** Real seconds between model plans for one civilization. */
const PLAN_INTERVAL = 40;
const PLAN_TIMEOUT = 16000;
const TALK_TIMEOUT = 12000;
const MAX_INFLIGHT = 2;

const realNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

function readSetting(): boolean {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return v === null ? true : v === 'on';
  } catch {
    return true;
  }
}

/** The names a leader's decision may refer to (the only ones a model is allowed to use). */
export function allowedFor(w: World, civ: Civilization): Allowed {
  return {
    regions: w.terrain.regions.map((r) => r.name),
    civs: w.civs.filter((c) => c !== civ && civ.knows(c.id)).map((c) => c.name),
  };
}

/** Compact context for a strategic review. */
export function planContext(w: World, civ: Civilization, reason: string): Record<string, unknown> {
  const leader = leaderOf(w, civ);
  const ctx = speakerContext(w, civ, leader, 'leader');
  ctx.regions = {
    known: w.terrain.regions.filter((r) => civ.knowledge.regions.has(r.id)).map((r) => r.name),
    unknown: w.terrain.regions.filter((r) => !civ.knowledge.regions.has(r.id)).map((r) => r.name).slice(0, 10),
  };
  ctx.recent = civ.history.slice(-6).map((e) => `Day ${e.day}: ${e.text}`);
  ctx.reason = reason;
  return ctx;
}

/**
 * Connects leaders to an optional language model. Everything here is asynchronous and
 * advisory: the local planner has always already decided, a model may refine that later,
 * and nothing it says reaches the simulation without passing validation.
 */
export class MindService {
  readonly events = new Emitter<MindEvents>();
  enabled = readSetting();
  state: MindState = 'checking';
  statusText = 'Checking for an AI server…';
  model = '';
  lastLatency = 0;
  calls = 0;
  failures = 0;
  lastError = '';
  private consecutive = 0;
  private breakerUntil = 0;
  private inflight = 0;
  private readonly civBusy = new Set<number>();
  private readonly nextPlan = new Map<number, number>();
  private readonly backoff = new Map<number, number>();
  private recheck: ReturnType<typeof setTimeout> | null = null;
  private checking: Promise<void> | null = null;

  constructor(
    private readonly getWorld: () => World,
    public provider: AIProvider = new GeminiProvider(),
    private readonly staticBuild = false,
  ) {}

  /** Start listening to leaders' reviews. */
  install(): void {
    leaderHooks.think = (w, civ, reason) => this.think(w, civ, reason);
    void this.refresh();
  }

  uninstall(): void {
    leaderHooks.think = null;
    if (this.recheck) clearTimeout(this.recheck);
  }

  get online(): boolean {
    return this.enabled && this.state === 'online' && realNow() >= this.breakerUntil;
  }

  get sourceLabel(): string {
    return this.online ? `${this.provider.label}${this.model ? ` (${this.model})` : ''}` : 'Local minds';
  }

  private setState(s: MindState, text: string): void {
    this.state = s;
    this.statusText = text;
    this.events.emit('status', this);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      localStorage.setItem(STORE_KEY, on ? 'on' : 'off');
    } catch {
      /* private mode */
    }
    if (!on) this.setState('off', 'AI leaders are off. Leaders think with their local minds.');
    else void this.refresh();
  }

  /** Ask the provider whether it can serve. */
  refresh(): Promise<void> {
    this.checking = this.doRefresh().finally(() => (this.checking = null));
    return this.checking;
  }

  private async doRefresh(): Promise<void> {
    if (!this.enabled) {
      this.setState('off', 'AI leaders are off. Leaders think with their local minds.');
      return;
    }
    if (this.staticBuild && this.provider.id === 'gemini') {
      this.setState('unavailable', 'This copy runs without the Kaoe server, so leaders use their local minds. Run it with npm run dev or npm run serve and a GEMINI_API_KEY to enable Gemini.');
      return;
    }
    this.setState('checking', 'Checking for an AI server…');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    try {
      const st = await this.provider.status(ctl.signal);
      if (!this.enabled) return;
      if (st.available) {
        this.model = st.model ?? '';
        this.consecutive = 0;
        this.breakerUntil = 0;
        this.setState('online', `Leaders can think with ${this.provider.label}${this.model ? ` (${this.model})` : ''}. Local minds step in whenever it is slow or unavailable.`);
      } else {
        this.setState('unavailable', `${st.reason || 'No AI server is available.'} Leaders use their local minds.`);
      }
    } catch {
      this.setState('unavailable', 'The AI server could not be reached. Leaders use their local minds.');
    } finally {
      clearTimeout(t);
    }
  }

  private noteFailure(e: unknown, civId: number | null): void {
    const err = e instanceof ProviderError ? e : new ProviderError('unavailable', String(e));
    this.failures++;
    this.consecutive++;
    this.lastError = err.code;
    if (civId !== null) {
      const n = (this.backoff.get(civId) ?? 0) + 1;
      this.backoff.set(civId, n);
      this.nextPlan.set(civId, realNow() + Math.min(300, PLAN_INTERVAL * 2 ** n) + err.retryAfter);
    }
    const hard = err.code === 'unavailable' || err.code === 'disabled' || err.code === 'network' || err.code === 'auth';
    if (hard || this.consecutive >= 3) {
      const wait = err.code === 'rate_limited' ? Math.max(30, err.retryAfter) : 60;
      this.breakerUntil = realNow() + wait;
      this.setState('offline', `The AI is not answering (${err.code.replace('_', ' ')}). Leaders use their local minds; trying again in ${wait} s.`);
      if (this.recheck) clearTimeout(this.recheck);
      this.recheck = setTimeout(() => void this.refresh(), wait * 1000);
    } else this.events.emit('status', this);
  }

  private noteSuccess(ms: number, model: string, civId: number | null): void {
    this.lastLatency = ms;
    this.model = model;
    this.consecutive = 0;
    if (civId !== null) this.backoff.delete(civId);
    if (this.state !== 'online') this.setState('online', `Leaders think with ${this.provider.label} (${model}).`);
    else this.events.emit('status', this);
  }

  /** A leader is reviewing strategy (the local decision is already in place). */
  think(w: World, civ: Civilization, reason: string): void {
    if (!this.online || this.inflight >= MAX_INFLIGHT || this.civBusy.has(civ.id)) return;
    const t = realNow();
    if ((this.nextPlan.get(civ.id) ?? 0) > t) return;
    const leader = leaderOf(w, civ);
    if (!leader) return;
    this.nextPlan.set(civ.id, t + PLAN_INTERVAL);
    const allowed = allowedFor(w, civ);
    const context = planContext(w, civ, reason);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PLAN_TIMEOUT);
    this.inflight++;
    this.civBusy.add(civ.id);
    this.calls++;
    const leaderId = leader.id;
    const reviewTime = w.worldTime;
    this.provider
      .plan({ context, allowed, local: () => localDecision(w, civ, reason) as PlanValue }, ctl.signal)
      .then((r) => {
        this.noteSuccess(r.ms, r.model, civ.id);
        this.applyPlan(w, civ, leaderId, r.value, r.model, reviewTime);
      })
      .catch((e) => this.noteFailure(e, civ.id))
      .finally(() => {
        clearTimeout(timer);
        this.inflight--;
        this.civBusy.delete(civ.id);
      });
  }

  /** Apply a model's plan if it still makes sense in the current world. */
  applyPlan(w: World, civ: Civilization, leaderId: number, value: PlanValue, model: string, reviewTime = -Infinity): boolean {
    if (this.getWorld() !== w || civ.population === 0) return false;
    // A new leader may have taken over while the model was thinking.
    if (civ.leaderId !== leaderId) return false;
    // Re-validate against the world as it is now.
    const v = validatePlan(value, allowedFor(w, civ));
    if (!v.ok) return false;
    // The model refines the review it was asked about: it replaces what the local mind chose then.
    for (let i = civ.objectives.length - 1; i >= 0; i--) {
      const o = civ.objectives[i]!;
      if (o.source === 'leader' && o.since >= reviewTime) civ.objectives.splice(i, 1);
    }
    w.withCiv(civ, () => applyDecision(w, civ, v.value, 'ai'));
    this.events.emit('applied', { civId: civ.id, speech: v.value.speech, model });
    return true;
  }

  /**
   * Someone answers the god. Tries the model for the words (the verdict is already decided
   * locally), and falls back to the local voice on any failure. Never rejects.
   */
  async talk(
    w: World,
    civ: Civilization,
    speaker: Agent | undefined,
    role: 'leader' | 'villager',
    message: string,
    history: HistoryTurn[],
    verdict: SimVerdict,
    local: () => TalkValue,
  ): Promise<TalkValue & { source: 'ai' | 'local'; model: string }> {
    const fallback = () => ({ ...local(), source: 'local' as const, model: 'local' });
    // Spoken to in the first moments: wait for the server check rather than answer locally.
    if (this.checking) await this.checking;
    if (!this.online || this.inflight >= MAX_INFLIGHT + 1) return fallback();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TALK_TIMEOUT);
    this.inflight++;
    this.calls++;
    try {
      const context = speakerContext(w, civ, speaker, role);
      const r = await this.provider.talk({ context, message, history, verdict: { intent: verdict.intent, accept: verdict.accept, reason: verdict.reason }, local }, ctl.signal);
      this.noteSuccess(r.ms, r.model, null);
      if (r.value.memory && role === 'leader' && this.getWorld() === w) leaderMemory(civ, r.value.memory, 1);
      return { ...r.value, source: 'ai', model: r.model };
    } catch (e) {
      this.noteFailure(e, null);
      return fallback();
    } finally {
      clearTimeout(timer);
      this.inflight--;
    }
  }
}
