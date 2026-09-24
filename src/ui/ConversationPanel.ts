import type { Game } from '../game/Game';
import type { Agent } from '../agents/Agent';
import type { Civilization } from '../civ/Civilization';
import type { MindService } from '../mind/MindService';
import { RELATION_LABEL } from '../civ/Civilization';
import { leaderOf } from '../civ/civSystem';
import { say } from '../civ/leader';
import { classifyIntent, godSpeaks, leaderReply, villagerHears, villagerReply, type Parsed, type Verdict } from '../civ/dialogue';
import { personaText } from '../civ/persona';
import { mood as moodOf } from './agentInfo';
import { drawPortrait } from './portrait';
import { escapeHtml, h, hex, setHtml, setText } from './dom';
import { LIMITS, type HistoryTurn } from '../../shared/leaderProtocol.mjs';

interface Turn {
  from: 'god' | 'them' | 'note';
  text: string;
  intent?: Parsed['intent'];
  verdict?: Verdict;
  source?: 'ai' | 'local';
  model?: string;
  mood?: string;
}

type Target = { kind: 'agent'; id: number } | { kind: 'leader'; civId: number };

const INTENT_LABEL: Record<Parsed['intent'], string> = {
  QUESTION: 'Question',
  COMMAND: 'Command',
  PROMISE: 'Promise',
  THREAT: 'Threat',
  BLESSING: 'Blessing',
  GENERAL: 'Words',
};

const SUGGEST_LEADER = ['How are your people?', 'Build a shrine in my honour.', 'Explore the far lands.', 'Make peace with your neighbours.', 'I will send you rain.', 'I bless your people.'];
const SUGGEST_VILLAGER = ['Who are you?', 'What are you doing?', 'Are you afraid of me?', 'I bless you, child.'];

/**
 * Speak as the god. A panel with the person's portrait, who they are, how their people feel
 * about you, and the conversation. Minimise it to keep watching; it keeps its history.
 */
export class ConversationPanel {
  readonly el = h('div.convo.glass');
  readonly pill = h('button.convo-pill.glass');
  private readonly portrait = h('canvas', { width: 128, height: 128 }) as HTMLCanvasElement;
  private readonly pillPortrait = h('canvas', { width: 64, height: 64 }) as HTMLCanvasElement;
  private readonly nameEl = h('div.cv-name');
  private readonly subEl = h('div.cv-sub');
  private readonly indicators = h('div.cv-ind');
  private readonly logEl = h('div.cv-log');
  private readonly input = h('textarea', { rows: 1, maxlength: LIMITS.message, placeholder: 'Speak as the god…' }) as HTMLTextAreaElement;
  private readonly sendBtn = h('button.cv-send', { title: 'Speak (Enter)' }, 'Speak') as HTMLButtonElement;
  private readonly chips = h('div.cv-chips');
  private readonly srcEl = h('div.cv-src');
  private target: Target | null = null;
  private readonly threads = new Map<string, Turn[]>();
  private waiting = false;
  private minimized = false;
  private refresh = 0;
  private portraitKey = '';

  constructor(
    private readonly game: Game,
    private readonly mind: MindService,
    private readonly sayBubble: (agentId: number, text: string) => void,
  ) {
    const min = h('button.iconbtn', { title: 'Minimise', onclick: () => this.minimize() }, '–');
    const close = h('button.iconbtn', { title: 'End conversation', onclick: () => this.close() }, '✕');
    const find = h('button.iconbtn', { title: 'Look at them', onclick: () => this.lookAt() }, '◎');
    const head = h('div.cv-head', {}, [h('div.cv-portrait', {}, [this.portrait]), h('div.cv-who', {}, [this.nameEl, this.subEl]), h('div.cv-btns', {}, [find, min, close])]);
    const form = h('div.cv-form', {}, [this.input, this.sendBtn]);
    this.el.append(head, this.indicators, this.logEl, this.chips, form, this.srcEl);
    this.el.classList.add('hidden');
    this.pill.classList.add('hidden');
    this.pill.append(this.pillPortrait, h('span'));
    this.pill.addEventListener('click', () => this.restore());
    this.sendBtn.addEventListener('click', () => void this.send());
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      } else if (e.key === 'Escape') {
        this.input.blur();
      }
    });
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(96, this.input.scrollHeight)}px`;
    });
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.chips.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-say]');
      if (!t) return;
      this.input.value = t.dataset.say ?? '';
      this.input.focus();
    });
    mind.events.on('status', () => this.renderSource());
  }

  get isOpen(): boolean {
    return this.target !== null && !this.minimized;
  }

  /** Start (or resume) a conversation with a person. */
  talkTo(agentId: number): void {
    const a = this.game.world.agent(agentId);
    if (!a || !a.alive) return;
    const civ = this.game.world.civOf(a);
    if (civ && civ.leaderId === a.id) this.open({ kind: 'leader', civId: civ.id });
    else this.open({ kind: 'agent', id: agentId });
  }

  talkToLeader(civId: number): void {
    this.open({ kind: 'leader', civId });
  }

  private key(t: Target): string {
    return t.kind === 'agent' ? `a${t.id}` : `c${t.civId}`;
  }

  private open(t: Target): void {
    this.target = t;
    this.minimized = false;
    this.el.classList.remove('hidden');
    this.pill.classList.add('hidden');
    document.body.classList.add('convo-open');
    if (!this.threads.has(this.key(t))) this.threads.set(this.key(t), []);
    this.portraitKey = '';
    this.render();
    this.renderSource();
    setTimeout(() => this.input.focus(), 30);
  }

  close(): void {
    this.target = null;
    this.el.classList.add('hidden');
    this.pill.classList.add('hidden');
    document.body.classList.remove('convo-open');
  }

  minimize(): void {
    if (!this.target) return;
    this.minimized = true;
    this.el.classList.add('hidden');
    this.pill.classList.remove('hidden');
    document.body.classList.remove('convo-open');
    this.render();
  }

  restore(): void {
    if (!this.target) return;
    this.minimized = false;
    this.el.classList.remove('hidden');
    this.pill.classList.add('hidden');
    document.body.classList.add('convo-open');
    this.render();
    setTimeout(() => this.input.focus(), 30);
  }

  /** The world was replaced: forget conversations about people who no longer exist. */
  reset(): void {
    this.threads.clear();
    this.close();
  }

  private resolve(): { civ: Civilization | undefined; who: Agent | undefined; role: 'leader' | 'villager' } {
    const w = this.game.world;
    const t = this.target;
    if (!t) return { civ: undefined, who: undefined, role: 'villager' };
    if (t.kind === 'leader') {
      const civ = w.civs[t.civId];
      return { civ, who: civ ? leaderOf(w, civ) : undefined, role: 'leader' };
    }
    const who = w.agent(t.id);
    return { civ: w.civOf(who), who, role: 'villager' };
  }

  private lookAt(): void {
    const { who } = this.resolve();
    if (!who) return;
    this.game.select(who.id);
    this.game.flyTo(who.x, who.z, 16);
  }

  private async send(): Promise<void> {
    const text = this.input.value.trim().slice(0, LIMITS.message);
    if (!text || this.waiting || !this.target) return;
    const w = this.game.world;
    const { civ, who, role } = this.resolve();
    if (!civ || !who || !who.alive) {
      this.push({ from: 'note', text: role === 'leader' ? 'They have no leader to answer you right now.' : 'There is no one left to hear you.' });
      return;
    }
    this.input.value = '';
    this.input.style.height = 'auto';
    const thread = this.threads.get(this.key(this.target))!;
    const parsed = classifyIntent(w, text, civ);
    let verdict: Verdict;
    if (role === 'leader') verdict = w.withCiv(civ, () => godSpeaks(w, civ, parsed, who));
    else {
      w.withCiv(civ, () => villagerHears(w, who, parsed));
      verdict = { intent: parsed.intent, accept: parsed.intent !== 'COMMAND', reason: parsed.intent === 'COMMAND' ? 'an ordinary villager cannot command the people' : '' };
    }
    const godTurn: Turn = { from: 'god', text, intent: parsed.intent, verdict: parsed.intent === 'COMMAND' || parsed.objective ? verdict : undefined };
    this.push(godTurn);
    this.game.session.effects.divineLight(who.x, who.z);
    const history: HistoryTurn[] = thread.filter((t) => t.from !== 'note').slice(-LIMITS.history - 1, -1).map((t) => ({ from: t.from === 'god' ? 'god' : 'them', text: t.text }));
    const local = () => (role === 'leader' ? leaderReply(w, civ, who, parsed, verdict) : villagerReply(w, who, parsed));
    this.waiting = true;
    this.renderLog();
    const reply = await this.mind.talk(w, civ, who, role, text, history, verdict, local);
    this.waiting = false;
    if (this.game.world !== w) return;
    thread.push({ from: 'them', text: reply.speech, source: reply.source, model: reply.model, mood: reply.mood });
    if (thread.length > 40) thread.splice(0, thread.length - 40);
    if (who.alive) {
      who.thought = reply.speech;
      this.sayBubble(who.id, reply.speech);
      if (role === 'leader') say(w, civ, reply.speech, reply.mood);
    }
    this.renderLog();
  }

  private push(t: Turn): void {
    if (!this.target) return;
    const thread = this.threads.get(this.key(this.target))!;
    thread.push(t);
    this.renderLog();
  }

  update(dt: number): void {
    if (!this.target) return;
    this.refresh -= dt;
    if (this.refresh > 0) return;
    this.refresh = 0.5;
    this.render();
  }

  private render(): void {
    const w = this.game.world;
    const { civ, who, role } = this.resolve();
    const banner = civ?.color ?? 0xd9a441;
    const leader = role === 'leader';
    if (who) {
      const key = `${who.id}:${leader}:${banner}`;
      if (key !== this.portraitKey) {
        this.portraitKey = key;
        drawPortrait(this.portrait, who, banner, leader);
        drawPortrait(this.pillPortrait, who, banner, leader);
      }
    }
    this.el.style.setProperty('--c', hex(banner));
    const name = who?.name ?? (leader ? 'No leader' : 'Nobody');
    setText(this.nameEl, name);
    (this.pill.lastChild as HTMLElement).textContent = `${name}${this.waiting ? ' · …' : ''}`;
    if (!civ) return;
    if (leader) {
      setText(this.subEl, who ? `Leader of ${civ.name} · ${personaText(who.persona)}` : `${civ.name} has no leader right now`);
      const r = civ.rep;
      const bar = (label: string, v: number, col: string) => `<span class="cvb" title="${label} ${Math.round(v * 100)}%"><i style="width:${Math.round(v * 100)}%;background:${col}"></i><b>${label}</b></span>`;
      const rels = [...civ.relations.values()].filter((x) => x.state !== 'unknown').map((x) => `<span class="rel ${x.state}">${escapeHtml(w.civs[x.civId]!.name.replace(/^the /, ''))}: ${RELATION_LABEL[x.state]}</span>`).join('');
      setHtml(
        this.indicators,
        `<div class="cv-bars">${bar('Faith', r.faith, '#ffd66b')}${bar('Trust', r.trust, '#7fe0a8')}${bar('Fear', r.fear, '#a99cff')}${bar('Anger', r.anger, '#ff7b6b')}${bar('Awe', r.awe, '#8fd3ff')}</div><div class="cv-view">They see you as ${escapeHtml(civ.godView)}.${civ.mind.mood ? ` Mood: ${escapeHtml(civ.mind.mood)}.` : ''}</div>${rels ? `<div class="cv-rels">${rels}</div>` : ''}`,
      );
      this.chips.innerHTML = SUGGEST_LEADER.map((s) => `<button data-say="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('');
    } else if (who) {
      const age = Math.floor(who.age);
      setText(this.subEl, `${who.isChild ? `Child of ${civ.name}, ${age}` : `${age}, of ${civ.name}`} · ${moodOf(who).text}`);
      const f = who.faith;
      setHtml(
        this.indicators,
        `<div class="cv-bars"><span class="cvb"><i style="width:${Math.round(f * 100)}%;background:#ffd66b"></i><b>Faith</b></span><span class="cvb"><i style="width:${Math.round(who.needs.safety * 100)}%;background:#7fe0a8"></i><b>Safety</b></span></div><div class="cv-view">${f > 0.5 ? 'Believes in you deeply.' : f > 0.2 ? 'Half believes someone is up there.' : 'Has never really believed in the sky.'} ${escapeHtml(civ.name)} see you as ${escapeHtml(civ.godView)}.</div>`,
      );
      this.chips.innerHTML = SUGGEST_VILLAGER.map((s) => `<button data-say="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('');
    }
    if (who && !who.alive && !this.waiting) {
      const thread = this.threads.get(this.key(this.target!))!;
      if (!thread.some((t) => t.from === 'note' && t.text.includes('died'))) this.push({ from: 'note', text: `${who.name} has died.` });
    }
    this.renderLog();
  }

  private renderLog(): void {
    if (!this.target) return;
    const thread = this.threads.get(this.key(this.target)) ?? [];
    const { who, civ, role } = this.resolve();
    const empty = `<div class="cv-empty">${role === 'leader' ? `Your voice will carry across ${escapeHtml(civ?.name ?? 'their lands')}. Ask, command, promise, bless or threaten: ${escapeHtml(who?.name ?? 'the leader')} decides how the people answer.` : `${escapeHtml(who?.name ?? 'They')} will hear a voice from the sky.`}</div>`;
    const rows = thread
      .map((t) => {
        if (t.from === 'note') return `<div class="cv-note">${escapeHtml(t.text)}</div>`;
        if (t.from === 'god') {
          const v = t.verdict;
          const tag = t.intent ? `<span class="cv-intent i-${t.intent.toLowerCase()}">${INTENT_LABEL[t.intent]}${v ? (v.accept ? ' · obeyed' : ' · refused') : ''}</span>` : '';
          return `<div class="cv-msg god"><div class="cv-bubble">${escapeHtml(t.text)}</div>${tag}${v && !v.accept && v.reason ? `<div class="cv-why">They refuse: ${escapeHtml(v.reason)}.</div>` : ''}</div>`;
        }
        const src = t.source === 'ai' ? `<span class="cv-tag ai" title="${escapeHtml(t.model ?? '')}">✦ ${escapeHtml(t.model ?? 'AI')}</span>` : '<span class="cv-tag">local mind</span>';
        return `<div class="cv-msg them"><div class="cv-bubble">${escapeHtml(t.text)}</div><div class="cv-meta">${t.mood ? `${escapeHtml(t.mood)} · ` : ''}${src}</div></div>`;
      })
      .join('');
    const typing = this.waiting ? `<div class="cv-msg them"><div class="cv-bubble typing"><i></i><i></i><i></i></div></div>` : '';
    const html = (rows || empty) + typing;
    if ((this.logEl as HTMLElement & { _h?: string })._h !== html) {
      (this.logEl as HTMLElement & { _h?: string })._h = html;
      this.logEl.innerHTML = html;
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
    this.sendBtn.disabled = this.waiting;
  }

  private renderSource(): void {
    const m = this.mind;
    const dot = m.online ? 'on' : m.state === 'checking' ? 'wait' : 'off';
    setHtml(this.srcEl, `<span class="dot ${dot}"></span>${m.online ? `Voices by ${escapeHtml(m.sourceLabel)}` : 'Voices by local minds'}`);
    this.srcEl.title = m.statusText;
  }
}
