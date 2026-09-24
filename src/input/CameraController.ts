import { PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { clamp, damp, dampAngle } from '../core/math';
import type { Terrain } from '../world/Terrain';
import { WORLD_HALF } from '../world/config';

/**
 * RTS / god-game camera: orbits a focus point on the ground. WASD pans relative to the view,
 * right-drag (or Alt+drag) rotates, left-drag grabs the ground, the wheel zooms toward the cursor.
 * All motion is damped so it never feels twitchy.
 */
export class CameraController {
  readonly target = new Vector3();
  yaw = 0.6;
  pitch = 0.78;
  distance = 48;
  private cur = { target: new Vector3(), yaw: 0.6, pitch: 0.78, distance: 48 };
  private readonly keys = new Set<string>();
  private dragMode: 'none' | 'rotate' | 'pan' = 'none';
  private dragStart = new Vector2();
  private lastMouse = new Vector2();
  private panAnchor = new Vector3();
  private dragDist = 0;
  /** Returns the followed position, or null. Set by the game when following a human. */
  follow: (() => Vector3 | null) | null = null;
  onFollowBroken: (() => void) | null = null;
  enabled = true;
  private shakeAmt = 0;
  private readonly raycaster = new Raycaster();
  private readonly plane = new Plane(new Vector3(0, 1, 0), 0);

  constructor(
    readonly camera: PerspectiveCamera,
    private readonly dom: HTMLElement,
    public terrain: Terrain,
  ) {
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.dom.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  /** True if the last left-button interaction was a drag (so it shouldn't count as a click). */
  get wasDrag(): boolean {
    return this.dragDist > 6;
  }

  jumpTo(x: number, z: number, distance?: number): void {
    this.target.set(x, this.terrain.heightAt(x, z), z);
    if (distance !== undefined) this.distance = distance;
  }

  snap(): void {
    this.cur.target.copy(this.target);
    this.cur.yaw = this.yaw;
    this.cur.pitch = this.pitch;
    this.cur.distance = this.distance;
  }

  private isTyping(): boolean {
    const el = document.activeElement;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  }

  private onKey = (e: KeyboardEvent) => {
    if (this.isTyping()) return;
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.dragStart.set(e.clientX, e.clientY);
    this.lastMouse.set(e.clientX, e.clientY);
    this.dragDist = 0;
    if (e.button === 2 || e.button === 1 || (e.button === 0 && e.altKey)) {
      this.dragMode = 'rotate';
    } else if (e.button === 0) {
      const p = this.groundPointAt(e.clientX, e.clientY, this.target.y);
      if (p) {
        this.panAnchor.copy(p);
        this.dragMode = 'pan';
      }
    }
  };

  private onMove = (e: PointerEvent) => {
    if (this.dragMode === 'none') return;
    const dx = e.clientX - this.lastMouse.x;
    const dy = e.clientY - this.lastMouse.y;
    this.lastMouse.set(e.clientX, e.clientY);
    this.dragDist = Math.max(this.dragDist, Math.hypot(e.clientX - this.dragStart.x, e.clientY - this.dragStart.y));
    if (this.dragMode === 'rotate') {
      this.yaw -= dx * 0.0052;
      this.pitch = clamp(this.pitch + dy * 0.0042, 0.22, 1.45);
    } else if (this.dragMode === 'pan' && this.dragDist > 6) {
      // Grab the ground: keep the anchor under the cursor.
      this.snapPan();
      const p = this.groundPointAt(e.clientX, e.clientY, this.panAnchor.y);
      if (p) {
        this.target.x += this.panAnchor.x - p.x;
        this.target.z += this.panAnchor.z - p.z;
        this.cur.target.x = this.target.x;
        this.cur.target.z = this.target.z;
        this.breakFollow();
        this.clampTarget();
      }
    }
  };

  private snapPan(): void {
    // Panning uses the immediate camera so the grabbed point stays locked to the cursor.
    this.cur.yaw = this.yaw;
    this.cur.pitch = this.pitch;
    this.cur.distance = this.distance;
    this.apply();
  }

  private onUp = () => {
    this.dragMode = 'none';
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const delta = clamp(e.deltaY, -300, 300);
    const factor = Math.pow(1.0018, delta);
    const before = this.distance;
    this.distance = clamp(this.distance * factor, 5, 240);
    // Zoom toward the point under the cursor (only when zooming in).
    if (this.distance < before) {
      const p = this.groundPointAt(e.clientX, e.clientY, this.target.y);
      if (p) {
        const k = (1 - this.distance / before) * 0.9;
        this.target.x += (p.x - this.target.x) * k;
        this.target.z += (p.z - this.target.z) * k;
        this.clampTarget();
        if (this.follow) this.breakFollow();
      }
    }
  };

  private breakFollow(): void {
    if (this.follow) {
      this.follow = null;
      this.onFollowBroken?.();
    }
  }

  groundPointAt(clientX: number, clientY: number, height: number): Vector3 | null {
    const rect = this.dom.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.plane.constant = -height;
    const out = new Vector3();
    return this.raycaster.ray.intersectPlane(this.plane, out);
  }

  private clampTarget(): void {
    const lim = WORLD_HALF - 5;
    this.target.x = clamp(this.target.x, -lim, lim);
    this.target.z = clamp(this.target.z, -lim, lim);
  }

  update(dt: number): void {
    if (this.enabled && !this.isTyping()) {
      const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      const speed = (fast ? 2.8 : 1) * (12 + this.distance * 0.9);
      let fx = 0;
      let fz = 0;
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) fz += 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) fz -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) fx += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) fx -= 1;
      if (fx || fz) {
        const fwdX = -Math.sin(this.yaw);
        const fwdZ = -Math.cos(this.yaw);
        const rightX = Math.cos(this.yaw);
        const rightZ = -Math.sin(this.yaw);
        const len = Math.hypot(fx, fz);
        this.target.x += ((fwdX * fz + rightX * fx) / len) * speed * dt;
        this.target.z += ((fwdZ * fz + rightZ * fx) / len) * speed * dt;
        this.clampTarget();
        this.breakFollow();
      }
      const rot = (fast ? 2 : 1) * 1.6 * dt;
      if (this.keys.has('KeyQ')) this.yaw += rot;
      if (this.keys.has('KeyE')) this.yaw -= rot;
      if (this.keys.has('KeyZ')) this.pitch = clamp(this.pitch + rot * 0.6, 0.22, 1.45);
      if (this.keys.has('KeyX')) this.pitch = clamp(this.pitch - rot * 0.6, 0.22, 1.45);
      if (this.keys.has('Equal') || this.keys.has('NumpadAdd')) this.distance = clamp(this.distance * (1 - dt * 1.5), 5, 240);
      if (this.keys.has('Minus') || this.keys.has('NumpadSubtract')) this.distance = clamp(this.distance * (1 + dt * 1.5), 5, 240);
    }
    if (this.follow) {
      const p = this.follow();
      if (p) {
        this.target.x = p.x;
        this.target.z = p.z;
      }
    }
    // Keep the focus on the terrain surface (never below the sea).
    const ground = Math.max(this.terrain.heightAt(this.target.x, this.target.z), 0);
    this.target.y = damp(this.target.y, ground, 4, dt);

    const k = this.follow ? 6 : 9;
    this.cur.target.x = damp(this.cur.target.x, this.target.x, k, dt);
    this.cur.target.y = damp(this.cur.target.y, this.target.y, k, dt);
    this.cur.target.z = damp(this.cur.target.z, this.target.z, k, dt);
    this.cur.yaw = dampAngle(this.cur.yaw, this.yaw, 10, dt);
    this.cur.pitch = damp(this.cur.pitch, this.pitch, 10, dt);
    this.cur.distance = damp(this.cur.distance, this.distance, 8, dt);
    this.apply();
  }

  private apply(): void {
    const c = this.cur;
    const cp = Math.cos(c.pitch);
    let x = c.target.x + Math.sin(c.yaw) * cp * c.distance;
    let y = c.target.y + Math.sin(c.pitch) * c.distance;
    let z = c.target.z + Math.cos(c.yaw) * cp * c.distance;
    // Never dip below the terrain or into the sea.
    const floor = Math.max(this.terrain.heightAt(x, z), 0) + 1.2;
    if (y < floor) y = floor;
    x = clamp(x, -WORLD_HALF * 3, WORLD_HALF * 3);
    z = clamp(z, -WORLD_HALF * 3, WORLD_HALF * 3);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(c.target.x, c.target.y + Math.min(1.2, c.distance * 0.02), c.target.z);
    if (this.shakeAmt > 0.001) {
      const k = this.shakeAmt * Math.min(1.5, c.distance * 0.03);
      this.camera.position.x += (Math.random() - 0.5) * k;
      this.camera.position.y += (Math.random() - 0.5) * k;
      this.camera.position.z += (Math.random() - 0.5) * k;
      this.shakeAmt *= 0.88;
    }
  }

  shake(strength: number): void {
    this.shakeAmt = Math.max(this.shakeAmt, strength);
  }

  /** Current smoothed focus (for shadows, audio listener, LOD). */
  get focus(): Vector3 {
    return this.cur.target;
  }

  get currentDistance(): number {
    return this.cur.distance;
  }
}
