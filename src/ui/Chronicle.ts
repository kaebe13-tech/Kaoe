import type { Game } from '../game/Game';
import { DAY_LENGTH } from '../world/config';
import { h, iconEl, escapeHtml } from './dom';
import { ICON_COLORS, icon } from './icons';

/** The tribe's history: notable events grouped by day. */
export class Chronicle {
  readonly el: HTMLElement;
  private readonly body = h('div.body');
  private readonly sub = h('div.sub');
  private open = false;

  constructor(private readonly game: Game) {
    const close = h('button.iconbtn', { onclick: () => this.toggle(false), title: 'Close (C)' });
    close.append(iconEl(icon('close')));
    this.el = h('div.chronicle.glass', {}, [h('h3', {}, [iconEl(icon('book')), 'Chronicle', close]), this.sub, this.body]);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.el.classList.toggle('open', this.open);
    if (this.open) this.render();
  }

  private render(): void {
    const w = this.game.world;
    const entries = w.chronicle;
    const s = w.stats;
    this.sub.textContent = `Day ${w.day} · ${w.living.length} living · ${s.births} born · ${s.deaths} lost · ${s.built} buildings raised`;
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
      html += `<div class="entry" data-i="${i}"><span class="t">${w.clockString(e.time)}</span><span class="icon" style="color:${col}">${icon(e.icon)}</span><span>${escapeHtml(e.text)}</span></div>`;
    }
    this.body.innerHTML = html;
    for (const row of this.body.querySelectorAll<HTMLElement>('.entry')) {
      row.onclick = () => {
        const e = entries[Number(row.dataset.i)];
        if (e && e.x !== undefined && e.z !== undefined) {
          this.game.controls.follow = null;
          this.game.controls.jumpTo(e.x, e.z, 30);
          this.toggle(false);
        }
      };
    }
  }
}
