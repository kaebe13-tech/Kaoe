// Minimal Gemini client for the leader backend. Runs only on the server: the API key is read
// from the environment by the caller and is only ever sent in a request header to Google.

import { parseModelJson } from '../shared/leaderProtocol.mjs';

export const DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3.5-flash'];
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** A failure with a stable code the browser can act on. Messages never contain secrets. */
export class AIError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {{ apiKey: string, models?: string[], fetchImpl?: typeof fetch, timeoutMs?: number, deadlineMs?: number, now?: () => number }} opts
 */
export function createGeminiClient(opts) {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('createGeminiClient needs an API key');
  const models = opts.models?.length ? opts.models : DEFAULT_MODELS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 12000;
  const deadlineMs = opts.deadlineMs ?? 20000;
  const now = opts.now ?? Date.now;
  /** Models that rejected thinkingConfig (older or lite models). */
  const noThinking = new Set();
  /** Model -> time until which we don't try it (overloaded, missing). */
  const resting = new Map();

  async function call(model, body, signal) {
    let res;
    try {
      res = await fetchImpl(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw new AIError('timeout', `${model} timed out`);
      throw new AIError('network', 'Could not reach the model service');
    }
    let text = '';
    try {
      text = await res.text();
    } catch {
      throw new AIError('network', 'The connection dropped while reading the reply', res.status);
    }
    if (!res.ok) {
      const s = res.status;
      if (s === 400) throw new AIError('bad_request', `${model} rejected the request`, s);
      if (s === 401 || s === 403) throw new AIError('auth', 'The model service refused the API key', s);
      if (s === 404) throw new AIError('model_missing', `${model} is not available`, s);
      if (s === 429) throw new AIError('rate_limited', `${model} is rate limited`, s);
      throw new AIError('unavailable', `${model} is unavailable (${s})`, s);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new AIError('malformed', 'The model service sent something that was not JSON');
    }
    const cand = data?.candidates?.[0];
    const parts = cand?.content?.parts;
    const out = Array.isArray(parts) ? parts.filter((p) => !p.thought).map((p) => (typeof p.text === 'string' ? p.text : '')).join('') : '';
    if (!out.trim()) throw new AIError('empty', cand?.finishReason ? `No text (${cand.finishReason})` : 'The model said nothing');
    const parsed = parseModelJson(out);
    if (!parsed.ok) throw new AIError(parsed.error === 'empty' ? 'empty' : 'malformed', 'The model reply was not valid JSON');
    return parsed.value;
  }

  return {
    models,
    /**
     * Ask for a JSON object matching `schema`. Tries each model in turn, skipping ones that
     * are resting, and retries once without thinkingConfig for models that refuse it.
     */
    async generate({ system, user, schema, temperature = 0.8, maxTokens = 400 }) {
      const started = now();
      let last = new AIError('unavailable', 'No model is available right now');
      for (const model of models) {
        if ((resting.get(model) ?? 0) > now()) continue;
        const remaining = deadlineMs - (now() - started);
        if (remaining < 1500) break;
        for (let attempt = 0; attempt < 2; attempt++) {
          const thinking = !noThinking.has(model);
          const body = {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: {
              temperature,
              maxOutputTokens: maxTokens,
              responseMimeType: 'application/json',
              responseSchema: schema,
              ...(thinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
            },
          };
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), Math.min(timeoutMs, remaining));
          try {
            const value = await call(model, body, ctl.signal);
            return { model, value, ms: now() - started };
          } catch (e) {
            last = e instanceof AIError ? e : new AIError('unavailable', 'Unexpected model failure');
            if (last.code === 'bad_request' && thinking && attempt === 0) {
              noThinking.add(model);
              continue;
            }
            if (last.code === 'auth' || last.code === 'network') throw last;
            if (last.code === 'model_missing') resting.set(model, now() + 3600_000);
            else if (last.code === 'rate_limited' || last.code === 'unavailable') resting.set(model, now() + 30_000);
            else if (last.code === 'timeout') resting.set(model, now() + 15_000);
            break;
          } finally {
            clearTimeout(timer);
          }
        }
      }
      throw last;
    },
  };
}
