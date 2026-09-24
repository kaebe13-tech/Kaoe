import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PointLight,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type Texture,
} from 'three';
import type { World } from '../sim/World';
import type { Terrain } from '../world/Terrain';
import type { ParticleSystem } from './Particles';
import { Rng } from '../core/rng';

const rng = new Rng(777);
const R = () => rng.next();

interface Transient {
  /** Seconds lived (sim time for things tied to the simulation, real time otherwise). */
  t: number;
  life: number;
  real: boolean;
  update: (t: number, dt: number) => void;
  dispose: () => void;
}

let _grad: Texture | null = null;
/** Soft vertical gradient (bright centre line) for beams and curtains. */
function beamTexture(): Texture {
  if (_grad) return _grad;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const v = g.createLinearGradient(0, 0, 0, 64);
  v.addColorStop(0, 'rgba(0,0,0,1)');
  v.addColorStop(0.25, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = v;
  g.fillRect(0, 0, 64, 64);
  _grad = new CanvasTexture(c);
  return _grad;
}

function additive(color: number, opacity = 1, map?: Texture): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, map: map ?? null, fog: false });
}

/**
 * The big, rare visuals of divine acts and world events: falling stars, quakes, beams of light,
 * the god standing among the peoples, domes of protection and lights in the sky.
 */
export class DivineFx {
  readonly group = new Group();
  private readonly items: Transient[] = [];
  private avatar: { root: Group; light: PointLight; mats: MeshBasicMaterial[]; parts: Mesh[]; x: number; z: number } | null = null;
  /** Camera shake request (strength, seconds). */
  onShake: ((strength: number, seconds: number) => void) | null = null;
  onFlash: ((strength: number) => void) | null = null;
  private readonly unsub: () => void;

  constructor(
    private readonly world: World,
    private readonly terrain: Terrain,
    private readonly glow: ParticleSystem,
    private readonly soft: ParticleSystem,
    private readonly camera: { position: Vector3 },
  ) {
    this.unsub = world.events.on('divineFx', (e) => this.on(e));
  }

  dispose(): void {
    this.unsub();
    for (const it of this.items) it.dispose();
    this.items.length = 0;
    this.clearAvatar();
  }

  private ground(x: number, z: number): number {
    return Math.max(this.terrain.heightAt(x, z), 0);
  }

  private add(life: number, real: boolean, update: (t: number, dt: number) => void, dispose: () => void): void {
    this.items.push({ t: 0, life, real, update, dispose });
  }

  on(e: { kind: string; x: number; z: number; r?: number; t?: number; civId?: number }): void {
    switch (e.kind) {
      case 'meteorFall':
        this.meteorFall(e.x, e.z, e.t ?? 2);
        break;
      case 'meteorImpact':
        this.impact(e.x, e.z, e.r ?? 10);
        break;
      case 'quake':
        this.quake(e.x, e.z, e.r ?? 30);
        break;
      case 'beam':
        this.beam(e.x, e.z, 0xfff2c0, 2.5, 3);
        break;
      case 'manifest':
        this.manifest(e.x, e.z);
        break;
      case 'dome':
        this.dome(e.x, e.z, e.r ?? 40);
        break;
      case 'sign':
        this.aurora(e.x, e.z);
        break;
      case 'surge':
        this.beam(e.x, e.z, 0x8ff0ff, 12, 9);
        this.burst(e.x, e.z, 60, 0x9ff6ff, 8);
        break;
      case 'starfall':
        this.starfall(e.x, e.z, e.r ?? 200, e.t ?? 40);
        break;
      default:
        break;
    }
  }

  private burst(x: number, z: number, n: number, color: number, spread: number): void {
    const c = new Color(color);
    const y = this.ground(x, z);
    for (let i = 0; i < n; i++) {
      const a = R() * Math.PI * 2;
      const r = R() * spread;
      this.glow.spawn({ x: x + Math.cos(a) * r, y: y + R() * 3, z: z + Math.sin(a) * r, vx: 0, vy: 1 + R() * 3, vz: 0, life: 1.5 + R() * 2, size: 0.15 + R() * 0.2, r: c.r, g: c.g, b: c.b, drag: 0.4, wobble: 0.6 });
    }
  }

  // -------------------------------------------------------------- falling star

  private meteorFall(x: number, z: number, fall: number): void {
    const gy = this.ground(x, z);
    const dir = new Vector3(R() - 0.5, 0, R() - 0.5).normalize();
    const start = new Vector3(x + dir.x * 170, gy + 260, z + dir.z * 170);
    const end = new Vector3(x, gy + 0.5, z);
    const core = new Mesh(new SphereGeometry(2.2, 16, 12), additive(0xfff0c0, 1));
    const halo = new Mesh(new SphereGeometry(5.5, 16, 12), additive(0xff8a3a, 0.45));
    const light = new PointLight(0xff9a50, 0, 220, 1.4);
    const g = new Group();
    g.add(core, halo, light);
    this.group.add(g);
    const pos = new Vector3();
    const flame = new Color(0xffa040);
    const smoke = new Color(0x55504c);
    this.add(
      fall,
      false,
      (t) => {
        const u = Math.min(1, t / fall);
        const e = u * u;
        pos.lerpVectors(start, end, e);
        g.position.copy(pos);
        light.intensity = 400 * (0.3 + u);
        halo.scale.setScalar(1 + Math.sin(t * 40) * 0.08);
        for (let k = 0; k < 4; k++) {
          this.glow.spawn({ x: pos.x + (R() - 0.5) * 2, y: pos.y + (R() - 0.5) * 2, z: pos.z + (R() - 0.5) * 2, vx: (R() - 0.5) * 2, vy: (R() - 0.5) * 2, vz: (R() - 0.5) * 2, life: 0.6 + R() * 0.5, size: 1.6 + R() * 1.5, grow: 0.3, r: flame.r, g: flame.g, b: flame.b, a: 0.9 });
          if (k % 2 === 0) this.soft.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: (R() - 0.5), vy: R(), vz: (R() - 0.5), life: 2.5 + R() * 2, size: 2.2, grow: 3, r: smoke.r, g: smoke.g, b: smoke.b, a: 0.5, drag: 0.2 });
        }
      },
      () => {
        this.group.remove(g);
        core.geometry.dispose();
        halo.geometry.dispose();
        (core.material as MeshBasicMaterial).dispose();
        (halo.material as MeshBasicMaterial).dispose();
      },
    );
  }

  private impact(x: number, z: number, r: number): void {
    const gy = this.ground(x, z);
    const d = this.camera.position.distanceTo(new Vector3(x, gy, z));
    this.onFlash?.(Math.max(0.25, 1 - d / 400));
    this.onShake?.(Math.max(0.4, 2.2 - d / 200), 1.6);
    const white = new Color(0xfff4d0);
    const fire = new Color(0xff7a2a);
    const dust = new Color(0x8a7a66);
    for (let i = 0; i < 160; i++) {
      const a = R() * Math.PI * 2;
      const s = 6 + R() * 22;
      const c = i % 3 === 0 ? white : fire;
      this.glow.spawn({ x, y: gy + 1, z, vx: Math.cos(a) * s, vy: 6 + R() * 18, vz: Math.sin(a) * s, life: 0.8 + R() * 1.2, size: 0.3 + R() * 0.5, r: c.r, g: c.g, b: c.b, gravity: 14, drag: 0.6 });
    }
    for (let i = 0; i < 70; i++) {
      const a = R() * Math.PI * 2;
      const s = 3 + R() * 9;
      this.soft.spawn({ x: x + Math.cos(a) * r * 0.3, y: gy + 0.5, z: z + Math.sin(a) * r * 0.3, vx: Math.cos(a) * s, vy: 0.8 + R() * 3, vz: Math.sin(a) * s, life: 3 + R() * 3, size: 2 + R() * 2, grow: 3, r: dust.r, g: dust.g, b: dust.b, a: 0.55, drag: 0.9 });
    }
    // Shock ring on the ground.
    const ring = new Mesh(new RingGeometry(0.8, 1, 64), additive(0xffc080, 0.9));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, gy + 0.4, z);
    this.group.add(ring);
    const light = new PointLight(0xff8a40, 900, 160, 1.3);
    light.position.set(x, gy + 6, z);
    this.group.add(light);
    this.add(
      3,
      false,
      (t) => {
        const u = t / 3;
        ring.scale.setScalar(2 + u * r * 5);
        (ring.material as MeshBasicMaterial).opacity = 0.9 * (1 - u) * (1 - u);
        light.intensity = 900 * Math.max(0, 1 - t * 0.9);
        // A smoking crater for a while.
        if (R() < 0.6) this.soft.spawn({ x: x + (R() - 0.5) * r, y: gy, z: z + (R() - 0.5) * r, vx: 0.2, vy: 1.5 + R(), vz: 0.1, life: 5, size: 2.5, grow: 3, r: 0.3, g: 0.29, b: 0.28, a: 0.45, drag: 0.1 });
      },
      () => {
        this.group.remove(ring, light);
        ring.geometry.dispose();
        (ring.material as MeshBasicMaterial).dispose();
      },
    );
    // Embers glow in the crater long after.
    this.add(
      40,
      false,
      () => {
        if (R() < 0.25) this.glow.spawn({ x: x + (R() - 0.5) * r * 1.2, y: this.ground(x, z) + 0.3, z: z + (R() - 0.5) * r * 1.2, vx: 0, vy: 0.8 + R(), vz: 0, life: 1.2, size: 0.12, r: 1, g: 0.5, b: 0.15, wobble: 0.5 });
      },
      () => {},
    );
  }

  // -------------------------------------------------------------- quake

  private quake(x: number, z: number, r: number): void {
    const d = this.camera.position.distanceTo(new Vector3(x, this.ground(x, z), z));
    this.onShake?.(Math.max(0.25, 1.6 - d / 250) * Math.min(1, r / 30), 2.4);
    const dust = new Color(0xa89478);
    this.add(
      2.4,
      false,
      () => {
        for (let k = 0; k < 3; k++) {
          const a = R() * Math.PI * 2;
          const rr = Math.sqrt(R()) * r;
          const px = x + Math.cos(a) * rr;
          const pz = z + Math.sin(a) * rr;
          const gy = this.ground(px, pz);
          if (gy < 0.3) continue;
          this.soft.spawn({ x: px, y: gy + 0.2, z: pz, vx: (R() - 0.5) * 2, vy: 0.6 + R() * 1.4, vz: (R() - 0.5) * 2, life: 1.8 + R(), size: 1.2 + R(), grow: 2.5, r: dust.r, g: dust.g, b: dust.b, a: 0.45, drag: 1.2 });
        }
      },
      () => {},
    );
  }

  // -------------------------------------------------------------- light

  /** A column of light from the sky. */
  beam(x: number, z: number, color: number, life: number, width: number): void {
    const gy = this.ground(x, z);
    const h = 120;
    const geo = new CylinderGeometry(width * 0.5, width, h, 24, 1, true);
    geo.translate(0, h / 2, 0);
    const mat = additive(color, 0, beamTexture());
    const m = new Mesh(geo, mat);
    m.position.set(x, gy, z);
    m.renderOrder = 5;
    this.group.add(m);
    this.burst(x, z, 30, color, width);
    this.add(
      life,
      true,
      (t) => {
        const u = t / life;
        mat.opacity = Math.min(1, t * 4) * (1 - u) * 0.8;
        m.scale.set(1 + u * 0.3, 1, 1 + u * 0.3);
        m.rotation.y += 0.01;
      },
      () => {
        this.group.remove(m);
        geo.dispose();
        mat.dispose();
      },
    );
  }

  /** The god stands among them: a towering figure of light while the presence lasts. */
  private manifest(x: number, z: number): void {
    this.clearAvatar();
    const gy = this.ground(x, z);
    const root = new Group();
    root.position.set(x, gy, z);
    const mats: MeshBasicMaterial[] = [];
    const parts: Mesh[] = [];
    const part = (geo: SphereGeometry | CylinderGeometry | RingGeometry | PlaneGeometry, color: number, opacity: number, px = 0, py = 0, pz = 0, map?: Texture) => {
      const mat = additive(color, opacity, map);
      mats.push(mat);
      const m = new Mesh(geo, mat);
      m.position.set(px, py, pz);
      m.renderOrder = 6;
      root.add(m);
      parts.push(m);
      return m;
    };
    const H = 16;
    // Robed body: a tall soft cone of light, shoulders, head, halo, and a beam into the sky.
    const robe = new CylinderGeometry(1.6, 3.6, H * 0.62, 32, 1, true);
    part(robe, 0xfff0c8, 0.55, 0, H * 0.31, 0);
    part(new SphereGeometry(1.9, 24, 16), 0xfff6dc, 0.6, 0, H * 0.66, 0).scale.set(1.3, 0.7, 1);
    part(new SphereGeometry(1.25, 24, 16), 0xffffff, 0.75, 0, H * 0.78, 0);
    const halo = part(new RingGeometry(1.8, 2.15, 48), 0xffe38a, 0.9, 0, H * 0.8, -0.3);
    halo.userData.halo = true;
    const beam = new CylinderGeometry(2.2, 3.2, 200, 24, 1, true);
    beam.translate(0, 100, 0);
    part(beam, 0xfff2c0, 0.35, 0, 0, 0, beamTexture());
    // Outstretched arms of light.
    const arm = new CylinderGeometry(0.35, 0.55, 5.5, 12, 1, true);
    part(arm, 0xfff0c8, 0.5, -2.8, H * 0.6, 0).rotation.z = 1.05;
    part(arm, 0xfff0c8, 0.5, 2.8, H * 0.6, 0).rotation.z = -1.05;
    // Ground glow.
    const pool = part(new RingGeometry(0.5, 9, 48), 0xffe7a8, 0.35, 0, 0.25, 0);
    pool.rotation.x = -Math.PI / 2;
    const light = new PointLight(0xffe2a0, 0, 70, 1.2);
    light.position.set(0, 8, 0);
    root.add(light);
    this.group.add(root);
    this.avatar = { root, light, mats, parts, x, z };
    this.onFlash?.(0.5);
  }

  private clearAvatar(): void {
    const a = this.avatar;
    if (!a) return;
    this.group.remove(a.root);
    for (const m of a.parts) m.geometry.dispose();
    for (const m of a.mats) m.dispose();
    this.avatar = null;
  }

  private dome(x: number, z: number, r: number): void {
    const gy = this.ground(x, z);
    const geo = new SphereGeometry(r, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2);
    const mat = additive(0xbfe8ff, 0);
    const m = new Mesh(geo, mat);
    m.position.set(x, gy - 2, z);
    m.renderOrder = 5;
    this.group.add(m);
    this.add(
      7,
      true,
      (t) => {
        const u = t / 7;
        mat.opacity = Math.min(1, t * 2) * (1 - u) * 0.22 * (0.8 + Math.sin(t * 6) * 0.2);
        m.scale.setScalar(0.6 + Math.min(1, t * 1.5) * 0.4);
      },
      () => {
        this.group.remove(m);
        geo.dispose();
        mat.dispose();
      },
    );
  }

  /** Curtains of coloured light hanging in the sky above a people. */
  private aurora(x: number, z: number): void {
    const g = new Group();
    const mats: MeshBasicMaterial[] = [];
    const geos: PlaneGeometry[] = [];
    const cols = [0x7affc8, 0x8fd3ff, 0xc9a0ff, 0xffe38a];
    for (let i = 0; i < 6; i++) {
      const geo = new PlaneGeometry(160, 45, 40, 1);
      const pos = geo.getAttribute('position');
      for (let k = 0; k < pos.count; k++) {
        const px = pos.getX(k);
        pos.setZ(k, Math.sin(px * 0.04 + i) * 18);
      }
      geo.computeVertexNormals();
      const mat = additive(cols[i % cols.length]!, 0, beamTexture());
      const m = new Mesh(geo, mat);
      m.position.set(x + (R() - 0.5) * 60, 140 + i * 9, z + (i - 3) * 22);
      m.rotation.y = R() * 0.6 - 0.3;
      g.add(m);
      mats.push(mat);
      geos.push(geo);
    }
    this.group.add(g);
    const life = 45;
    this.add(
      life,
      true,
      (t) => {
        const fade = Math.min(1, t / 3) * Math.min(1, (life - t) / 6);
        mats.forEach((m, i) => (m.opacity = fade * (0.35 + 0.2 * Math.sin(t * 0.7 + i * 1.3))));
        g.children.forEach((c, i) => (c.position.x += Math.sin(t * 0.3 + i) * 0.05));
      },
      () => {
        this.group.remove(g);
        geos.forEach((q) => q.dispose());
        mats.forEach((m) => m.dispose());
      },
    );
  }

  private starfall(x: number, z: number, r: number, life: number): void {
    const white = new Color(0xfff8e8);
    this.add(
      life,
      true,
      () => {
        if (R() > 0.12) return;
        const sx = x + (R() - 0.5) * r * 2;
        const sz = z + (R() - 0.5) * r * 2;
        const vx = (R() - 0.5) * 80;
        const vz = (R() - 0.5) * 80;
        for (let k = 0; k < 14; k++) {
          this.glow.spawn({ x: sx - vx * k * 0.012, y: 190 - k * 0.8, z: sz - vz * k * 0.012, vx, vy: -18, vz, life: 0.9 - k * 0.04, size: 0.9 - k * 0.05, r: white.r, g: white.g, b: white.b, a: 0.9 });
        }
      },
      () => {},
    );
  }

  update(dt: number, simDt: number, time: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]!;
      const step = it.real ? dt : simDt;
      it.t += step;
      it.update(Math.min(it.t, it.life), step);
      if (it.t >= it.life) {
        it.dispose();
        this.items.splice(i, 1);
      }
    }
    // The manifested god lives as long as the presence in the world.
    const p = this.world.presence;
    if (this.avatar && (!p || Math.hypot(p.x - this.avatar.x, p.z - this.avatar.z) > 0.1)) {
      const fade = this.avatar;
      fade.root.scale.y *= 0.9;
      for (const m of fade.mats) m.opacity *= 0.9;
      if (fade.mats[0]!.opacity < 0.02) this.clearAvatar();
    } else if (this.avatar && p) {
      const a = this.avatar;
      const age = this.world.worldTime - p.since;
      const rise = Math.min(1, age / 4);
      a.root.scale.set(1, 0.2 + rise * 0.8, 1);
      a.light.intensity = 260 * rise * (0.9 + Math.sin(time * 2) * 0.1);
      for (const m of a.parts) if (m.userData.halo) m.rotation.z = time * 0.4;
      if (R() < 0.5) this.burst(a.x, a.z, 1, 0xffe38a, 6);
    } else if (!this.avatar && p && this.world.worldTime - p.since < 5) {
      this.manifest(p.x, p.z);
    }
  }
}
