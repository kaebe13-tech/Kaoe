import { Vector3 } from 'three';
import type { Game } from '../game/Game';
import { h, setHtml } from './dom';
import { ICON_COLORS, icon } from './icons';
import { activityText } from './agentInfo';

interface Label {
  el: HTMLElement;
  bubble: HTMLElement;
  name: HTMLElement;
  lastIcon: string;
  lastEmote: number;
}

const _v = new Vector3();

/** Floating intent bubbles above heads, plus names for hovered/selected humans. */
export class WorldLabels {
  readonly el = h('div.labels');
  private readonly labels = new Map<number, Label>();
  showAll = true;

  constructor(private readonly game: Game) {}

  reset(): void {
    for (const l of this.labels.values()) l.el.remove();
    this.labels.clear();
  }

  update(): void {
    const g = this.game;
    const w = g.world;
    const rect = g.renderer.domElement.getBoundingClientRect();
    const camDist = g.controls.currentDistance;
    const seen = new Set<number>();
    for (const a of w.agents) {
      const p = g.session.humans.positionOf(a.id);
      let l = this.labels.get(a.id);
      if (!p || a.buried) {
        if (l) l.el.classList.add('hidden');
        continue;
      }
      if (!l) {
        const bubble = h('div.bubble');
        const name = h('div.name');
        const el = h('div.lbl', {}, [name, bubble, h('div.tail')]);
        this.el.append(el);
        l = { el, bubble, name, lastIcon: '', lastEmote: 0 };
        this.labels.set(a.id, l);
      }
      seen.add(a.id);
      const lying = a.anim === 'sleep' || a.anim === 'dead' || a.anim === 'knocked';
      _v.set(p.x, p.y + (lying ? 0.9 : 1.75) * a.look.height, p.z).project(g.camera);
      const dist = g.camera.position.distanceTo(p);
      const sel = g.selectedId === a.id;
      const hov = g.hoveredId === a.id;
      const visible = _v.z < 1 && (sel || hov || (this.showAll && dist < 95));
      l.el.classList.toggle('hidden', !visible);
      if (!visible) continue;
      const x = rect.left + ((_v.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - _v.y) / 2) * rect.height;
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      l.el.classList.toggle('sel', sel);
      l.el.classList.toggle('far', dist > 55 && !sel && !hov);
      l.el.classList.toggle('show-name', sel || hov || camDist < 16);
      const act = activityText(a);
      const emoting = a.emote && a.emote.until > w.time;
      const ic = emoting ? a.emote!.icon : act.icon;
      if (ic !== l.lastIcon) {
        l.lastIcon = ic;
        setHtml(l.bubble, `<span class="icon" style="color:${ICON_COLORS[ic] ?? '#f5c451'}">${icon(ic)}</span>`);
        l.el.classList.remove('emote');
        void l.el.offsetWidth;
        l.el.classList.add('emote');
      }
      setHtml(l.name, `${a.name}${sel || hov ? ` <i>· ${act.text}</i>` : ''}`);
      l.el.style.zIndex = sel ? '3' : hov ? '2' : '1';
    }
    for (const [id, l] of this.labels) if (!seen.has(id)) l.el.classList.add('hidden');
  }
}
