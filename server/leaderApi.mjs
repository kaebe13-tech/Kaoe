// HTTP endpoints that let the browser ask a language model to speak or plan for a leader.
//
//   GET  /api/ai/status   -> { available, provider, model, ... }   (never the key)
//   POST /api/ai/leader   -> { ok, result } | { ok: false, error }
//        body: { kind: 'plan' | 'talk', context, message?, history?, verdict? }
//
// Works as Connect-style middleware (Vite dev/preview) and inside a plain node:http server.
// Every reply from the model is validated here and again in the browser before it can
// influence the simulation.

import {
  LIMITS,
  PLAN_SCHEMA,
  TALK_SCHEMA,
  cleanText,
  planPrompt,
  sanitizeContext,
  talkPrompt,
  validatePlan,
  validateTalk,
  INTENTS,
} from '../shared/leaderProtocol.mjs';
import { AIError, createGeminiClient } from './gemini.mjs';

const STATUS_FOR = {
  bad_input: 400,
  too_large: 413,
  forbidden: 403,
  rate_limited: 429,
  busy: 429,
  unavailable: 503,
  disabled: 503,
  auth: 503,
  model_missing: 503,
  timeout: 504,
  network: 502,
  malformed: 502,
  empty: 502,
  invalid_output: 502,
  bad_request: 502,
};

function tokenBucket(capacity, perMinute, now) {
  let tokens = capacity;
  let last = now();
  return {
    take() {
      const t = now();
      tokens = Math.min(capacity, tokens + ((t - last) / 60000) * perMinute);
      last = t;
      if (tokens < 1) return Math.ceil(((1 - tokens) / perMinute) * 60);
      tokens -= 1;
      return 0;
    },
  };
}

function send(res, status, body, extra = {}) {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(json);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // Stop reading; the reply goes out with `connection: close` and the socket is dropped after it.
        req.removeAllListeners('data');
        req.pause();
        reject(new AIError('too_large', 'Request too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(new AIError('bad_input', 'Could not read request')));
  });
}

/** Only same-origin pages may use the endpoint (it spends the owner's API quota). */
function crossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/**
 * @param {{ apiKey?: string, models?: string[], fetchImpl?: typeof fetch, now?: () => number,
 *           enabled?: boolean, perMinute?: number, perClientPerMinute?: number, maxInflight?: number,
 *           log?: (msg: string) => void }} opts
 */
export function createLeaderApi(opts = {}) {
  const now = opts.now ?? Date.now;
  const enabled = opts.enabled !== false && !!opts.apiKey;
  const client = enabled ? createGeminiClient({ apiKey: opts.apiKey, models: opts.models, fetchImpl: opts.fetchImpl, now }) : null;
  const global = tokenBucket(opts.perMinute ?? 40, opts.perMinute ?? 40, now);
  const perClient = new Map();
  const perClientRate = opts.perClientPerMinute ?? 24;
  const maxInflight = opts.maxInflight ?? 4;
  const log = opts.log ?? (() => {});
  let inflight = 0;
  const stats = { calls: 0, ok: 0, failed: 0, lastError: '', lastModel: '', lastMs: 0 };

  function clientBucket(ip) {
    let b = perClient.get(ip);
    if (!b) {
      if (perClient.size > 500) perClient.clear();
      b = tokenBucket(perClientRate, perClientRate, now);
      perClient.set(ip, b);
    }
    return b;
  }

  async function leader(req, res) {
    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.includes('application/json')) return send(res, 415, { ok: false, error: 'bad_input' });
    if (!client) return send(res, 503, { ok: false, error: 'disabled' });
    const ip = String(req.socket?.remoteAddress ?? 'local');
    const wait = clientBucket(ip).take() || global.take();
    if (wait) return send(res, 429, { ok: false, error: 'rate_limited', retryAfter: wait }, { 'retry-after': String(wait) });
    if (inflight >= maxInflight) return send(res, 429, { ok: false, error: 'busy', retryAfter: 3 }, { 'retry-after': '3' });
    let body;
    try {
      body = JSON.parse(await readBody(req, LIMITS.bodyBytes));
    } catch (e) {
      const code = e instanceof AIError ? e.code : 'bad_input';
      return send(res, STATUS_FOR[code] ?? 400, { ok: false, error: code }, code === 'too_large' ? { connection: 'close' } : {});
    }
    const kind = body?.kind;
    if (kind !== 'plan' && kind !== 'talk') return send(res, 400, { ok: false, error: 'bad_input' });
    const context = sanitizeContext(body.context);
    if (!context) return send(res, 400, { ok: false, error: 'bad_input' });
    const allowed = {
      regions: Array.isArray(context.allowed?.regions) ? context.allowed.regions.filter((s) => typeof s === 'string') : [],
      civs: Array.isArray(context.allowed?.civs) ? context.allowed.civs.filter((s) => typeof s === 'string') : [],
    };
    let prompt;
    if (kind === 'plan') prompt = planPrompt(context);
    else {
      const message = cleanText(body.message, LIMITS.message);
      if (!message) return send(res, 400, { ok: false, error: 'bad_input' });
      const history = Array.isArray(body.history) ? body.history.slice(-LIMITS.history).map((t) => ({ from: t?.from === 'god' ? 'god' : 'them', text: cleanText(t?.text, 300) })) : [];
      const v = body.verdict;
      const verdict = v && typeof v === 'object' && INTENTS.includes(v.intent) ? { intent: v.intent, accept: v.accept === true, reason: cleanText(v.reason, 160) } : undefined;
      prompt = talkPrompt(context, message, history, verdict);
    }
    inflight++;
    stats.calls++;
    try {
      const out = await client.generate({
        system: prompt.system,
        user: prompt.user,
        schema: kind === 'plan' ? PLAN_SCHEMA : TALK_SCHEMA,
        temperature: kind === 'plan' ? 0.7 : 0.9,
        maxTokens: kind === 'plan' ? 360 : 300,
      });
      const checked = kind === 'plan' ? validatePlan(out.value, allowed) : validateTalk(out.value);
      if (!checked.ok) throw new AIError('invalid_output', `Model output rejected: ${checked.error}`);
      stats.ok++;
      stats.lastModel = out.model;
      stats.lastMs = out.ms;
      return send(res, 200, { ok: true, kind, result: checked.value, dropped: checked.dropped ?? [], model: out.model, ms: out.ms });
    } catch (e) {
      const err = e instanceof AIError ? e : new AIError('unavailable', 'Unexpected failure');
      stats.failed++;
      stats.lastError = err.code;
      log(`[ai] ${kind} failed: ${err.code}${err.status ? ` (${err.status})` : ''}`);
      return send(res, STATUS_FOR[err.code] ?? 502, { ok: false, error: err.code });
    } finally {
      inflight--;
    }
  }

  async function handle(req, res, next) {
    const path = (req.url ?? '').split('?')[0];
    if (!path.startsWith('/api/ai/')) return next ? next() : send(res, 404, { ok: false, error: 'not_found' });
    if (crossSite(req)) return send(res, 403, { ok: false, error: 'forbidden' });
    try {
      if (path === '/api/ai/status' && req.method === 'GET') {
        return send(res, 200, {
          available: !!client,
          provider: client ? 'gemini' : 'none',
          model: stats.lastModel || (client ? client.models[0] : ''),
          reason: client ? '' : 'No GEMINI_API_KEY is configured on the server',
          calls: stats.calls,
          failed: stats.failed,
          lastError: stats.lastError,
        });
      }
      if (path === '/api/ai/leader' && req.method === 'POST') return await leader(req, res);
      return send(res, 404, { ok: false, error: 'not_found' });
    } catch {
      if (!res.headersSent) send(res, 500, { ok: false, error: 'unavailable' });
    }
  }

  return { handle, stats, available: !!client };
}
