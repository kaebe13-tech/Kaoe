import type { Game, Speed, Tool } from '../game/Game';
import type { FeedEvent } from '../sim/events';
import { campfire, storages, tribeFood, tribeStored } from '../sim/settlement';
import { POWERS } from '../powers/GodPowers';
import { h, iconEl, escapeHtml, hex, setHtml, setText } from './dom';
import { ICON_COLORS, icon } from './icons';
import { Inspector } from './Inspector';
import { WorldLabels } from './WorldLabels';
import { Minimap } from './Minimap';
import { Chronicle } from './Chronicle';
import { activityText, initials, warnings } from './agentInfo';
import { resourceLabel } from '../sim/types';
import { BLUEPRINTS } from '../sim/blueprints';
import { siteMissing } from '../sim/settlement';

export interface UIHooks {
  save: () => string;
  load: (slot: string) => string;
  newWorld: (seed: number | null) => void;
  slotInfo: (slot: string) => string | null;
  setVolume: (v: number) => void;
  getVolume: () => number;
  toggleDebug: () => void;
  unlockAudio: () => void;
}

const TOOL_KEYS: Record<string, Tool> = { Digit1: 'select', Digit2: 'lightning', Digit3: 'rain', Digit4: 'bless', Digit5: 'heal' };

/** Composes the HUD and panels; refreshes text at a modest rate, positions every frame. */
export class UI {
  readonly root = h('div.ui-root');
  private readonly inspector: Inspector;
  private readonly labels: WorldLabels;
  private readonly minimap: Minimap;
  private readonly chronicle: Chronicle;
  private readonly dayEl = h('div.hud-day');
  private readonly clockEl = h('span');
  private readonly dialIcon = h('span.icon');
  private readonly weatherEl = h('span.hud-weather');
  private readonly statsEl = h('div.hud-stats');
  private readonly speedBtns = new Map<Speed, HTMLButtonElement>();
  private readonly powerBtns = new Map<Tool, HTMLButtonElement>();
  private readonly hint = h('div.power-hint.glass');
  private readonly pausedBadge = h('div.paused-badge.glass', {}, 'PAUSED');
  private readonly tribe = h('div.tribe.glass');
  private readonly tribeList = h('div.tribe-list');
  private readonly tribeCount = h('span.count');
  private readonly feed = h('div.feed');
  private readonly toast = h('div.toast.glass');
  private readonly tooltip = h('div.tooltip.glass');
  private readonly flashEl = h('div.flash');
  private readonly help: HTMLElement;
  private readonly modal = h('div.modal-back');
  private readonly menuBody = h('div.modal.glass');
  private toastTimer = 0;
  private refresh = 0;
  private tipTimer = 0;
  private readonly mouse = { x: 0, y: 0, moved: false };
  private readonly unsubWorld: Array<() => void> = [];

  constructor(
    private readonly game: Game,
    private readonly hooks: UIHooks,
  ) {
    this.inspector = new Inspector(game);
    this.labels = new WorldLabels(game);
    this.minimap = new Minimap(game);
    this.chronicle = new Chronicle(game);
    this.help = this.buildHelp();
    this.root.append(h('div.vignette'), this.flashEl, this.labels.el, this.minimap.el, this.chronicle.el, this.buildTime(), this.buildControls(), this.pausedBadge, this.buildTribe(), this.feed, this.buildPowers(), this.hint, this.inspector.el, this.toast, this.help, this.tooltip, this.modal);
    this.modal.append(this.menuBody);
    this.modal.addEventListener('pointerdown', (e) => {
      if (e.target === this.modal) this.closeMenu();
    });
    document.body.append(this.root);

    game.events.on('select', (id) => {
      this.inspector.show(id);
      this.help.classList.toggle('behind', id !== null);
      this.minimap.el.classList.toggle('shifted', id !== null);
      this.renderTribe();
    });
    game.events.on('speed', () => this.renderSpeed());
    game.events.on('tool', () => this.renderTools());
    game.events.on('session', () => this.bindWorld());
    this.bindWorld();
    window.addEventListener('keydown', this.onKey);
    game.renderer.domElement.addEventListener('pointermove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouse.moved = true;
    });
    game.renderer.domElement.addEventListener('pointerleave', () => this.tooltip.classList.remove('on'));
    this.renderSpeed();
    this.renderTools();
    // The controls card steps aside once the player has had time to read it.
    window.setTimeout(() => this.help.classList.add('hidden'), 75000);
  }

  private bindWorld(): void {
    for (const u of this.unsubWorld) u();
    this.unsubWorld.length = 0;
    this.feed.innerHTML = '';
    this.labels.reset();
    this.minimap.rebuild();
    this.unsubWorld.push(this.game.world.events.on('log', (e) => this.pushFeed(e)));
    this.inspector.show(this.game.selectedId);
    this.renderTribe();
  }

  // ---------------------------------------------------------------- building blocks

  private buildTime(): HTMLElement {
    const dial = h('div.hud-dial', {}, [this.dialIcon]);
    const clock = h('div.hud-clock', {}, [iconEl(icon('clock')), this.clockEl, this.weatherEl]);
    this.weatherEl.append(iconEl(icon('rain')), 'Rain');
    return h('div.hud-time.glass', {}, [dial, h('div', {}, [this.dayEl, clock]), this.statsEl]);
  }

  private buildControls(): HTMLElement {
    const speed = h('div.speed.glass');
    const defs: Array<[Speed, string, string]> = [
      [0, 'pause', 'Pause (Space)'],
      [1, '1×', 'Normal speed'],
      [2, '2×', 'Double speed'],
      [4, '4×', 'Fast forward'],
    ];
    for (const [s, label, title] of defs) {
      const b = h('button', { title, onclick: () => this.game.setSpeed(s) }) as HTMLButtonElement;
      if (label === 'pause') b.append(iconEl(icon('pause')));
      else b.textContent = label;
      speed.append(b);
      this.speedBtns.set(s, b);
    }
    const menu = h('button.iconbtn.glass', { title: 'Menu (Esc)', onclick: () => this.openMenu() });
    menu.append(iconEl(icon('menu')));
    const help = h('button.iconbtn.glass', { title: 'Controls (H)', onclick: () => this.help.classList.toggle('hidden') });
    help.append(iconEl(icon('keyboard')));
    const book = h('button.iconbtn.glass', { title: 'Chronicle of the tribe (C)', onclick: () => this.chronicle.toggle() });
    book.append(iconEl(icon('book')));
    return h('div.hud-controls', {}, [speed, book, help, menu]);
  }

  private buildPowers(): HTMLElement {
    const bar = h('div.powers.glass');
    const defs: Array<{ id: Tool; name: string; key: string; hint: string; ic: string }> = [
      { id: 'select', name: 'Observe', key: '1', hint: 'Click a human to see what they are thinking. Double-click to follow.', ic: 'select' },
      ...POWERS.map((p) => ({ id: p.id as Tool, name: p.name, key: p.key, hint: p.hint, ic: p.id })),
    ];
    for (const d of defs) {
      const b = h('button.power', { 'data-tool': d.id, onclick: () => this.game.setTool(d.id) }) as HTMLButtonElement;
      b.append(iconEl(icon(d.ic)), h('span.plabel', {}, d.name), h('span.key', {}, d.key));
      b.addEventListener('mouseenter', () => this.showHint(d.name, d.hint));
      b.addEventListener('mouseleave', () => this.showHint(null));
      bar.append(b);
      this.powerBtns.set(d.id, b);
    }
    return bar;
  }

  private buildTribe(): HTMLElement {
    const head = h('div.tribe-head', { onclick: () => this.tribe.classList.toggle('collapsed') }, [iconEl(icon('people')), 'Tribe', this.tribeCount]);
    this.tribe.append(head, this.tribeList);
    return this.tribe;
  }

  private buildHelp(): HTMLElement {
    const close = h('button.iconbtn', { onclick: () => this.help.classList.add('hidden'), title: 'Hide (H)' });
    close.append(iconEl(icon('close')));
    const row = (k: string, v: string) => h('div.row', { html: `<span>${k}</span><span>${v}</span>` });
    const el = h('div.help.glass', {}, [
      h('h4', {}, [iconEl(icon('keyboard')), 'Controls', close]),
      row('<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / drag', 'Move'),
      row('<kbd>Shift</kbd>', 'Move faster'),
      row('Right-drag · <kbd>Q</kbd><kbd>E</kbd>', 'Rotate'),
      row('Wheel · <kbd>Z</kbd><kbd>X</kbd>', 'Zoom · Tilt'),
      row('Click · double-click', 'Inspect · Follow'),
      row('<kbd>1</kbd>–<kbd>5</kbd>', 'God powers'),
      row('<kbd>Space</kbd> · <kbd>Tab</kbd>', 'Pause · Next human'),
      row('<kbd>H</kbd> · <kbd>F3</kbd>', 'Help · Debug'),
    ]);
    return el;
  }

  // ---------------------------------------------------------------- interactions

  private onKey = (e: KeyboardEvent) => {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
    const g = this.game;
    if (e.code === 'Escape') {
      if (this.modal.classList.contains('on')) this.closeMenu();
      else if (g.tool !== 'select') g.setTool('select');
      else if (g.selectedId !== null) g.select(null);
      else this.openMenu();
      return;
    }
    if (this.modal.classList.contains('on')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      g.togglePause();
    } else if (TOOL_KEYS[e.code]) g.setTool(TOOL_KEYS[e.code]!);
    else if (e.code === 'KeyF' && g.selectedId !== null) g.follow(g.following ? null : g.selectedId);
    else if (e.code === 'KeyH') this.help.classList.toggle('hidden');
    else if (e.code === 'KeyC') this.chronicle.toggle();
    else if (e.code === 'Tab') {
      e.preventDefault();
      this.cycleHuman(e.shiftKey ? -1 : 1);
    } else if (e.code === 'F3' || e.code === 'Backquote') {
      e.preventDefault();
      this.hooks.toggleDebug();
    } else if (e.code === 'BracketRight' || e.code === 'Period') {
      const order: Speed[] = [0, 1, 2, 4];
      g.setSpeed(order[Math.min(3, order.indexOf(g.speed) + 1)]!);
    } else if (e.code === 'BracketLeft' || e.code === 'Comma') {
      const order: Speed[] = [0, 1, 2, 4];
      g.setSpeed(order[Math.max(0, order.indexOf(g.speed) - 1)]!);
    }
  };

  private cycleHuman(dir: number): void {
    const g = this.game;
    const living = g.world.living;
    if (!living.length) return;
    const i = living.findIndex((a) => a.id === g.selectedId);
    const next = living[(i + dir + living.length) % living.length]!;
    g.select(next.id);
    g.follow(next.id);
  }

  private showHint(title: string | null, text = ''): void {
    if (!title) {
      this.hint.classList.remove('on');
      return;
    }
    this.hint.innerHTML = `<b>${escapeHtml(title)}</b> — ${escapeHtml(text)}`;
    this.hint.classList.add('on');
  }

  private focusOn(x: number, z: number, agentId?: number): void {
    const g = this.game;
    g.controls.follow = null;
    g.controls.jumpTo(x, z, Math.min(g.controls.distance, 32));
    if (agentId !== undefined) {
      const a = g.world.agent(agentId);
      if (a && a.alive) {
        g.select(agentId);
        g.follow(agentId);
      }
    }
  }

  private pushFeed(e: FeedEvent): void {
    const w = this.game.world;
    const col = e.icon === 'death' ? '#ff8fa3' : e.icon === 'lightning' ? '#ffe066' : ICON_COLORS[e.icon] ?? '#f5c451';
    const item = h(e.importance === 3 ? 'div.feed-item.glass.i3' : 'div.feed-item.glass', {
      onclick: () => {
        if (e.x !== undefined && e.z !== undefined) this.focusOn(e.x, e.z, e.agentId);
      },
    });
    item.innerHTML = `<span class="icon" style="color:${col}">${icon(e.icon)}</span><span>${escapeHtml(e.text)}</span><span class="tm">${w.clockString(e.time)}</span>`;
    this.feed.append(item);
    while (this.feed.children.length > 4) this.feed.firstElementChild?.remove();
    const life = e.importance === 3 ? 22000 : e.importance === 2 ? 16000 : 10000;
    setTimeout(() => {
      item.classList.add('fade');
      setTimeout(() => item.remove(), 900);
    }, life);
    if (e.importance === 3) this.showToast(e.text, e.icon);
  }

  flash(strength: number): void {
    const el = this.flashEl;
    el.style.transition = 'none';
    el.style.opacity = String(Math.min(0.75, strength * 0.8));
    void el.offsetWidth;
    el.style.transition = 'opacity .7s ease-out';
    el.style.opacity = '0';
  }

  showToast(text: string, ic = 'star'): void {
    this.toast.innerHTML = `<span class="icon">${icon(ic)}</span><span>${escapeHtml(text)}</span>`;
    this.toast.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('on'), 4200);
  }

  // ---------------------------------------------------------------- menu

  openMenu(): void {
    const g = this.game;
    const quick = this.hooks.slotInfo('quick');
    const auto = this.hooks.slotInfo('auto');
    const seedInput = h('input', { placeholder: 'Seed (blank = random)', inputmode: 'numeric' }) as HTMLInputElement;
    const btn = (ic: string, t: string, d: string, fn: () => void, cls = '', disabled = false) => {
      const b = h(`button.mbtn${cls}` as `button.${string}`, { onclick: fn, disabled }) as HTMLButtonElement;
      b.append(iconEl(icon(ic)), h('div', {}, [h('div.t', {}, t), h('div.d', {}, d)]));
      return b;
    };
    const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: String(this.hooks.getVolume()) }) as HTMLInputElement;
    vol.oninput = () => this.hooks.setVolume(Number(vol.value));
    const labelsBox = h('input', { type: 'checkbox' }) as HTMLInputElement;
    labelsBox.checked = this.labels.showAll;
    labelsBox.onchange = () => (this.labels.showAll = labelsBox.checked);
    this.menuBody.innerHTML = '';
    this.menuBody.append(
      h('h2', {}, 'Kaoe'),
      h('div.tag', {}, `Day ${g.world.day} · ${g.world.living.length} living · seed ${g.world.seed}`),
      btn('play', 'Resume', 'Back to the island', () => this.closeMenu(), '.primary'),
      btn('save', 'Save game', quick ? `Overwrite: ${quick}` : 'Store this world in your browser', () => {
        const msg = this.hooks.save();
        this.closeMenu();
        this.showToast(msg, 'save');
      }),
      btn('load', 'Load quick save', quick ?? 'No save yet', () => this.doLoad('quick'), '', !quick),
      btn('clock', 'Load autosave', auto ?? 'No autosave yet', () => this.doLoad('auto'), '', !auto),
      btn('globe', 'New world', 'Generate a fresh island and tribe', () => {
        const v = seedInput.value.trim();
        const seed = v ? Number(v.replace(/\D/g, '')) || hashSeed(v) : null;
        this.closeMenu();
        this.hooks.newWorld(seed);
      }),
      h('div.seedrow', {}, [seedInput]),
      h('div.row2', {}, [iconEl(icon('sound')), 'Volume', vol]),
      h('div.row2', {}, [h('label', {}, [labelsBox, 'Show thought bubbles'])]),
    );
    this.modal.classList.add('on');
    this.hooks.unlockAudio();
  }

  private doLoad(slot: string): void {
    const msg = this.hooks.load(slot);
    this.closeMenu();
    this.showToast(msg, 'load');
  }

  closeMenu(): void {
    this.modal.classList.remove('on');
  }

  // ---------------------------------------------------------------- per-frame

  update(dt: number): void {
    this.labels.update();
    this.minimap.update(dt);
    this.refresh -= dt;
    if (this.refresh <= 0) {
      this.refresh = 0.2;
      this.renderTime();
      this.renderTribe();
      this.inspector.update();
    }
    this.tipTimer -= dt;
    if (this.tipTimer <= 0 && this.mouse.moved) {
      this.tipTimer = 0.12;
      this.mouse.moved = false;
      this.updateTooltip();
    }
  }

  private renderTime(): void {
    const w = this.game.world;
    setText(this.dayEl, `Day ${w.day}`);
    setText(this.clockEl, w.clockString());
    const night = w.hour < 6 || w.hour >= 19.5;
    const ic = night ? 'moon' : 'sun';
    if (this.dialIcon.dataset.ic !== ic) {
      this.dialIcon.dataset.ic = ic;
      this.dialIcon.innerHTML = icon(ic);
      this.dialIcon.style.color = night ? '#c9d2ff' : '#ffd66b';
    }
    const f = this.game.controls.focus;
    this.weatherEl.classList.toggle('on', w.rainAt(f.x, f.z) > 0.15 || w.weather.anyRain > 0.5);
    const pop = w.living.length;
    const huts = w.structures.filter((s) => s.kind === 'hut' && s.complete).length;
    const chips = [
      `<span class="chip" title="Population"><span class="icon" style="color:#f5c451">${icon('people')}</span>${pop}</span>`,
      `<span class="chip" title="Huts built"><span class="icon" style="color:#f2c46b">${icon('home')}</span>${huts}</span>`,
    ];
    if (storages(w).length) {
      chips.push(`<span class="chip" title="Food in storage"><span class="icon" style="color:#ff7b6b">${icon('food')}</span>${tribeFood(w)}</span>`);
      chips.push(`<span class="chip" title="Wood in storage"><span class="icon" style="color:#d49a5c">${icon('wood')}</span>${tribeStored(w, 'wood')}</span>`);
    }
    const fire = campfire(w);
    if (fire?.complete) chips.push(`<span class="chip" title="Campfire fuel"><span class="icon" style="color:#ff9a45">${icon('fire')}</span>${Math.round(fire.fuel * 100)}%</span>`);
    setHtml(this.statsEl, chips.join(''));
    this.pausedBadge.classList.toggle('on', this.game.speed === 0);
  }

  private renderSpeed(): void {
    for (const [s, b] of this.speedBtns) b.classList.toggle('on', s === this.game.speed);
    this.pausedBadge.classList.toggle('on', this.game.speed === 0);
  }

  private renderTools(): void {
    for (const [t, b] of this.powerBtns) b.classList.toggle('on', t === this.game.tool);
    const canvas = this.game.renderer.domElement;
    canvas.style.cursor = this.game.tool === 'select' ? '' : cursorFor(this.game.tool);
    if (this.game.tool !== 'select') {
      const p = POWERS.find((x) => x.id === this.game.tool);
      if (p) this.showHintBriefly(p.name, p.hint);
    }
  }

  private hintTimer = 0;
  private showHintBriefly(t: string, d: string): void {
    this.showHint(t, d);
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.showHint(null), 3000);
  }

  private renderTribe(): void {
    const g = this.game;
    const w = g.world;
    const agents = [...w.agents].filter((a) => !a.buried || a.id === g.selectedId).sort((a, b) => Number(b.alive) - Number(a.alive));
    setText(this.tribeCount, `${w.living.length}`);
    const html = agents
      .map((a) => {
        const act = activityText(a);
        const warn = warnings(a)
          .map((k) => `<span class="icon" style="color:${ICON_COLORS[k] ?? '#ff7b6b'}">${icon(k)}</span>`)
          .join('');
        return `<div class="trow${a.id === g.selectedId ? ' sel' : ''}${a.alive ? '' : ' dead'}" data-id="${a.id}"><span class="avatar" style="background:${hex(a.look.shirt)}">${initials(a.name)}</span><div class="who"><div class="nm">${escapeHtml(a.name)}</div><div class="act"><span class="icon" style="color:${ICON_COLORS[act.icon] ?? '#aaa'}">${icon(act.icon)}</span>${escapeHtml(act.text)}</div></div><span class="warn">${warn}</span></div>`;
      })
      .join('');
    if ((this.tribeList as HTMLElement & { _h?: string })._h !== html) {
      (this.tribeList as HTMLElement & { _h?: string })._h = html;
      this.tribeList.innerHTML = html;
      for (const row of this.tribeList.querySelectorAll<HTMLElement>('.trow')) {
        row.onclick = () => {
          const id = Number(row.dataset.id);
          const a = g.world.agent(id);
          g.select(id);
          if (a) {
            const p = g.session.humans.positionOf(id);
            this.focusOn(p?.x ?? a.x, p?.z ?? a.z);
            if (a.alive) g.follow(id);
          }
        };
      }
    }
  }

  private updateTooltip(): void {
    const g = this.game;
    const tip = this.tooltip;
    if (g.hoveredId !== null || this.modal.classList.contains('on')) {
      tip.classList.remove('on');
      return;
    }
    const p = g.pickGround(this.mouse.x, this.mouse.y);
    if (!p) {
      tip.classList.remove('on');
      return;
    }
    const w = g.world;
    let html = '';
    let best = 2.2;
    for (const s of w.structures) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      const r = BLUEPRINTS[s.kind].radius;
      if (d < r && d / r < best) {
        best = d / r;
        const bp = BLUEPRINTS[s.kind];
        if (s.kind === 'grave') html = `<b>Grave of ${escapeHtml(s.label)}</b>Rest in peace.`;
        else if (!s.complete) {
          const miss = siteMissing(s);
          const need = Object.entries(miss)
            .map(([k, n]) => `${n} ${k}`)
            .join(', ');
          html = `<b>${bp.name} (building)</b>${Math.round(s.progress * 100)}% built${need ? ` · needs ${escapeHtml(need)}` : ' · all materials here'}`;
        } else {
          let extra = bp.description;
          if (s.kind === 'hut') extra = s.residents.length ? `Home of ${s.residents.map((id) => w.agent(id)?.name).filter(Boolean).join(' & ')}` : 'Empty — waiting for a family';
          if (s.kind === 'storage') extra = `Stores ${s.stored.berries + s.stored.fruit} food, ${s.stored.wood} wood`;
          if (s.kind === 'campfire') extra = `${s.lit ? 'Burning' : 'Unlit'} · fuel ${Math.round(s.fuel * 100)}%`;
          html = `<b>${bp.name}</b>${escapeHtml(extra)}`;
        }
      }
    }
    if (!html) {
      let near: { label: string; d: number; text: string } | null = null;
      w.resourceHash.query(p.x, p.z, 2, (r) => {
        const d = Math.hypot(r.x - p.x, r.z - p.z);
        if (near && d > near.d) return;
        let text = '';
        if (r.kind === 'berryBush') text = r.state === 'grown' ? `${r.amount} berries` : 'Regrowing';
        else if (r.kind === 'fruitTree') text = r.state === 'grown' ? `${r.amount} fruit` : 'Regrowing';
        else if (r.kind === 'tree') text = r.state === 'grown' ? `${r.amount} logs of wood` : r.state === 'sapling' ? `Growing (${Math.round(r.growth * 100)}%)` : r.state === 'stump' ? 'Will sprout again in time' : 'Charred';
        else text = 'Too heavy to move';
        if (r.burning > 0) text = 'On fire!';
        const claims = r.claims > 0 ? ` · ${r.claims} heading here` : '';
        near = { label: resourceLabel(r), d, text: text + claims };
      });
      const n = near as { label: string; d: number; text: string } | null;
      if (n) html = `<b>${escapeHtml(n.label)}</b>${escapeHtml(n.text)}`;
      else {
        const pond = w.water.find((wb) => Math.hypot(wb.x - p.x, wb.z - p.z) < wb.radius * 1.1);
        if (pond) html = '<b>Freshwater pond</b>Clean drinking water';
      }
    }
    if (!html) {
      tip.classList.remove('on');
      return;
    }
    tip.innerHTML = html;
    tip.style.left = `${this.mouse.x + 16}px`;
    tip.style.top = `${this.mouse.y + 14}px`;
    tip.classList.add('on');
  }
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function cursorFor(tool: Tool): string {
  const svg: Record<string, string> = {
    lightning: '<path d="M18 3 8 17h7l-3 12 12-16h-7z" fill="#ffe066" stroke="#3a2c00" stroke-width="1.5" stroke-linejoin="round"/>',
    rain: '<path d="M9 17a6 6 0 1 1 1-11.9A7.4 7.4 0 0 1 24.5 8 4.7 4.7 0 0 1 24 17z" fill="#b8dcf5" stroke="#23405a" stroke-width="1.5"/><path d="M11 21l-1.5 4M16.5 21 15 25M22 21l-1.5 4" stroke="#5cc8ff" stroke-width="2" stroke-linecap="round"/>',
    bless: '<path d="M16 29V17" stroke="#2c5a1a" stroke-width="2"/><path d="M16 17c-5 0-8-3.5-8-8 5 0 8 3.2 8 8zM16 14.5c0-4.4 3-7.5 8-7.5 0 4.6-3.1 7.5-8 7.5z" fill="#9be27a" stroke="#2c5a1a" stroke-width="1.5"/>',
    heal: '<path d="M12 4h8v8h8v8h-8v8h-8v-8H4v-8h8z" fill="#7ef0b0" stroke="#124a2e" stroke-width="1.5" stroke-linejoin="round"/>',
  };
  const body = svg[tool];
  if (!body) return 'crosshair';
  const data = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${body}</svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(data)}") 16 16, crosshair`;
}
