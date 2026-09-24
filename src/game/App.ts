import { Game } from './Game';
import { UI } from '../ui/UI';
import { World } from '../sim/World';
import { randomSeed } from '../core/rng';
import { bless, castLightning, healAt, summonRain } from '../powers/GodPowers';
import { loadFromSlot, saveToSlot, slotMeta } from '../save/SaveSystem';
import { h } from '../ui/dom';

const AUTOSAVE_EVERY = 180; // real seconds

/** Wires the game, UI, god powers and persistence together. */
export class App {
  readonly game: Game;
  readonly ui: UI;
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

  private tick(dt: number): void {
    this.ui.update(dt);
    if (this.game.speed > 0) {
      this.autosaveTimer -= dt;
      if (this.autosaveTimer <= 0) {
        this.autosaveTimer = AUTOSAVE_EVERY;
        this.save('auto', true);
      }
    }
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
