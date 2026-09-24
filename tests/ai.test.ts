import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cleanText, parseModelJson, sanitizeContext, validatePlan, validateTalk } from '../shared/leaderProtocol.mjs';
import { createLeaderApi } from '../server/leaderApi.mjs';
import { MockProvider, ProviderError, type MockMode } from '../src/mind/providers';
import { MindService } from '../src/mind/MindService';
import { World } from '../src/sim/World';
import { Simulation } from '../src/sim/Simulation';
import { SIM_DT } from '../src/world/config';
import { classifyIntent, godSpeaks, judgeCommand } from '../src/civ/dialogue';
import { leaderOf } from '../src/civ/civSystem';

const allowed = { regions: ['the Elderwood', 'the Ashen Waste'], civs: ['Emberreach'] };

describe('leader protocol validation', () => {
  it('accepts a well-formed plan and drops unknown fields', () => {
    const r = validatePlan({ speech: 'We go west.', priority: 'explore_region', reason: 'curious', targetRegion: 'elderwood', mood: 'curious', hack: 'rm -rf' }, allowed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.priority).toBe('EXPLORE_REGION');
    expect(r.value.targetRegion).toBe('the Elderwood');
    expect(r.dropped).toContain('hack');
  });

  it('rejects unknown actions outright', () => {
    expect(validatePlan({ speech: 'x', priority: 'LAUNCH_ARMIES', reason: 'y' }, allowed)).toEqual({ ok: false, error: 'unknown_action' });
    expect(validatePlan('not an object', allowed).ok).toBe(false);
    expect(validatePlan({ priority: 'REST' }, allowed)).toEqual({ ok: false, error: 'empty' });
  });

  it('never lets a plan name places or peoples that do not exist', () => {
    const r = validatePlan({ speech: 'Peace with the moon people.', priority: 'SEEK_PEACE', reason: 'r', targetCiv: 'Moonfolk', targetRegion: 'Atlantis' }, allowed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.targetCiv).toBeUndefined();
    expect(r.value.targetRegion).toBeUndefined();
    // A diplomatic aim with no real target becomes no action at all.
    expect(r.value.priority).toBe('NONE');
  });

  it('cleans text: no markup, no control characters, bounded length', () => {
    expect(cleanText('<script>alert(1)</script>\u0000hi', 100)).toBe('scriptalert(1)/script hi');
    expect(cleanText('a'.repeat(500), 20).length).toBe(20);
    const t = validateTalk({ speech: 'Hello `there`', mood: 'ELATED' });
    expect(t.ok && t.value.speech).toBe('Hello there');
    expect(t.ok && t.value.mood).toBeUndefined();
  });

  it('parses JSON wrapped in fences and rejects garbage', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseModelJson('no json here').ok).toBe(false);
    expect(parseModelJson('').ok).toBe(false);
  });

  it('bounds the context sent to a model', () => {
    const big = { civ: { name: 'x'.repeat(1000) }, memories: Array.from({ length: 200 }, (_, i) => `memory ${i} ${'y'.repeat(200)}`), evil: 'ignored' };
    const c = sanitizeContext(big)!;
    expect(c).not.toBeNull();
    expect('evil' in c).toBe(false);
    expect(JSON.stringify(c).length).toBeLessThanOrEqual(12000);
    expect((c.memories as string[]).length).toBeLessThanOrEqual(24);
  });
});

describe('mock providers cover every failure mode', () => {
  const req = { context: {}, allowed };
  const cases: Array<[MockMode, string | null]> = [
    ['success', null],
    ['invalid', 'invalid_output'],
    ['malformed', 'malformed'],
    ['rateLimit', 'rate_limited'],
    ['network', 'network'],
    ['empty', 'empty'],
    ['unavailable', 'unavailable'],
    ['off', 'unavailable'],
  ];
  for (const [mode, code] of cases) {
    it(`mode ${mode}`, async () => {
      const p = new MockProvider(mode, 1);
      if (code === null) {
        const r = await p.plan(req);
        expect(r.value.priority).toBe('EXPLORE_REGION');
      } else {
        await expect(p.plan(req)).rejects.toMatchObject({ code });
      }
    });
  }
  it('slow replies are cut off by the caller', async () => {
    const p = new MockProvider('slow', 1, 10000);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    await expect(p.plan(req, ctl.signal)).rejects.toBeInstanceOf(ProviderError);
  });
});

function world(seed = 11): { w: World; sim: Simulation } {
  const w = new World(seed);
  w.spawnCivilizations(4, 6);
  const sim = new Simulation(w);
  for (let i = 0; i < 40; i++) sim.step(SIM_DT);
  return { w, sim };
}

describe('mind service', () => {
  it('applies a validated plan and falls back to local on failure', async () => {
    const { w } = world();
    const mock = new MockProvider('success', 1);
    const mind = new MindService(() => w, mock);
    await mind.refresh();
    expect(mind.state).toBe('online');
    const civ = w.civs[0]!;
    mind.think(w, civ, 'test');
    await new Promise((r) => setTimeout(r, 30));
    expect(mock.calls).toBe(1);
    expect(civ.mind.planSource).toBe('ai');
    expect(civ.objectives.some((o) => o.kind === 'EXPLORE_REGION')).toBe(true);

    // A failing model never blocks anything: talk falls back to the local voice.
    mock.mode = 'network';
    const leader = leaderOf(w, civ);
    const reply = await mind.talk(w, civ, leader, 'leader', 'Hello', [], { intent: 'GENERAL', accept: true, reason: '' }, () => ({ speech: 'local words', mood: 'calm' }));
    expect(reply.source).toBe('local');
    expect(reply.speech).toBe('local words');
    expect(mind.state).toBe('offline');
  });

  it('does nothing when AI is off', async () => {
    const { w } = world();
    const mock = new MockProvider('success', 1);
    const mind = new MindService(() => w, mock);
    mind.enabled = false;
    await mind.refresh();
    mind.think(w, w.civs[0]!, 'test');
    expect(mock.calls).toBe(0);
    expect(mind.state).toBe('off');
  });

  it('discards a plan that arrives after the world was replaced', async () => {
    const { w } = world();
    let current = w;
    const mind = new MindService(() => current, new MockProvider('success', 1));
    const civ = w.civs[0]!;
    current = new World(99);
    expect(mind.applyPlan(w, civ, civ.leaderId!, { speech: 'x', priority: 'REST', reason: 'r' }, 'mock')).toBe(false);
  });
});

describe('talking to leaders', () => {
  it('classifies what the god says', () => {
    const { w } = world();
    const civ = w.civs[0]!;
    expect(classifyIntent(w, 'How are your people?', civ).intent).toBe('QUESTION');
    expect(classifyIntent(w, 'Build a shrine in my honour.', civ)).toMatchObject({ intent: 'COMMAND', objective: 'HONOR_GOD' });
    expect(classifyIntent(w, 'I will send you rain.', civ)).toMatchObject({ intent: 'PROMISE', promise: 'rain' });
    expect(classifyIntent(w, 'Obey or I will burn your village!', civ).intent).toBe('THREAT');
    expect(classifyIntent(w, 'I bless your people.', civ).intent).toBe('BLESSING');
    expect(classifyIntent(w, 'The sky is blue today', civ).intent).toBe('GENERAL');
  });

  it('decides obedience deterministically, and a devoted people obeys', () => {
    const { w } = world();
    const civ = w.civs[0]!;
    const p = classifyIntent(w, 'Gather food for the winter.', civ);
    const a = judgeCommand(w, civ, leaderOf(w, civ), p);
    const b = judgeCommand(w, civ, leaderOf(w, civ), p);
    expect(a).toEqual(b);
    civ.rep.faith = 0.95;
    civ.rep.trust = 0.9;
    const v = w.withCiv(civ, () => godSpeaks(w, civ, p, leaderOf(w, civ)));
    expect(v.accept).toBe(true);
    expect(civ.objectives.some((o) => o.kind === 'PRIORITIZE_FOOD' && o.source === 'god')).toBe(true);
    expect(civ.mind.commands.at(-1)?.accepted).toBe(true);
  });

  it('refuses what cannot be done', () => {
    const { w } = world();
    const civ = w.civs[0]!;
    civ.rep.faith = 1;
    const other = w.civs[1]!;
    const p = classifyIntent(w, `Make peace with ${other.name}.`, civ);
    const v = judgeCommand(w, civ, leaderOf(w, civ), p);
    expect(v.accept).toBe(false);
    expect(v.reason).toMatch(/never met/);
  });
});

async function withApi(opts: Parameters<typeof createLeaderApi>[0], fn: (base: string) => Promise<void>): Promise<void> {
  const api = createLeaderApi(opts);
  const srv = createServer((q, s) => void api.handle(q, s));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    srv.close();
  }
}

function fakeGemini(replies: Array<{ status: number; body?: unknown }>): { fetchImpl: typeof fetch; calls: Array<{ url: string; key: string | null; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; key: string | null; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, key: new Headers(init.headers).get('x-goog-api-key'), body: JSON.parse(String(init.body)) });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const modelText = (o: unknown) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] });
const post = (base: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/ai/leader`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const planBody = { kind: 'plan', context: { civ: { name: 'Hearthvale' }, allowed } };

describe('leader API (server)', () => {
  it('returns a validated plan, keeps the key server-side, and never echoes it', async () => {
    const g = fakeGemini([{ status: 200, body: modelText({ speech: 'We explore.', priority: 'EXPLORE_REGION', reason: 'r', mood: 'curious', targetRegion: 'the Elderwood' }) }]);
    await withApi({ apiKey: 'TEST-SECRET-KEY', fetchImpl: g.fetchImpl }, async (base) => {
      const res = await post(base, planBody);
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(JSON.parse(text).result.priority).toBe('EXPLORE_REGION');
      expect(text).not.toContain('TEST-SECRET-KEY');
      expect(g.calls[0]!.key).toBe('TEST-SECRET-KEY');
      expect(g.calls[0]!.url).not.toContain('TEST-SECRET-KEY');
      const st = await (await fetch(`${base}/api/ai/status`)).text();
      expect(st).not.toContain('TEST-SECRET-KEY');
      expect(JSON.parse(st).available).toBe(true);
    });
  });

  it('falls back to the next model when one is overloaded, and retries without thinking config', async () => {
    const g = fakeGemini([{ status: 503 }, { status: 400 }, { status: 200, body: modelText({ speech: 'Hi.', mood: 'calm' }) }]);
    await withApi({ apiKey: 'k', fetchImpl: g.fetchImpl, models: ['m1', 'm2'] }, async (base) => {
      const res = await post(base, { kind: 'talk', context: { civ: { name: 'A' } }, message: 'hello' });
      expect(res.status).toBe(200);
      expect(g.calls[0]!.url).toContain('/m1:');
      expect(g.calls[1]!.url).toContain('/m2:');
      expect(g.calls[1]!.body.generationConfig).toHaveProperty('thinkingConfig');
      expect(g.calls[2]!.body.generationConfig).not.toHaveProperty('thinkingConfig');
    });
  });

  it('rejects invalid model output instead of passing it on', async () => {
    const g = fakeGemini([{ status: 200, body: modelText({ speech: 'x', priority: 'DELETE_WORLD', reason: 'r' }) }]);
    await withApi({ apiKey: 'k', fetchImpl: g.fetchImpl, models: ['m1'] }, async (base) => {
      const res = await post(base, planBody);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe('invalid_output');
    });
  });

  it('maps a refused key, malformed replies and missing keys to clear errors', async () => {
    await withApi({ apiKey: 'k', fetchImpl: fakeGemini([{ status: 403 }]).fetchImpl, models: ['m1'] }, async (base) => {
      expect((await (await post(base, planBody)).json()).error).toBe('auth');
    });
    const bad = (async () => new Response('{"candidates":[{"content":{"parts":[{"text":"not json at all"}]}}]}', { status: 200 })) as unknown as typeof fetch;
    await withApi({ apiKey: 'k', fetchImpl: bad, models: ['m1'] }, async (base) => {
      expect((await (await post(base, planBody)).json()).error).toBe('malformed');
    });
    await withApi({}, async (base) => {
      const res = await post(base, planBody);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('disabled');
    });
  });

  it('refuses other sites, bad requests and floods', async () => {
    const g = fakeGemini([{ status: 200, body: modelText({ speech: 'Hi.', mood: 'calm' }) }]);
    await withApi({ apiKey: 'k', fetchImpl: g.fetchImpl, perClientPerMinute: 3 }, async (base) => {
      expect((await post(base, planBody, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await post(base, { kind: 'shell', context: {} })).status).toBe(400);
      const talk = { kind: 'talk', context: { civ: { name: 'A' } }, message: 'hi' };
      expect((await post(base, talk)).status).toBe(200);
      expect((await post(base, talk)).status).toBe(200);
      expect((await post(base, talk)).status).toBe(429);
    });
  });
});
