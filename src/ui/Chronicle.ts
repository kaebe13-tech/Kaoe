import type { Game } from '../game/Game';
import { DAY_LENGTH } from '../world/config';
import { h, iconEl, escapeHtml, hex } from './dom';
import { ICON_COLORS, icon } from './icons';
import { PERSONAS } from '../civ/persona';
import type { HistoryEntry } from '../civ/Civilization';

const KIND_ICON: Record<HistoryEntry['kind'], string> = {
  founding: 'home',
  discovery: 'discovery',
  contact: 'contact',
  divine: 'divine',
  disaster: 'warning',
  leader: 'crown',
  building: 'build',
  growth: 'star',
  relation: 'social',
  death: 'death',
  objective: 'arrow',
};

/**
 * The chronicles: the world's notable events, and each people's own history, in their own
 * calendar (a people whose time ran fast has lived more days than the world).
 */
export class Chronicle {
  readonly el: HTMLElement;
  private readonly body = h('div.body');
  private readonly sub = h('div.sub');
  private readonly tabs = h('div.chtabs');
  private open = false;
  /** -1 = the world, otherwise a civ id. */
  private tab = -1;

  constructor(private readonly game: Game) {
    const close = h('button.iconbtn', { onclick: () => this.toggle(false), title: 'Close (C)' });
    close.append(iconEl(icon('close')));
    this.el = h('div.chronicle.glass', {}, [h('h3', {}, [iconEl(icon('book')), 'Chronicles', close]), this.tabs, this.sub, this.body]);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.tabs.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (!b) return;
      this.tab = Number(b.dataset.tab);
      this.render();
    });
    this.body.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-x]');
      if (!row) return;
      this.game.flyTo(Number(row.dataset.x), Number(row.dataset.z), 36, 0.75);
      this.toggle(false);
    });
  }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.el.classList.toggle('open', this.open);
    if (this.open) this.render();
  }

  /** Open straight onto one people's history. */
  showCiv(civId: number): void {
    this.tab = civId;
    this.toggle(true);
  }

  private render(): void {
    const w = this.game.world;
    if (this.tab >= w.civs.length) this.tab = -1;
    this.tabs.innerHTML =
      `<button data-tab="-1" class="${this.tab === -1 ? 'on' : ''}">The world</button>` +
      w.civs.map((c) => `<button data-tab="${c.id}" class="${this.tab === c.id ? 'on' : ''}" style="--c:${hex(c.color)}"><i></i>${escapeHtml(c.name.replace(/^the /, ''))}</button>`).join('');
    if (this.tab < 0) this.renderWorld();
    else this.renderCiv(this.tab);
  }

  private renderWorld(): void {
    const w = this.game.world;
    const entries = w.chronicle;
    const s = w.stats;
    this.sub.textContent = `World day ${w.worldDay} · ${w.living.length} living in ${w.civs.filter((c) => c.population > 0).length} peoples · ${s.births} born · ${s.deaths} lost · ${w.worldEventLog.length} great events`;
    if (!entries.length) {
      this.body.innerHTML = '<div class="empty">Nothing worth remembering has happened yet.</div>';
      return;
    }
    let html = '';
    let day = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      const d = Math.floor(e.time / DAY_LENGTH) + 1;
      if (d !== day) {
        day = d;
        html += `<div class="day">Day ${d}</div>`;
      }
      const col = e.icon === 'death' ? '#ff8fa3' : ICON_COLORS[e.icon] ?? '#f5c451';
      const civ = e.civId !== undefined ? w.civs[e.civId] : undefined;
      const tag = civ ? `<span class="ctag" style="--c:${hex(civ.color)}"></span>` : '';
      const at = e.x !== undefined && e.z !== undefined ? ` data-x="${e.x.toFixed(1)}" data-z="${e.z.toFixed(1)}"` : '';
      html += `<div class="entry"${at}><span class="t">${w.clockString(e.time)}</span><span class="icon" style="color:${col}">${icon(e.icon)}</span><span>${tag}${escapeHtml(e.text)}</span></div>`;
    }
    this.body.innerHTML = html;
  }

  private renderCiv(id: number): void {
    const w = this.game.world;
    const civ = w.civs[id]!;
    const leaders = civ.leaders.map((l) => `${escapeHtml(l.name)}${l.persona.length ? ` <i>(${l.persona.map((t) => PERSONAS[t].label.toLowerCase()).join(', ')})</i>` : ''}${l.to < 0 ? ' — now' : ''}`).join(' → ');
    this.sub.innerHTML = `${escapeHtml(civ.name)}, the ${escapeHtml(civ.people)} · their day ${civ.day} · ${civ.population} living · ${civ.stats.births} born · ${civ.stats.deaths} lost${leaders ? `<br>Leaders: ${leaders}` : ''}${civ.mind.summary ? `<br><span class="muted">${escapeHtml(civ.mind.summary.slice(-260))}</span>` : ''}`;
    if (!civ.history.length) {
      this.body.innerHTML = '<div class="empty">Their story has not begun yet.</div>';
      return;
    }
    let html = '';
    let day = -1;
    for (let i = civ.history.length - 1; i >= 0; i--) {
      const e = civ.history[i]!;
      if (e.day !== day) {
        day = e.day;
        html += `<div class="day">Their day ${e.day}</div>`;
      }
      const ic = KIND_ICON[e.kind] ?? 'dot';
      const col = e.kind === 'death' ? '#ff8fa3' : ICON_COLORS[ic] ?? '#f5c451';
      html += `<div class="entry imp${e.importance}"><span class="t">${e.importance === 3 ? '★' : ''}</span><span class="icon" style="color:${col}">${icon(ic)}</span><span>${escapeHtml(e.text)}</span></div>`;
    }
    this.body.innerHTML = html;
  }
}
