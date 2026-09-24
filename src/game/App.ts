import { daylightAt } from '../sim/time';
import { Game } from './Game';
import { UI } from '../ui/UI';
import { World } from '../sim/World';
import { randomSeed } from '../core/rng';
import { POWER, carry, healAt, usePower, type PowerId, type PowerResult } from '../powers/GodPowers';
import { resolveRequest } from '../civ/divine';
import { leaderOf } from '../civ/civSystem';
import { MindService } from '../mind/MindService';
import { GeminiProvider } from '../mind/providers';
import { loadFromSlot, saveToSlot, slotMeta } from '../save/SaveSystem';
import { h } from '../ui/dom';
import { AudioSystem } from '../audio/AudioSystem';
import { DebugTools } from '../debug/DebugTools';

const AUTOSAVE_EVERY = 180; // real seconds

/** Wires the game, UI, god powers and persistence together. */
export class App {
  readonly game: Game;
  readonly ui: UI;
  readonly audio = new AudioSystem();
  readonly debug: DebugTools;
  private unsubSfx: (() => void) | null = null;
  private autosaveTimer = AUTOSAVE_EVERY;
  private debugToggle: (() => void) | null = null;
  volume = 0.7;
  readonly mind: MindService;
  /** Real time (s) when each power is ready again. */
  private readonly cooldowns = new Map<PowerId, number>();
  /** Person picked up with Carry, waiting to be set down. */
  private carrying: number | null = null;

  constructor(container: HTMLElement, seed: number, private readonly population = 6) {
    this.game = new Game(container, seed, population);
    this.mind = new MindService(() => this.game.world, new GeminiProvider(), import.meta.env.VITE_KAOE_STATIC === '1');
    this.mind.install();
    this.ui = new UI(this.game, {
      cooldownLeft: (id) => Math.max(0, (this.cooldowns.get(id) ?? 0) - performance.now() / 1000),
      carrying: () => this.carrying,
      mind: this.mind,
      save: () => this.save('quick'),
      load: (slot) => this.load(slot),
      newWorld: (s) => this.newWorld(s ?? randomSeed()),
      slotInfo: (slot) => {
        const m = slotMeta(slot);
        if (!m) return null;
        const ago = timeAgo(m.savedAt);
        return `Day ${m.day}, ${m.clock} · ${m.population} people · ${ago}`;
      },
      setVolume: (v) => this.setVolume(v),
      getVolume: () => this.volume,
      toggleDebug: () => this.debugToggle?.(),
      unlockAudio: () => this.onUnlockAudio?.(),
    });
    this.debug = new DebugTools(this.game);
    this.debugToggle = () => this.debug.toggle();
    try {
      const v = localStorage.getItem('kaoe.volume');
      if (v !== null) this.volume = Number(v);
    } catch {
      /* ignore */
    }
    this.audio.setVolume(this.volume);
    this.onVolume = (v) => this.audio.setVolume(v);
    this.onUnlockAudio = () => this.audio.unlock();
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    document.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) this.audio.click();
    });
    this.bindSfx();
    this.game.events.on('session', () => this.bindSfx());
    this.game.onGroundClick = (p, humanId, shift) => this.usePower(p.x, p.z, humanId, shift);
    this.game.events.on('tool', (t) => {
      if (t !== 'teleport') this.carrying = null;
    });
    this.ui.civBar.onAnswer = (civId, reqId, grant) => this.answer(civId, reqId, grant);
    this.game.onFlash = (k) => {
      this.ui.flash(k);
      this.game.controls.shake(k * 1.2);
    };
    this.game.events.on('frame', (dt) => this.tick(dt));
  }

  /** Optional audio hook, set once the audio system exists. */
  onUnlockAudio: (() => void) | null = null;
  onVolume: ((v: number) => void) | null = null;

  setDebugToggle(fn: () => void): void {
    this.debugToggle = fn;
  }

  setVolume(v: number): void {
    this.volume = v;
    this.onVolume?.(v);
    try {
      localStorage.setItem('kaoe.volume', String(v));
    } catch {
      /* ignore */
    }
  }

  private usePower(x: number, z: number, humanId: number | null, shift: boolean): void {
    const w = this.game.world;
    const tool = this.game.tool as PowerId;
    const def = POWER[tool];
    if (!def) return;
    const now = performance.now() / 1000;
    const ready = this.cooldowns.get(tool) ?? 0;
    if (ready > now) {
      this.ui.showToast(`${def.name} is gathering strength (${Math.ceil(ready - now)} s).`, def.icon);
      return;
    }
    let r: PowerResult;
    if (tool === 'teleport') {
      if (this.carrying === null) {
        const a = w.agent(humanId);
        if (!a || !a.alive) {
          this.ui.showToast('Click on a person to pick them up.', 'hand');
          return;
        }
        this.carrying = a.id;
        this.ui.showToast(`You lift ${a.name}. Click where to set them down.`, 'hand');
        return;
      }
      r = carry(w, this.carrying, x, z);
      if (r.ok) this.carrying = null;
    } else r = usePower(w, tool, { x, z, humanId, alt: shift });
    if (!r.ok) {
      if (r.message) this.ui.showToast(r.message, def.icon);
      return;
    }
    this.cooldowns.set(tool, now + def.cooldown);
  }

  /** Grant or refuse a prayer from the civ panel. Granting performs the fitting act. */
  private answer(civId: number, reqId: number, grant: boolean): void {
    const w = this.game.world;
    const civ = w.civs[civId];
    const req = civ?.requests.find((r) => r.id === reqId && r.status === 'open');
    if (!civ || !req) return;
    if (!grant) {
      resolveRequest(w, civ, req, 'refused');
      this.ui.showToast(`You refused ${civ.name}.`, 'cross');
      return;
    }
    const leader = leaderOf(w, civ);
    const cap = civ.capital ?? { x: req.x, z: req.z };
    const at = { x: req.x, z: req.z, humanId: null as number | null };
    const onCiv = { x: cap.x, z: cap.z, humanId: leader?.id ?? null };
    let r: PowerResult = { ok: false };
    switch (req.kind) {
      case 'rain':
        r = usePower(w, 'rain', at);
        break;
      case 'food':
        r = usePower(w, 'harvest', at);
        if (!r.ok) r = usePower(w, 'bless', at);
        break;
      case 'protection':
        r = usePower(w, 'sanctuary', onCiv);
        break;
      case 'sign':
        r = usePower(w, 'sign', onCiv);
        break;
      case 'heal': {
        let n = 0;
        for (const a of civ.members) if (a.alive && a.needs.health < 0.6) n += healAt(w, a.x, a.z, a.id);
        r = { ok: n > 0 };
        break;
      }
      case 'blessing':
        r = usePower(w, 'inspire', onCiv);
        break;
      case 'peace':
        r = usePower(w, 'peace', onCiv);
        break;
      case 'guidance':
        r = usePower(w, 'vision', onCiv);
        break;
    }
    // Whatever happened, the people take it as an answer.
    if (req.status === 'open') resolveRequest(w, civ, req, 'granted');
    this.game.flyTo(req.x, req.z, 45, 0.8);
    this.ui.showToast(r.ok ? `You answered ${civ.name}'s prayer.` : `${civ.name} take it as a sign that you heard them.`, 'divine');
  }

  private bindSfx(): void {
    this.unsubSfx?.();
    // In time-lapse the world would be a wall of noise: stay quiet.
    this.unsubSfx = this.game.world.events.on('sfx', (e) => {
      if (!this.game.turbo) this.audio.play(e);
    });
  }

  private tick(dt: number): void {
    this.ui.update(dt);
    this.debug.update(dt);
    this.updateAudio(dt);
    if (this.game.speed > 0) {
      this.autosaveTimer -= dt;
      if (this.autosaveTimer <= 0) {
        this.autosaveTimer = AUTOSAVE_EVERY;
        this.save('auto', true);
      }
    }
  }

  private envTimer = 0;
  private env = { daylight: 1, rain: 0, oceanNear: 0.5, fire: 0, trees: 0.5 };

  private updateAudio(dt: number): void {
    const g = this.game;
    const w = g.world;
    const f = g.controls.focus;
    this.envTimer -= dt;
    if (this.envTimer <= 0) {
      this.envTimer = 0.5;
      const h = w.terrain.heightAt(f.x, f.z);
      let trees = 0;
      let fire = 0;
      w.resourceHash.query(f.x, f.z, 22, (r) => {
        if (r.kind === 'tree' && r.state === 'grown') trees++;
        if (r.burning > 0) fire += 0.3;
      });
      for (const cf of w.structures) if (cf.kind === 'campfire' && cf.lit) fire += Math.max(0, 1 - Math.hypot(cf.x - f.x, cf.z - f.z) / 25) * 0.6;
      for (const s of w.structures) if (s.burning > 0 && Math.hypot(s.x - f.x, s.z - f.z) < 40) fire += 0.6;
      this.env = {
        daylight: daylightAt(w.worldHour),
        rain: Math.max(w.rainAt(f.x, f.z), w.weather.anyRain * 0.25),
        oceanNear: h < 2 ? 1 : Math.max(0, 1 - (h - 2) / 8),
        fire: Math.min(1, fire),
        trees: Math.min(1, trees / 25),
      };
    }
    this.audio.update(dt, f, g.controls.currentDistance, g.controls.yaw, this.env);
  }

  save(slot: string, quiet = false): string {
    const r = saveToSlot(this.game.world, slot);
    if (!r.ok) return `Could not save: ${r.error}`;
    return quiet ? '' : `Saved — Day ${r.meta.day}, ${r.meta.clock}`;
  }

  load(slot: string): string {
    try {
      const world = loadFromSlot(slot);
      if (!world) return 'No saved game found.';
      this.game.replaceWorld(world);
      return `Loaded — Day ${world.day}, ${world.clockString()}`;
    } catch (e) {
      console.error(e);
      return `Could not load: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  newWorld(seed: number): void {
    const world = new World(seed);
    world.spawnCivilizations(4, this.population);
    this.carrying = null;
    this.cooldowns.clear();
    this.game.replaceWorld(world, true);
    this.ui.showToast(`A new land rises from the sea (seed ${seed}).`, 'globe');
  }
}

function timeAgo(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

/** Title card shown over the island on first load. */
export function showIntro(onStart: () => void): void {
  const el = h('div.intro', {}, [
    h('div.intro-card', {}, [
      h('h1', {}, 'Kaoe'),
      h('p', {}, 'Four small peoples. One wide land. You are their god.'),
      h('div.go', {}, 'Begin watching'),
    ]),
  ]);
  document.body.append(el);
  const go = () => {
    el.classList.add('gone');
    setTimeout(() => el.remove(), 1500);
    window.removeEventListener('keydown', go);
    onStart();
  };
  el.addEventListener('click', go);
  window.addEventListener('keydown', go);
}
