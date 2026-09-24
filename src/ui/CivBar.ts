import type { Game } from '../game/Game';
import { CIV_SPEEDS, RELATION_LABEL, type CivSpeed } from '../civ/Civilization';
import { resyncing } from '../sim/Simulation';
import { civFood, civStored, eraOf, eraProgress, sitesOf } from '../sim/settlement';
import { MAX_CIV_POPULATION } from '../sim/family';
import { BLUEPRINTS } from '../sim/blueprints';
import { PERSONAS } from '../civ/persona';
import { LANDMARK_INFO } from '../world/biomes';
import { escapeHtml, h, hex, setHtml } from './dom';
import { DAY_LENGTH } from '../world/config';

const SPEED_LABEL = (s: number) => (s === 0 ? '❚❚' : s < 1 ? `${s}×`.replace('0.', '.') : `${s}×`);

/**
 * Civilization bar (top centre) and civilization panel. Click a people to see who they are,
 * how they are doing and what they want; change the speed of their time; fly to their home.
 */
export class CivBar {
  readonly el = h('div.civbar');
  readonly panel = h('div.civpanel.glass');
  private selected: number | null = null;
  private refresh = 0;
  /** Speak to a people's leader; open their history; answer a prayer (set by the UI/app). */
  onTalk: ((civId: number) => void) | null = null;
  onHistory: ((civId: number) => void) | null = null;
  onAnswer: ((civId: number, reqId: number, grant: boolean) => void) | null = null;

  constructor(private readonly game: Game) {
    this.panel.classList.add('hidden');
    game.events.on('civClick', (id) => this.select(id));
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.panel.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const ans = t.closest<HTMLElement>('[data-answer]');
      if (ans && this.selected !== null) {
        this.onAnswer?.(this.selected, Number(ans.dataset.req), ans.dataset.answer === 'grant');
        this.render(true);
        return;
      }
      const go = t.closest<HTMLElement>('[data-goto]');
      if (go) {
        const [x, z] = (go.dataset.goto ?? '0,0').split(',').map(Number);
        this.game.flyTo(x!, z!, 40, 0.8);
        return;
      }
      if (t.closest('[data-talk]') && this.selected !== null) {
        this.onTalk?.(this.selected);
        return;
      }
      if (t.closest('[data-history]') && this.selected !== null) {
        this.onHistory?.(this.selected);
        return;
      }
      const sp = t.closest<HTMLElement>('[data-speed]');
      if (sp && this.selected !== null) {
        const civ = this.game.world.civs[this.selected];
        if (civ) civ.speed = Number(sp.dataset.speed) as CivSpeed;
        this.render(true);
        return;
      }
      if (t.closest('[data-close]')) this.select(null);
      if (t.closest('[data-leader]') && this.selected !== null) {
        const civ = this.game.world.civs[this.selected];
        const l = civ ? this.game.world.agent(civ.leaderId) : undefined;
        if (l && l.alive) {
          this.game.select(l.id);
          this.game.follow(l.id);
        }
      }
    });
  }

  select(id: number | null): void {
    this.selected = id;
    this.panel.classList.toggle('hidden', id === null);
    document.body.classList.toggle('civ-open', id !== null);
    if (id !== null) {
      const civ = this.game.world.civs[id];
      const home = civ?.capital;
      if (home) this.game.flyTo(home.x, home.z, 80, 0.8);
    }
    this.game.highlightCiv = id;
    this.render(true);
  }

  update(dt: number): void {
    this.refresh -= dt;
    if (this.refresh > 0) return;
    this.refresh = 0.4;
    this.render(false);
  }

  private render(force: boolean): void {
    const w = this.game.world;
    const chips = w.civs
      .map((c) => {
        const pop = c.population;
        const sp = c.speed === 1 ? '' : `<span class="cspd">${SPEED_LABEL(c.speed)}</span>`;
        const ep = c.capital ? eraProgress(w, c.capital.id) : null;
        const tip = ep ? (ep.next ? `${ep.era} → ${ep.next}: ${Math.round(ep.frac * 100)}% (needs ${ep.need})` : `${ep.era}: fully grown`) : '';
        const prog = ep ? `<span class="cprog" title="${escapeHtml(tip)}"><i style="width:${Math.round(ep.frac * 100)}%"></i></span>` : '';
        return `<button class="cchip${this.selected === c.id ? ' on' : ''}${pop === 0 ? ' gone' : ''}" data-civ="${c.id}" style="--c:${hex(c.color)}" title="${escapeHtml(tip)}"><span class="cdot"></span><span class="cname">${escapeHtml(c.name.replace(/^the /, ''))}</span><span class="cpop">${pop}</span>${sp}${prog}</button>`;
      })
      .join('');
    setHtml(this.el, chips);
    for (const b of this.el.querySelectorAll<HTMLElement>('[data-civ]')) {
      b.onclick = () => {
        const id = Number(b.dataset.civ);
        this.select(this.selected === id ? null : id);
      };
    }
    if (this.selected === null) return;
    const civ = w.civs[this.selected];
    if (!civ) return;
    const leader = w.agent(civ.leaderId);
    const cap = civ.capital;
    const era = cap ? eraOf(w, cap.id) : 'Camp';
    const living = civ.living;
    const thriving = living.length ? living.reduce((s, a) => s + Math.min(a.needs.hunger, a.needs.thirst, a.needs.health, a.needs.safety), 0) / living.length : 0;
    const mood = thriving > 0.6 ? 'Thriving' : thriving > 0.4 ? 'Getting by' : thriving > 0.2 ? 'Struggling' : 'Desperate';
    const bar = (label: string, v: number, col: string) => `<div class="rep"><span>${label}</span><i><b style="width:${Math.round(v * 100)}%;background:${col}"></b></i></div>`;
    const rels = [...civ.relations.values()]
      .filter((r) => r.state !== 'unknown')
      .map((r) => `<span class="rel ${r.state}">${escapeHtml(w.civs[r.civId]!.name.replace(/^the /, ''))}: ${RELATION_LABEL[r.state]}</span>`)
      .join('') || '<span class="muted">They have met no other people yet</span>';
    const objectives = civ.objectives.map((o) => `<li><b>${o.kind.replace(/_/g, ' ').toLowerCase()}</b> ${escapeHtml(o.reason)}</li>`).join('') || '<li class="muted">No particular plans</li>';
    const hist = civ.history.slice(-5).reverse().map((e) => `<li><span class="d">Day ${e.day}</span> ${escapeHtml(e.text)}</li>`).join('');
    const speeds = CIV_SPEEDS.map((s) => `<button data-speed="${s}" class="${civ.speed === s ? 'on' : ''}">${SPEED_LABEL(s)}</button>`).join('');
    const wonders = [...civ.knowledge.landmarks].map((id) => w.terrain.landmarks.find((l) => l.id === id)).filter(Boolean).map((l) => LANDMARK_INFO[l!.kind].title);
    const reqs = civ.requests
      .filter((r) => r.status === 'open')
      .map((r) => {
        const by = w.agent(r.by);
        const left = Math.max(0, (r.expires - w.worldTime) / (DAY_LENGTH / 24));
        return `<div class="req"><div>🙏 <b>${escapeHtml(by?.name ?? 'They')}</b> prays: “${escapeHtml(r.text)}”</div><div class="reqa"><button data-answer="grant" data-req="${r.id}">Grant</button><button data-answer="refuse" data-req="${r.id}">Refuse</button><button data-goto="${r.x.toFixed(1)},${r.z.toFixed(1)}">Go there</button><span class="muted">${left < 1 ? 'less than an hour left' : `${Math.round(left)} h left`}</span></div></div>`;
      })
      .join('');
    const done = civ.requests.filter((r) => r.status !== 'open').slice(-3).reverse().map((r) => `<li><span class="rs ${r.status}">${r.status}</span> ${escapeHtml(r.text)}</li>`).join('');
    const promises = (civ.mind.promises ?? []).slice(-3).reverse().map((p) => `<li><span class="rs ${p.status === 'kept' ? 'granted' : p.status === 'broken' ? 'refused' : 'open'}">${p.status === 'open' ? 'promised' : p.status}</span> ${escapeHtml(p.text)}</li>`).join('');
    const commands = civ.mind.commands.slice(-3).reverse().map((c) => `<li><span class="rs ${c.accepted ? 'granted' : 'refused'}">${c.accepted ? 'obeyed' : 'refused'}</span> ${escapeHtml(c.text)}</li>`).join('');
    // Progress: the road to the next era, and how far along their efforts are.
    const pbar = (label: string, v: number, col: string, text: string) => `<div class="pb"><div class="pbt"><span>${label}</span><span>${escapeHtml(text)}</span></div><i><b style="width:${Math.round(Math.max(0, Math.min(1, v)) * 100)}%;background:${col}"></b></i></div>`;
    const ep = cap ? eraProgress(w, cap.id) : null;
    const regions = w.terrain.regions.length || 1;
    const food = civFood(w, civ);
    const want = Math.max(1, civ.population * 5);
    const site = cap ? sitesOf(w, cap.id)[0] : undefined;
    const goal = civ.objectives[civ.objectives.length - 1];
    let goalBar = '';
    if (goal) {
      const left = Math.max(0, goal.until - w.worldTime);
      const span = Math.max(1, goal.until - goal.since);
      goalBar = pbar(`Goal: ${goal.kind.replace(/_/g, ' ').toLowerCase()}`, 1 - left / span, '#8fd3ff', goal.status || `${Math.ceil(left / 20)} h left`);
    }
    const progress = [
      ep ? pbar(ep.next ? `${ep.era} → ${ep.next}` : ep.era, ep.frac, '#f2c46b', ep.next ? `${Math.round(ep.frac * 100)}% · needs ${ep.need}` : 'fully grown') : '',
      site ? pbar(`Building: ${BLUEPRINTS[site.kind].name.toLowerCase()}`, site.progress, '#d49a5c', `${Math.round(site.progress * 100)}%`) : '',
      pbar('Food stores', food / want, '#ff7b6b', `${food} / ${want}`),
      pbar('Explored', civ.knowledge.regions.size / regions, '#8ee6d0', `${civ.knowledge.regions.size} of ${regions} lands`),
      pbar('People', civ.population / MAX_CIV_POPULATION, '#f5c451', `${civ.population} / ${MAX_CIV_POPULATION}`),
      goalBar,
    ].join('');
    const mindSrc = civ.mind.planSource === 'ai' ? '<span class="aitag">✦ AI mind</span>' : '<span class="aitag local">local mind</span>';
    const html = `
      <div class="ch" style="--c:${hex(civ.color)}"><span class="banner"></span><div><div class="cn">${escapeHtml(civ.name)}</div><div class="cp">the ${escapeHtml(civ.people)} · ${era} · ${mood}</div></div><button class="x" data-close>✕</button></div>
      <div class="ident">${escapeHtml(civ.def.identity)}</div>
      ${leader ? `<div class="leader" data-leader>👑 <b>${escapeHtml(leader.name)}</b> leads them, ${leader.persona.map((t) => PERSONAS[t].label.toLowerCase()).join(' and ')}. <u>Find</u> ${mindSrc}</div>` : '<div class="leader muted">They have no leader right now.</div>'}
      ${civ.mind.lastSpeech ? `<div class="speech">“${escapeHtml(civ.mind.lastSpeech)}”${civ.mind.mood ? `<span class="mood">${escapeHtml(civ.mind.mood)}</span>` : ''}</div>` : ''}
      <div class="cactions"><button data-talk ${leader ? '' : 'disabled'}>💬 Speak to ${escapeHtml(leader?.name ?? 'their leader')}</button><button data-history>📜 History</button></div>
      ${reqs}
      <div class="stats"><span>👥 ${civ.population}</span><span>🏘 ${civ.settlements.length}</span><span>🍎 ${civFood(w, civ)}</span><span>🪵 ${civStored(w, civ, 'wood')}</span><span>🪨 ${civStored(w, civ, 'stone')}</span><span>💎 ${civStored(w, civ, 'crystal')}</span></div>
      <div class="sect">Progress</div><div class="progress">${progress}</div>
      <div class="sect">Speed of their time <span class="muted">· their day ${civ.day}, ${String(Math.floor(civ.hour)).padStart(2, '0')}:${String(Math.floor((civ.hour % 1) * 60)).padStart(2, '0')}${resyncing(civ, w.worldTime) ? ' · falling back into step with the sun' : ''}</span></div>
      <div class="cspeeds">${speeds}</div>
      <div class="sect">What they want</div><ul class="obj">${objectives}</ul>
      <div class="sect">Neighbours</div><div class="rels">${rels}</div>
      <div class="sect">How they see you <span class="muted">· ${escapeHtml(civ.godView)}</span></div>
      ${bar('Faith', civ.rep.faith, '#ffd66b')}${bar('Trust', civ.rep.trust, '#7fe0a8')}${bar('Fear', civ.rep.fear, '#a99cff')}${bar('Anger', civ.rep.anger, '#ff7b6b')}${bar('Awe', civ.rep.awe, '#8fd3ff')}
      ${done || promises || commands ? `<div class="sect">Between you</div><ul class="obj">${commands}${promises}${done}</ul>` : ''}
      <div class="sect">Known lands</div><div class="muted">${civ.knowledge.regions.size} regions · ${wonders.length ? escapeHtml(wonders.join(', ')) : 'no wonders yet'}</div>
      <div class="sect">Recent history</div><ul class="hist">${hist}</ul>`;
    if (force || !this.panel.contains(document.activeElement)) setHtml(this.panel, html);
  }
}
