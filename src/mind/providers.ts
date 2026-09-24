import { validatePlan, validateTalk, type HistoryTurn, type PlanValue, type TalkValue, type Verdict } from '../../shared/leaderProtocol.mjs';

/**
 * Where a leader's words and high-level decisions come from. The simulation never waits on a
 * provider: calls are asynchronous, and every result is validated before it is applied.
 */
export type ProviderId = 'local' | 'gemini' | 'mock';

export interface ProviderStatus {
  available: boolean;
  model?: string;
  reason?: string;
}

export interface Allowed {
  regions: string[];
  civs: string[];
}

export interface PlanRequest {
  context: Record<string, unknown>;
  allowed: Allowed;
  /** Local judgement, used by the local provider. */
  local?: () => PlanValue;
}

export interface TalkRequest {
  context: Record<string, unknown>;
  message: string;
  history: HistoryTurn[];
  verdict?: Verdict;
  local?: () => TalkValue;
}

export interface ProviderResult<T> {
  value: T;
  model: string;
  ms: number;
}

export interface AIProvider {
  readonly id: ProviderId;
  readonly label: string;
  status(signal?: AbortSignal): Promise<ProviderStatus>;
  plan(req: PlanRequest, signal?: AbortSignal): Promise<ProviderResult<PlanValue>>;
  talk(req: TalkRequest, signal?: AbortSignal): Promise<ProviderResult<TalkValue>>;
}

export type ProviderErrorCode =
  | 'disabled'
  | 'unavailable'
  | 'network'
  | 'timeout'
  | 'rate_limited'
  | 'busy'
  | 'invalid_output'
  | 'malformed'
  | 'empty'
  | 'auth'
  | 'bad_input'
  | 'aborted';

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Decides everything locally, instantly. Always available; the fallback for every failure. */
export class LocalProvider implements AIProvider {
  readonly id = 'local' as const;
  readonly label = 'Local minds';

  async status(): Promise<ProviderStatus> {
    return { available: true, model: 'local' };
  }

  async plan(req: PlanRequest): Promise<ProviderResult<PlanValue>> {
    if (!req.local) throw new ProviderError('unavailable', 'No local planner supplied');
    return { value: req.local(), model: 'local', ms: 0 };
  }

  async talk(req: TalkRequest): Promise<ProviderResult<TalkValue>> {
    if (!req.local) throw new ProviderError('unavailable', 'No local voice supplied');
    return { value: req.local(), model: 'local', ms: 0 };
  }
}

const ERROR_CODES: ProviderErrorCode[] = ['disabled', 'unavailable', 'network', 'timeout', 'rate_limited', 'busy', 'invalid_output', 'malformed', 'empty', 'auth', 'bad_input'];

/**
 * Gemini through the game's own server (`/api/ai/*`). The browser never sees the API key; it
 * only talks to the same-origin endpoint, which holds the key server-side.
 */
export class GeminiProvider implements AIProvider {
  readonly id = 'gemini' as const;
  readonly label = 'Gemini';

  constructor(
    private readonly base = '',
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async status(signal?: AbortSignal): Promise<ProviderStatus> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/api/ai/status`, { signal, headers: { accept: 'application/json' } });
    } catch {
      return { available: false, reason: 'The game server cannot be reached' };
    }
    if (res.status === 404) return { available: false, reason: 'This copy of the game has no AI server (run it with npm run dev or npm run serve)' };
    if (!res.ok) return { available: false, reason: `The AI server answered ${res.status}` };
    try {
      const j = (await res.json()) as { available?: boolean; model?: string; reason?: string };
      return { available: j.available === true, model: typeof j.model === 'string' ? j.model : '', reason: typeof j.reason === 'string' ? j.reason : '' };
    } catch {
      return { available: false, reason: 'The AI server sent a strange answer' };
    }
  }

  private async post(body: unknown, signal?: AbortSignal): Promise<{ result: unknown; model: string; ms: number }> {
    const t0 = now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/api/ai/leader`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal?.aborted || (e as Error)?.name === 'AbortError') throw new ProviderError('timeout', 'The model took too long');
      throw new ProviderError('network', 'The game server cannot be reached');
    }
    let j: { ok?: boolean; result?: unknown; error?: string; model?: string; retryAfter?: number } = {};
    try {
      j = await res.json();
    } catch {
      throw new ProviderError('malformed', `Unreadable reply (${res.status})`);
    }
    if (!res.ok || !j.ok) {
      const code = ERROR_CODES.includes(j.error as ProviderErrorCode) ? (j.error as ProviderErrorCode) : res.status === 404 ? 'unavailable' : 'unavailable';
      throw new ProviderError(code, `AI request failed: ${code}`, Number(j.retryAfter) || 0);
    }
    return { result: j.result, model: typeof j.model === 'string' ? j.model : 'gemini', ms: now() - t0 };
  }

  async plan(req: PlanRequest, signal?: AbortSignal): Promise<ProviderResult<PlanValue>> {
    const r = await this.post({ kind: 'plan', context: { ...req.context, allowed: req.allowed } }, signal);
    const v = validatePlan(r.result, req.allowed);
    if (!v.ok) throw new ProviderError('invalid_output', `Rejected: ${v.error}`);
    return { value: v.value, model: r.model, ms: r.ms };
  }

  async talk(req: TalkRequest, signal?: AbortSignal): Promise<ProviderResult<TalkValue>> {
    const r = await this.post({ kind: 'talk', context: req.context, message: req.message, history: req.history, verdict: req.verdict }, signal);
    const v = validateTalk(r.result);
    if (!v.ok) throw new ProviderError('invalid_output', `Rejected: ${v.error}`);
    return { value: v.value, model: r.model, ms: r.ms };
  }
}

export type MockMode = 'success' | 'slow' | 'invalid' | 'malformed' | 'rateLimit' | 'network' | 'empty' | 'unavailable' | 'off';

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('timeout', 'aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ProviderError('timeout', 'The model took too long'));
    });
  });
}

/** A stand-in model for tests and for trying every failure mode without a network. */
export class MockProvider implements AIProvider {
  readonly id = 'mock' as const;
  readonly label: string;
  calls = 0;

  constructor(
    public mode: MockMode = 'success',
    private readonly delayMs = 5,
    private readonly slowMs = 30000,
  ) {
    this.label = `Mock (${mode})`;
  }

  async status(): Promise<ProviderStatus> {
    if (this.mode === 'unavailable') return { available: false, reason: 'Mock: unavailable' };
    if (this.mode === 'off') return { available: false, reason: 'Mock: AI is off' };
    if (this.mode === 'network') return { available: false, reason: 'Mock: network down' };
    return { available: true, model: `mock-${this.mode}` };
  }

  private async fail(signal?: AbortSignal): Promise<void> {
    this.calls++;
    switch (this.mode) {
      case 'slow':
        await sleep(this.slowMs, signal);
        return;
      case 'rateLimit':
        await sleep(this.delayMs, signal);
        throw new ProviderError('rate_limited', 'Mock: rate limited', 5);
      case 'network':
        throw new ProviderError('network', 'Mock: network failure');
      case 'unavailable':
      case 'off':
        throw new ProviderError('unavailable', 'Mock: unavailable');
      case 'malformed':
        await sleep(this.delayMs, signal);
        throw new ProviderError('malformed', 'Mock: malformed JSON');
      case 'empty':
        await sleep(this.delayMs, signal);
        throw new ProviderError('empty', 'Mock: empty reply');
      default:
        await sleep(this.delayMs, signal);
    }
  }

  async plan(req: PlanRequest, signal?: AbortSignal): Promise<ProviderResult<PlanValue>> {
    await this.fail(signal);
    const raw: unknown =
      this.mode === 'invalid'
        ? { speech: 'We march on the moon.', priority: 'LAUNCH_ARMIES', reason: 'why not' }
        : { speech: 'We will send explorers beyond the hills.', priority: 'EXPLORE_REGION', reason: 'The mock mind is curious', targetRegion: req.allowed.regions[0] ?? null, mood: 'curious' };
    const v = validatePlan(raw, req.allowed);
    if (!v.ok) throw new ProviderError('invalid_output', `Rejected: ${v.error}`);
    return { value: v.value, model: `mock-${this.mode}`, ms: this.delayMs };
  }

  async talk(req: TalkRequest, signal?: AbortSignal): Promise<ProviderResult<TalkValue>> {
    await this.fail(signal);
    const raw: unknown = this.mode === 'invalid' ? { words: 42 } : { speech: req.verdict?.accept === false ? 'No. We will not.' : `We hear you: "${req.message.slice(0, 40)}"`, mood: 'calm' };
    const v = validateTalk(raw);
    if (!v.ok) throw new ProviderError('invalid_output', `Rejected: ${v.error}`);
    return { value: v.value, model: `mock-${this.mode}`, ms: this.delayMs };
  }
}
