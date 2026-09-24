import type { Game } from '../game/Game';
import { WORLD_HALF, WORLD_SIZE } from '../world/config';
import { h } from './dom';

const SIZE = 168;

/**
 * Island map with humans, buildings and the camera's view. Click or drag to fly there.
 * The terrain layer is drawn once per world; markers refresh a few times a second.
 */
export class Minimap {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private base: ImageData | null = null;
  private timer = 0;
  private dragging = false;

  constructor(private readonly game: Game) {
    this.canvas = h('canvas', { width: SIZE, height: SIZE }) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.el = h('div.minimap.glass', { title: 'Click to fly there' }, [this.canvas]);
    const go = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * WORLD_SIZE - WORLD_HALF;
      const z = ((e.clientY - r.top) / r.height) * WORLD_SIZE - WORLD_HALF;
      this.game.controls.follow = null;
      this.game.controls.jumpTo(x, z);
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      go(e);
    });
    this.canvas.addEventListener('pointermove', (e) => this.dragging && go(e));
    this.canvas.addEventListener('pointerup', () => (this.dragging = false));
    this.rebuild();
  }

  /** Paint the terrain once (height + moisture shading). */
  rebuild(): void {
    const t = this.game.world.terrain;
    const img = this.ctx.createImageData(SIZE, SIZE);
    for (let py = 0; py < SIZE; py++) {
      for (let px = 0; px < SIZE; px++) {
        const x = (px / SIZE) * WORLD_SIZE - WORLD_HALF;
        const z = (py / SIZE) * WORLD_SIZE - WORLD_HALF;
        const hgt = t.heightAt(x, z);
        const i = (py * SIZE + px) * 4;
        let r: number;
        let g: number;
        let b: number;
        if (t.isWater(x, z)) {
          const d = Math.min(1, Math.max(0, -hgt / 8));
          r = 70 - d * 45;
          g = 190 - d * 110;
          b = 200 - d * 60;
          if (hgt > 0.2) {
            r = 90;
            g = 190;
            b = 190;
          }
        } else if (hgt < 1.4) {
          r = 232;
          g = 214;
          b = 160;
        } else {
          const m = t.moistureAt(x, z);
          const s = Math.min(1, t.slopeAt(x, z));
          const light = 0.85 + Math.min(0.3, hgt / 40);
          r = (110 - m * 55) * light;
          g = (180 - m * 50) * light;
          b = (80 - m * 30) * light;
          if (hgt > 13 || s > 0.9) {
            r = g = b = 150 + Math.min(60, hgt * 2);
          }
        }
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    this.base = img;
  }

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    const g = this.game;
    const w = g.world;
    const c = this.ctx;
    if (this.base) c.putImageData(this.base, 0, 0);
    const toPx = (v: number) => ((v + WORLD_HALF) / WORLD_SIZE) * SIZE;
    // Worn paths show up as the camp grows.
    for (const s of w.structures) {
      c.fillStyle = s.kind === 'grave' ? '#8a8a8a' : s.complete ? '#f2c14e' : 'rgba(242,193,78,.55)';
      const r = s.kind === 'hut' || s.kind === 'storage' ? 2.2 : 1.6;
      c.fillRect(toPx(s.x) - r, toPx(s.z) - r, r * 2, r * 2);
    }
    for (const r of w.resources.values()) {
      if (r.burning > 0) {
        c.fillStyle = '#ff6a2a';
        c.fillRect(toPx(r.x) - 1.5, toPx(r.z) - 1.5, 3, 3);
      }
    }
    for (const cl of w.weather.clouds) {
      c.fillStyle = `rgba(90,110,140,${0.35 * cl.intensity})`;
      c.beginPath();
      c.arc(toPx(cl.x), toPx(cl.z), (cl.radius / WORLD_SIZE) * SIZE, 0, Math.PI * 2);
      c.fill();
    }
    for (const a of w.agents) {
      if (!a.alive || a.buried) continue;
      const sel = a.id === g.selectedId;
      c.fillStyle = sel ? '#ffffff' : '#ff5a4f';
      c.beginPath();
      c.arc(toPx(a.x), toPx(a.z), sel ? 3 : a.isChild ? 1.4 : 2, 0, Math.PI * 2);
      c.fill();
      if (sel) {
        c.strokeStyle = '#1a1f24';
        c.lineWidth = 1;
        c.stroke();
      }
    }
    // Camera view: focus point + facing direction.
    const f = g.controls.focus;
    const yaw = g.controls.yaw;
    const d = Math.min(24, 6 + g.controls.currentDistance * 0.12);
    const fx = toPx(f.x);
    const fz = toPx(f.z);
    c.strokeStyle = 'rgba(255,255,255,.9)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(fx - Math.sin(yaw - 0.5) * d, fz - Math.cos(yaw - 0.5) * d);
    c.lineTo(fx, fz);
    c.lineTo(fx - Math.sin(yaw + 0.5) * d, fz - Math.cos(yaw + 0.5) * d);
    c.stroke();
  }
}
