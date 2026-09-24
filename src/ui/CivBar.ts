import type { Game } from '../game/Game';
import { CIV_SPEEDS, RELATION_LABEL, type CivSpeed } from '../civ/Civilization';
import { resyncing } from '../sim/Simulation';
import { civFood, civStored, eraOf } from '../sim/settlement';
import { PERSONAS } from '../civ/persona';
import { LANDMARK_INFO } from '../world/biomes';
import { escapeHtml, h, hex, setHtml } from './dom';

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

  constructor(private readonly game: Game) {
    this.panel.classList.add('hidden');
    this.panel.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
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
      if (home) {
        const c = this.game.controls;
        c.follow = null;
        c.jumpTo(home.x, home.z, 70);
        c.pitch = 0.75;
      }
    }
    this.game.session.terrainView.uniforms.uHighlight.value = id === null ? 0 : id + 1;
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
        return `<button class="cchip${this.selected === c.id ? ' on' : ''}${pop === 0 ? ' gone' : ''}" data-civ="${c.id}" style="--c:${hex(c.color)}"><span class="cdot"></span><span class="cname">${escapeHtml(c.name.replace(/^the /, ''))}</span><span class="cpop">${pop}</span>${sp}</button>`;
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
    const reqs = civ.requests.filter((r) => r.status === 'open').map((r) => `<div class="req">🙏 “${escapeHtml(r.text)}”</div>`).join('');
    const html = `
      <div class="ch" style="--c:${hex(civ.color)}"><span class="banner"></span><div><div class="cn">${escapeHtml(civ.name)}</div><div class="cp">the ${escapeHtml(civ.people)} · ${era} · ${mood}</div></div><button class="x" data-close>✕</button></div>
      <div class="ident">${escapeHtml(civ.def.identity)}</div>
      ${leader ? `<div class="leader" data-leader>👑 <b>${escapeHtml(leader.name)}</b> leads them, ${leader.persona.map((t) => PERSONAS[t].label.toLowerCase()).join(' and ')}. <u>Find</u></div>` : ''}
      ${civ.mind.lastSpeech ? `<div class="speech">“${escapeHtml(civ.mind.lastSpeech)}”</div>` : ''}
      ${reqs}
      <div class="stats"><span>👥 ${civ.population}</span><span>🏘 ${civ.settlements.length}</span><span>🍎 ${civFood(w, civ)}</span><span>🪵 ${civStored(w, civ, 'wood')}</span><span>🪨 ${civStored(w, civ, 'stone')}</span><span>💎 ${civStored(w, civ, 'crystal')}</span></div>
      <div class="sect">Speed of their time <span class="muted">· their day ${civ.day}, ${String(Math.floor(civ.hour)).padStart(2, '0')}:${String(Math.floor((civ.hour % 1) * 60)).padStart(2, '0')}${resyncing(civ, w.worldTime) ? ' · falling back into step with the sun' : ''}</span></div>
      <div class="cspeeds">${speeds}</div>
      <div class="sect">What they want</div><ul class="obj">${objectives}</ul>
      <div class="sect">Neighbours</div><div class="rels">${rels}</div>
      <div class="sect">How they see you <span class="muted">· ${escapeHtml(civ.godView)}</span></div>
      ${bar('Faith', civ.rep.faith, '#ffd66b')}${bar('Trust', civ.rep.trust, '#7fe0a8')}${bar('Fear', civ.rep.fear, '#a99cff')}${bar('Anger', civ.rep.anger, '#ff7b6b')}${bar('Awe', civ.rep.awe, '#8fd3ff')}
      <div class="sect">Known lands</div><div class="muted">${civ.knowledge.regions.size} regions · ${wonders.length ? escapeHtml(wonders.join(', ')) : 'no wonders yet'}</div>
      <div class="sect">Recent history</div><ul class="hist">${hist}</ul>`;
    if (force || !this.panel.contains(document.activeElement)) setHtml(this.panel, html);
  }
}
