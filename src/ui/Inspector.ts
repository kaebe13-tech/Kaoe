import type { Agent, NeedKey } from '../agents/Agent';
import { TRAITS } from '../agents/traits';
import type { Game } from '../game/Game';
import { DAY_LENGTH } from '../world/config';
import { ITEMS, ITEM_TYPES } from '../sim/types';
import { h, iconEl, escapeHtml, hex, setHtml, setText } from './dom';
import { ICON_COLORS, icon } from './icons';
import { activityText, homeText, initials, mood } from './agentInfo';

const NEEDS: Array<{ key: NeedKey; label: string; icon: string; color: string; words: [string, string, string] }> = [
  { key: 'hunger', label: 'Food', icon: 'food', color: 'var(--hunger)', words: ['Starving', 'Peckish', 'Full'] },
  { key: 'thirst', label: 'Water', icon: 'water', color: 'var(--thirst)', words: ['Parched', 'Thirsty', 'Quenched'] },
  { key: 'energy', label: 'Energy', icon: 'sleep', color: 'var(--energy)', words: ['Exhausted', 'Tired', 'Rested'] },
  { key: 'health', label: 'Health', icon: 'heal', color: 'var(--health)', words: ['Critical', 'Hurt', 'Healthy'] },
  { key: 'safety', label: 'Safety', icon: 'home', color: 'var(--safety)', words: ['Terrified', 'Uneasy', 'Safe'] },
  { key: 'social', label: 'Social', icon: 'social', color: 'var(--social)', words: ['Lonely', 'Okay', 'Connected'] },
];

const LOG_ICON: Record<string, string> = { decide: 'arrow', done: 'check', fail: 'cross', switch: 'swap', learn: 'bulb', event: 'dot' };

/** Right-hand panel explaining a single human: needs, what they think and why. */
export class Inspector {
  readonly el: HTMLElement;
  private readonly avatar: HTMLElement;
  private readonly name: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly traits: HTMLElement;
  private readonly followBtn: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly needBars = new Map<NeedKey, { wrap: HTMLElement; bar: HTMLElement; val: HTMLElement }>();
  private readonly mind: HTMLElement;
  private readonly inv: HTMLElement;
  private readonly facts: HTMLElement;
  private readonly friends: HTMLElement;
  private readonly log: HTMLElement;
  private agentId: number | null = null;

  constructor(private readonly game: Game) {
    this.avatar = h('div.avatar');
    this.name = h('div.ins-name');
    this.sub = h('div.ins-sub');
    this.followBtn = h('button.iconbtn', { title: 'Follow with camera (F)', onclick: () => this.toggleFollow() }) as HTMLButtonElement;
    this.followBtn.append(iconEl(icon('follow')));
    const close = h('button.iconbtn', { title: 'Close (Esc)', onclick: () => this.game.select(null) });
    close.append(iconEl(icon('close')));
    const head = h('div.ins-head', {}, [this.avatar, h('div', {}, [this.name, this.sub]), h('div.spacer'), this.followBtn, close]);
    this.traits = h('div.traits');

    const needs = h('div.needs');
    for (const n of NEEDS) {
      const val = h('b');
      const bar = h('i');
      bar.style.background = n.color;
      const label = h('span', {}, [iconEl(icon(n.icon)), n.label]);
      (label.firstChild as HTMLElement).style.color = n.color;
      const wrap = h('div.need', {}, [h('div.need-top', {}, [label, val]), h('div.bar', {}, [bar])]);
      needs.append(wrap);
      this.needBars.set(n.key, { wrap, bar, val });
    }
    this.mind = h('div.mind');
    this.inv = h('div.inv');
    this.facts = h('div.facts');
    this.friends = h('div.friends');
    this.log = h('div.log');
    const title = (t: string) => h('div.section-title', {}, t);
    this.body = h('div.ins-body', {}, [title('Needs'), needs, title('Thinking'), this.mind, title('Carrying'), this.inv, title('Life'), this.facts, title('Closest friends'), this.friends, title('Recent decisions'), this.log]);
    this.el = h('div.inspector.glass', {}, [head, this.traits, this.body]);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  show(id: number | null): void {
    this.agentId = id;
    this.el.classList.toggle('open', id !== null);
    if (id !== null) {
      this.body.scrollTop = 0;
      this.update(true);
    }
  }

  private toggleFollow(): void {
    if (this.agentId === null) return;
    this.game.follow(this.game.following ? null : this.agentId);
    this.update();
  }

  update(force = false): void {
    if (this.agentId === null) return;
    const w = this.game.world;
    const a = w.agent(this.agentId);
    if (!a) {
      this.game.select(null);
      return;
    }
    void force;
    this.avatar.style.background = hex(a.look.shirt);
    setText(this.avatar, initials(a.name));
    setText(this.name, a.name);
    const m = mood(a);
    setText(this.sub, `${a.age} years · ${m.text}`);
    this.followBtn.classList.toggle('on', this.game.following);
    setHtml(
      this.traits,
      a.traits.map((t) => `<span class="trait" title="${escapeHtml(TRAITS[t].desc)}">${TRAITS[t].label}</span>`).join(''),
    );

    for (const n of NEEDS) {
      const v = a.needs[n.key];
      const ui = this.needBars.get(n.key)!;
      ui.bar.style.width = `${Math.round(v * 100)}%`;
      const word = v < 0.25 ? n.words[0] : v < 0.6 ? n.words[1] : n.words[2];
      setText(ui.val, `${word} ${Math.round(v * 100)}%`);
      ui.wrap.classList.toggle('low', v < 0.25 && a.alive);
    }

    this.renderMind(a);
    this.renderInventory(a);
    this.renderFacts(a);
    this.renderFriends(a);
    this.renderLog(a);
  }

  private renderMind(a: Agent): void {
    const w = this.game.world;
    if (!a.alive) {
      setHtml(this.mind, `<div class="dead-note">${escapeHtml(a.name)} died on day ${Math.floor(a.diedAt / DAY_LENGTH) + 1} (${escapeHtml(a.deathCause || 'unknown causes')}). The tribe remembers.</div>`);
      return;
    }
    const act = a.brain.active;
    const actv = activityText(a);
    const col = ICON_COLORS[actv.icon] ?? 'var(--gold)';
    const thought = a.thought ? `“${escapeHtml(a.thought)}”` : '…';
    let html = `<div class="thought"><span class="icon" style="color:${col}">${icon(actv.icon)}</span><span>${thought}</span></div>`;
    if (act) {
      html += `<dl class="kv"><dt>Goal</dt><dd class="goal">${escapeHtml(act.label)}</dd><dt>Reason</dt><dd>${escapeHtml(act.reason)}</dd>`;
      if (act.targetLabel) html += `<dt>Target</dt><dd>${escapeHtml(act.targetLabel)}</dd>`;
      const mins = Math.round(((w.time - act.since) / (DAY_LENGTH / 24)) * 60);
      html += `<dt>For</dt><dd>${mins < 60 ? `${mins} min` : `${(mins / 60).toFixed(1)} h`}</dd></dl>`;
      html += '<div class="plan">';
      act.plan.forEach((step, i) => {
        const cls = i < act.step ? 'done' : i === act.step ? 'now' : '';
        const mark = i < act.step ? icon('check') : '';
        const prog = i === act.step && step.progress >= 0 ? `<span class="pbar"><i style="width:${Math.round(step.progress * 100)}%"></i></span>` : '';
        html += `<div class="step ${cls}"><span class="mark">${mark}</span><span>${escapeHtml(step.label)}</span>${prog}</div>`;
      });
      html += '</div>';
    } else if (a.knocked > 0) {
      html += `<dl class="kv"><dt>State</dt><dd>Knocked down — trying to get up</dd></dl>`;
    } else {
      html += `<dl class="kv"><dt>Goal</dt><dd>Deciding what to do next…</dd></dl>`;
    }
    setHtml(this.mind, html);
  }

  private renderInventory(a: Agent): void {
    const parts: string[] = [];
    for (const k of ITEM_TYPES) {
      const n = a.inventory[k];
      if (n <= 0) continue;
      const ic = k === 'wood' ? 'wood' : 'food';
      const col = k === 'wood' ? '#d49a5c' : k === 'fruit' ? '#ff9a57' : '#ff6b7d';
      parts.push(`<span class="chip"><span class="icon" style="color:${col}">${icon(ic)}</span>${n} ${n === 1 ? ITEMS[k].label : ITEMS[k].plural}</span>`);
    }
    setHtml(this.inv, parts.length ? parts.join('') : '<span class="chip" style="color:var(--dim)">Empty hands</span>');
  }

  private renderFacts(a: Agent): void {
    const w = this.game.world;
    const food = a.memory.knownFoodCount();
    const water = a.memory.water.size;
    const f = (label: string, value: string) => `<div class="fact">${label}<b>${escapeHtml(value)}</b></div>`;
    setHtml(
      this.facts,
      f('Home', homeText(w, a)) +
        f('Knows of', `${food} food spots · ${water} pond${water === 1 ? '' : 's'}`) +
        f('Has eaten', `${a.stats.foodEaten} food`) +
        f('Chopped', `${a.stats.woodChopped} logs`) +
        f('Built for', `${Math.round(a.stats.workDone)} s`) +
        f('Chats', `${a.stats.conversations}${a.stats.helped ? ` · helped ${a.stats.helped}×` : ''}`),
    );
  }

  private renderFriends(a: Agent): void {
    const w = this.game.world;
    const list = [...a.relations.entries()]
      .filter(([id]) => id > 0)
      .map(([id, v]) => ({ o: w.agent(id), v }))
      .filter((x) => x.o)
      .sort((x, y) => y.v - x.v)
      .slice(0, 3);
    if (!list.length) {
      setHtml(this.friends, '<span style="color:var(--dim);font-size:12.5px">No close bonds yet.</span>');
      return;
    }
    setHtml(
      this.friends,
      list
        .map(({ o, v }) => {
          const hearts = '♥'.repeat(Math.max(1, Math.round(v * 4)));
          return `<div class="friend" data-id="${o!.id}"><span class="avatar" style="background:${hex(o!.look.shirt)}">${initials(o!.name)}</span>${escapeHtml(o!.name)}${o!.alive ? '' : ' <span style="color:var(--dim)">(deceased)</span>'}<span class="hearts">${hearts}</span></div>`;
        })
        .join(''),
    );
    for (const el of this.friends.querySelectorAll<HTMLElement>('.friend')) {
      el.onclick = () => {
        const id = Number(el.dataset.id);
        this.game.select(id);
        const p = this.game.session.humans.positionOf(id);
        if (p) this.game.controls.jumpTo(p.x, p.z);
      };
    }
  }

  private renderLog(a: Agent): void {
    const w = this.game.world;
    const rows = a.log
      .slice(-14)
      .reverse()
      .map((e) => `<div class="log-row ${e.kind}"><span class="t">${w.clockString(e.time)}</span><span class="k icon">${icon(LOG_ICON[e.kind] ?? 'dot')}</span><span class="x">${escapeHtml(e.text)}</span></div>`)
      .join('');
    setHtml(this.log, rows || '<span style="color:var(--dim);font-size:12.5px">Nothing yet.</span>');
  }
}
