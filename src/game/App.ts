import { Game } from './Game';
import { UI } from '../ui/UI';
import { World } from '../sim/World';
import { randomSeed } from '../core/rng';
import { bless, castLightning, healAt, summonRain } from '../powers/GodPowers';
import { loadFromSlot, saveToSlot, slotMeta } from '../save/SaveSystem';
import { h } from '../ui/dom';
import { AudioSystem } from '../audio/AudioSystem';
import { DebugTools } from '../debug/DebugTools';
import { campfire } from '../sim/settlement';

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

  constructor(container: HTMLElement, seed: number) {
    this.game = new Game(container, seed);
    this.ui = new UI(this.game, {
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
    this.game.onGroundClick = (p, humanId) => this.usePower(p.x, p.z, humanId);
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

  private usePower(x: number, z: number, humanId: number | null): void {
    const w = this.game.world;
    switch (this.game.tool) {
      case 'lightning':
        castLightning(w, x, z);
        break;
      case 'rain':
        summonRain(w, x, z);
        break;
      case 'bless':
        if (!bless(w, x, z)) this.ui.showToast('Nothing can grow there.', 'bless');
        break;
      case 'heal':
        if (healAt(w, x, z, humanId) === 0) this.ui.showToast('Click on or near a human to heal them.', 'heal');
        break;
      default:
        break;
    }
  }

  private bindSfx(): void {
    this.unsubSfx?.();
    this.unsubSfx = this.game.world.events.on('sfx', (e) => this.audio.play(e));
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
      const cf = campfire(w);
      if (cf?.lit) fire += Math.max(0, 1 - Math.hypot(cf.x - f.x, cf.z - f.z) / 25) * 0.6;
      for (const s of w.structures) if (s.burning > 0 && Math.hypot(s.x - f.x, s.z - f.z) < 40) fire += 0.6;
      this.env = {
        daylight: w.daylight,
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
    world.spawnTribe(6);
    this.game.replaceWorld(world);
    this.ui.showToast(`A new island rises from the sea (seed ${seed}).`, 'globe');
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
      h('p', {}, 'A tiny tribe. A small island. You are their god.'),
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
