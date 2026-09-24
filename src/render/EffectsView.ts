import { CanvasTexture, Color, Group, Mesh, MeshBasicMaterial, PlaneGeometry, PointLight, Vector3, type Camera, type Object3D, type Texture } from 'three';
import { Rng } from '../core/rng';
import type { World } from '../sim/World';
import type { FxEvent } from '../sim/events';
import { BLUEPRINTS } from '../sim/blueprints';
import type { ResourceNode, ScorchMark } from '../sim/types';
import type { Terrain } from '../world/Terrain';
import { ParticleSystem, type ParticleSpec } from './Particles';
import { RainView } from './RainView';
import { LightningFx } from './LightningFx';
import type { VegetationView } from './VegetationView';
import { DivineFx } from './DivineFx';

interface Falling {
  mesh: Mesh;
  pivot: Group;
  t: number;
  axisX: number;
  axisZ: number;
  landed: boolean;
}

const rng = new Rng(4242);
const R = () => rng.next();
const col = (hex: number) => new Color(hex);

/** Visual reactions to simulation events: particles, fire, rain, lightning, falling trees. */
export class EffectsView {
  readonly group = new Group();
  readonly soft = new ParticleSystem(2200);
  readonly glow = ParticleSystem.additive(2200);
  readonly rain = new RainView();
  readonly lightning = new LightningFx();
  private readonly falling: Falling[] = [];
  private readonly fireLights: PointLight[] = [];
  private readonly scorchMeshes = new Map<number, Mesh>();
  private readonly scorchGeo: PlaneGeometry;
  private emitAcc = 0;
  private readonly lastStep = new Map<number, number>();
  private readonly unsubs: Array<() => void> = [];
  /** Called on lightning so the UI can flash and the camera can shake. */
  onFlash: ((strength: number) => void) | null = null;
  /** Sustained camera shake (quakes, falling stars). */
  onShake: ((strength: number, seconds: number) => void) | null = null;
  readonly divine: DivineFx;

  constructor(
    private readonly world: World,
    private readonly terrain: Terrain,
    private readonly vegetation: VegetationView,
    private readonly camera: Camera,
  ) {
    this.group.add(this.soft.mesh, this.glow.mesh, this.rain.group, this.lightning.group);
    this.divine = new DivineFx(world, terrain, this.glow, this.soft, camera);
    this.divine.onFlash = (k) => this.onFlash?.(k);
    this.divine.onShake = (k, t) => this.onShake?.(k, t);
    this.group.add(this.divine.group);
    for (let i = 0; i < 3; i++) {
      const l = new PointLight(0xff7a2a, 0, 22, 1.7);
      this.fireLights.push(l);
      this.group.add(l);
    }
    this.scorchGeo = new PlaneGeometry(1, 1, 10, 10);
    this.scorchGeo.rotateX(-Math.PI / 2);
    const ev = world.events;
    this.unsubs.push(
      ev.on('fx', (e) => this.onFx(e)),
      ev.on('treeFelled', ({ resource, dirX, dirZ }) => this.fell(resource, dirX, dirZ)),
      ev.on('lightning', ({ x, z }) => this.strike(x, z)),
    );
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.divine.dispose();
  }

  /** A soft column of light on someone the god is speaking to. */
  divineLight(x: number, z: number): void {
    this.divine.beam(x, z, 0xfff2c0, 2.2, 2.2);
  }

  private ground(x: number, z: number): number {
    return Math.max(this.terrain.heightAt(x, z), 0);
  }

  private burst(n: number, base: (i: number) => ParticleSpec, sys: ParticleSystem = this.soft): void {
    for (let i = 0; i < n; i++) sys.spawn(base(i));
  }

  private onFx(e: FxEvent): void {
    const y = this.ground(e.x, e.z) + (e.y ?? 0.5);
    const c = (hex: number) => col(hex);
    switch (e.kind) {
      case 'woodChips': {
        const cc = c(0xc9955c);
        this.burst(e.count ?? 6, () => ({ x: e.x + (R() - 0.5) * 0.4, y, z: e.z + (R() - 0.5) * 0.4, vx: (R() - 0.5) * 3.2, vy: 1.5 + R() * 2.2, vz: (R() - 0.5) * 3.2, life: 0.7 + R() * 0.4, size: 0.1 + R() * 0.08, r: cc.r, g: cc.g, b: cc.b, gravity: 9, drag: 0.8 }));
        break;
      }
      case 'leaves': {
        const cc = c(0x6fbf4a);
        this.burst(e.count ?? 4, () => ({ x: e.x + (R() - 0.5) * 1.2, y: y + R() * 0.8, z: e.z + (R() - 0.5) * 1.2, vx: (R() - 0.5), vy: -0.3, vz: (R() - 0.5), life: 1.6 + R(), size: 0.13, r: cc.r, g: cc.g, b: cc.b, gravity: 0.8, drag: 1.5, wobble: 0.8 }));
        break;
      }
      case 'berryPop': {
        const cc = c(0xe0304a);
        this.burst(e.count ?? 3, () => ({ x: e.x + (R() - 0.5) * 0.6, y, z: e.z + (R() - 0.5) * 0.6, vx: (R() - 0.5) * 1.5, vy: 1.8 + R(), vz: (R() - 0.5) * 1.5, life: 0.55, size: 0.1, r: cc.r, g: cc.g, b: cc.b, gravity: 8 }));
        const lc = c(0x5fae45);
        this.burst(2, () => ({ x: e.x, y: y + 0.2, z: e.z, vx: (R() - 0.5), vy: 0.4, vz: (R() - 0.5), life: 1.2, size: 0.1, r: lc.r, g: lc.g, b: lc.b, gravity: 1, drag: 1.5, wobble: 0.6 }));
        break;
      }
      case 'dust':
      case 'buildDust': {
        const cc = c(0xd8c49a);
        const big = e.kind === 'buildDust' ? 1.3 : 1;
        this.burst(Math.min(e.count ?? 8, 16), () => ({ x: e.x + (R() - 0.5) * 1.5 * big, y: y - 0.3 + R() * 0.3, z: e.z + (R() - 0.5) * 1.5 * big, vx: (R() - 0.5) * 1.2, vy: 0.4 + R() * 0.6, vz: (R() - 0.5) * 1.2, life: 0.8 + R() * 0.6, size: 0.26 * big, grow: 2, r: cc.r, g: cc.g, b: cc.b, a: 0.38, drag: 1.5 }));
        break;
      }
      case 'splash': {
        const cc = c(0xdff4ff);
        this.burst(e.count ?? 5, () => ({ x: e.x, y: this.ground(e.x, e.z) + 0.1, z: e.z, vx: (R() - 0.5) * 1.4, vy: 1.4 + R() * 1.3, vz: (R() - 0.5) * 1.4, life: 0.5, size: 0.08, r: cc.r, g: cc.g, b: cc.b, gravity: 9 }));
        break;
      }
      case 'sparkle': {
        const gold = c(0xffe38a);
        const green = c(0xb8ffcf);
        this.burst(e.count ?? 20, (i) => {
          const cc = i % 2 ? gold : green;
          const a = R() * Math.PI * 2;
          const r = R() * 1.6;
          return { x: e.x + Math.cos(a) * r, y: y - 0.4 + R() * 1.5, z: e.z + Math.sin(a) * r, vx: 0, vy: 0.8 + R() * 1.6, vz: 0, life: 1.2 + R() * 1.2, size: 0.12 + R() * 0.12, r: cc.r, g: cc.g, b: cc.b, drag: 0.5, wobble: 0.5 };
        }, this.glow);
        break;
      }
      case 'smoke': {
        const cc = c(0x4b4a48);
        this.burst(e.count ?? 6, () => ({ x: e.x + (R() - 0.5) * 1.5, y: y + R(), z: e.z + (R() - 0.5) * 1.5, vx: (R() - 0.5) * 0.6, vy: 1.2 + R() * 0.8, vz: (R() - 0.5) * 0.6, life: 3 + R() * 2, size: 0.8, grow: 3.5, r: cc.r, g: cc.g, b: cc.b, a: 0.5, drag: 0.3 }));
        break;
      }
      case 'embers': {
        const cc = c(0xffa040);
        this.burst(e.count ?? 3, () => ({ x: e.x + (R() - 0.5) * 1.4, y: y + R() * 1.2, z: e.z + (R() - 0.5) * 1.4, vx: (R() - 0.5) * 0.8, vy: 1.5 + R() * 1.5, vz: (R() - 0.5) * 0.8, life: 1 + R(), size: 0.07, r: cc.r, g: cc.g, b: cc.b, drag: 0.4, wobble: 0.9 }), this.glow);
        break;
      }
      case 'hearts': {
        const cc = c(0xff7aa8);
        this.burst(e.count ?? 5, () => ({ x: e.x + (R() - 0.5) * 0.8, y: y + R() * 0.4, z: e.z + (R() - 0.5) * 0.8, vx: 0, vy: 0.7 + R() * 0.5, vz: 0, life: 1.4 + R() * 0.6, size: 0.14, r: cc.r, g: cc.g, b: cc.b, wobble: 0.3 }), this.glow);
        break;
      }
      case 'bloom': {
        const cols = [0xff9fc6, 0xfff27a, 0xffffff, 0xc9a0ff, 0x9be27a].map((q) => c(q));
        this.burst(e.count ?? 20, (i) => {
          const cc = cols[i % cols.length]!;
          const a = R() * Math.PI * 2;
          const r = R() * 6;
          return { x: e.x + Math.cos(a) * r, y: y + R() * 2, z: e.z + Math.sin(a) * r, vx: (R() - 0.5) * 0.6, vy: 0.6 + R() * 1.2, vz: (R() - 0.5) * 0.6, life: 2 + R() * 1.5, size: 0.12 + R() * 0.08, r: cc.r, g: cc.g, b: cc.b, gravity: 0.3, drag: 1.2, wobble: 0.9 };
        });
        break;
      }
      case 'stoneChips': {
        const cc = c(0x9a948a);
        this.burst(e.count ?? 10, () => ({ x: e.x + (R() - 0.5), y, z: e.z + (R() - 0.5), vx: (R() - 0.5) * 4, vy: 2 + R() * 3, vz: (R() - 0.5) * 4, life: 0.8 + R() * 0.4, size: 0.1 + R() * 0.1, r: cc.r, g: cc.g, b: cc.b, gravity: 10, drag: 0.5 }));
        break;
      }
      case 'crystalShards': {
        const cc = c(0x9ff6ff);
        this.burst(e.count ?? 10, () => ({ x: e.x + (R() - 0.5), y: y + 0.5, z: e.z + (R() - 0.5), vx: (R() - 0.5) * 3, vy: 1.5 + R() * 2, vz: (R() - 0.5) * 3, life: 0.9 + R() * 0.5, size: 0.1 + R() * 0.08, r: cc.r, g: cc.g, b: cc.b, gravity: 7, drag: 0.5 }), this.glow);
        break;
      }
      case 'anger': {
        const cc = c(0x9a2a4a);
        this.burst(e.count ?? 20, () => {
          const a = R() * Math.PI * 2;
          const r = R() * 25;
          return { x: e.x + Math.cos(a) * r, y: y + R() * 3, z: e.z + Math.sin(a) * r, vx: 0, vy: 0.4 + R() * 0.6, vz: 0, life: 3 + R() * 2, size: 0.5 + R() * 0.5, grow: 2, r: cc.r, g: cc.g, b: cc.b, a: 0.35, drag: 0.3, wobble: 0.4 };
        });
        break;
      }
      case 'steam':
      case 'glow':
      case 'divine': {
        const cc = c(e.kind === 'steam' ? 0xe8eef2 : 0xffe9a8);
        this.burst(e.count ?? 12, () => ({ x: e.x + (R() - 0.5) * 2, y: y + R(), z: e.z + (R() - 0.5) * 2, vx: (R() - 0.5) * 0.4, vy: 1 + R(), vz: (R() - 0.5) * 0.4, life: 1.5 + R(), size: e.kind === 'steam' ? 0.6 : 0.15, grow: e.kind === 'steam' ? 3 : 1, r: cc.r, g: cc.g, b: cc.b, a: e.kind === 'steam' ? 0.35 : 0.9, drag: 0.4 }), e.kind === 'steam' ? this.soft : this.glow);
        break;
      }
      case 'quake':
      case 'meteor':
      case 'wind':
      case 'zzz':
        break;
    }
  }

  private fell(r: ResourceNode, dirX: number, dirZ: number): void {
    const pivot = new Group();
    pivot.position.set(r.x, this.terrain.heightAt(r.x, r.z) + 0.3, r.z);
    const mesh = this.vegetation.treeMesh(r.variant);
    mesh.rotation.y = r.rot;
    mesh.scale.setScalar(r.scale);
    mesh.position.y = -0.3;
    pivot.add(mesh);
    this.group.add(pivot);
    // Fall away from the woodcutter: rotate about the horizontal axis perpendicular to the fall direction.
    this.falling.push({ mesh, pivot, t: 0, axisX: dirZ, axisZ: -dirX, landed: false });
    this.onFx({ kind: 'leaves', x: r.x, z: r.z, y: 2.5, count: 10 });
  }

  private strike(x: number, z: number): void {
    const y = this.ground(x, z);
    this.lightning.strike(new Vector3(x, y, z), this.camera);
    const white = col(0xfff8e0);
    this.burst(40, () => {
      const a = R() * Math.PI * 2;
      const s = 3 + R() * 6;
      return { x, y: y + 0.3, z, vx: Math.cos(a) * s, vy: 2 + R() * 5, vz: Math.sin(a) * s, life: 0.5 + R() * 0.5, size: 0.12, r: white.r, g: white.g, b: white.b, gravity: 12, drag: 1 };
    }, this.glow);
    this.onFx({ kind: 'dust', x, z, count: 20 });
    this.onFx({ kind: 'smoke', x, z, count: 8 });
    const d = this.camera.position.distanceTo(new Vector3(x, y, z));
    this.onFlash?.(Math.max(0.15, 1 - d / 200));
  }

  private syncScorches(scorches: readonly ScorchMark[]): void {
    const alive = new Set<number>();
    for (const s of scorches) {
      alive.add(s.id);
      let m = this.scorchMeshes.get(s.id);
      if (!m) {
        const g = this.scorchGeo.clone();
        const pos = g.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          const px = s.x + pos.getX(i) * s.radius * 2;
          const pz = s.z + pos.getZ(i) * s.radius * 2;
          pos.setXYZ(i, px, this.terrain.heightAt(px, pz) + 0.04, pz);
        }
        g.computeVertexNormals();
        m = new Mesh(g, makeScorchMaterial());
        m.renderOrder = 2;
        this.group.add(m);
        this.scorchMeshes.set(s.id, m);
      }
      (m.material as MeshBasicMaterial).opacity = 0.75 * (1 - s.age / (480 * 1.5));
    }
    for (const [id, m] of this.scorchMeshes) {
      if (alive.has(id)) continue;
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as MeshBasicMaterial).dispose();
      this.scorchMeshes.delete(id);
    }
  }

  update(dt: number, simDt: number, time: number, focus: Vector3, camDist: number, darkness: number): void {
    const w = this.world;
    // Falling trees: accelerate like a real fall, thud, then sink away.
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i]!;
      f.t += simDt;
      const fallT = Math.min(1, f.t / 1.5);
      const ang = Math.pow(fallT, 2.2) * (Math.PI / 2 - 0.08);
      f.pivot.rotation.set(0, 0, 0);
      f.pivot.rotateOnWorldAxis(new Vector3(f.axisX, 0, f.axisZ).normalize(), ang);
      if (fallT >= 1 && !f.landed) {
        f.landed = true;
        const p = f.pivot.position;
        const lx = p.x - f.axisZ * 2.5;
        const lz = p.z + f.axisX * 2.5;
        this.onFx({ kind: 'dust', x: lx, z: lz, count: 14 });
        this.onFx({ kind: 'leaves', x: lx, z: lz, y: 0.8, count: 12 });
      }
      if (f.t > 3) f.pivot.position.y -= simDt * 0.5;
      if (f.t > 5) {
        this.group.remove(f.pivot);
        this.falling.splice(i, 1);
      }
    }

    // Fire: flames and smoke from anything burning; nearby fires light up the night.
    this.emitAcc += simDt;
    const burning: Array<{ x: number; y: number; z: number; big: number }> = [];
    w.resourceHash.query(focus.x, focus.z, 140, (r) => {
      if (r.burning > 0) burning.push({ x: r.x, y: this.ground(r.x, r.z) + (r.kind === 'berryBush' ? 0.5 : 2.2 * r.scale), z: r.z, big: r.kind === 'berryBush' ? 0.6 : 1 });
    });
    for (const s of w.structures) if (s.burning > 0) burning.push({ x: s.x, y: this.ground(s.x, s.z) + 1.3, z: s.z, big: BLUEPRINTS[s.kind].radius * 0.8 });
    if (this.emitAcc > 0.05) {
      const steps = Math.min(4, Math.floor(this.emitAcc / 0.05));
      this.emitAcc -= steps * 0.05;
      const flame = col(0xff8a2a);
      const core = col(0xffd070);
      const smoke = col(0x3d3a38);
      for (let k = 0; k < steps; k++) {
        for (const b of burning) {
          for (let j = 0; j < 2; j++) {
            const c = R() < 0.4 ? core : flame;
            this.glow.spawn({ x: b.x + (R() - 0.5) * 1.6 * b.big, y: b.y + (R() - 0.5) * 1.2 * b.big, z: b.z + (R() - 0.5) * 1.6 * b.big, vx: (R() - 0.5) * 0.5, vy: 1.6 + R() * 1.6, vz: (R() - 0.5) * 0.5, life: 0.5 + R() * 0.4, size: (0.7 + R() * 0.6) * b.big, grow: 0.25, r: c.r, g: c.g, b: c.b, a: 0.9 });
          }
          if (R() < 0.35) this.soft.spawn({ x: b.x + (R() - 0.5), y: b.y + 1, z: b.z + (R() - 0.5), vx: 0.4, vy: 1.8 + R(), vz: 0.2, life: 3 + R() * 2, size: 0.9 * b.big, grow: 4, r: smoke.r, g: smoke.g, b: smoke.b, a: 0.45, drag: 0.2 });
        }
        // Gentle smoke and sparks from lit campfires.
        for (const s of w.structures) {
          if (s.kind !== 'campfire' || !s.lit) continue;
          const gy = this.ground(s.x, s.z);
          if (R() < 0.25) this.soft.spawn({ x: s.x + (R() - 0.5) * 0.3, y: gy + 1.1, z: s.z + (R() - 0.5) * 0.3, vx: 0.25, vy: 0.9 + R() * 0.4, vz: 0.1, life: 3.5, size: 0.35, grow: 4, r: 0.6, g: 0.58, b: 0.56, a: 0.28, drag: 0.1, wobble: 0.3 });
          if (R() < 0.18) this.glow.spawn({ x: s.x, y: gy + 0.6, z: s.z, vx: (R() - 0.5) * 0.6, vy: 1.4 + R(), vz: (R() - 0.5) * 0.6, life: 1.2, size: 0.06, r: 1, g: 0.6, b: 0.2, wobble: 0.8 });
        }
      }
    }
    burning.sort((a, b) => Math.hypot(a.x - focus.x, a.z - focus.z) - Math.hypot(b.x - focus.x, b.z - focus.z));
    this.fireLights.forEach((l, i) => {
      const b = burning[i];
      if (!b) {
        l.intensity = 0;
        return;
      }
      l.position.set(b.x, b.y + 0.8, b.z);
      l.intensity = (18 + Math.sin(time * 13 + i) * 4) * (0.4 + darkness);
    });

    // Little dust kicks from running feet (only near the camera).
    if (simDt > 0) {
      for (const a of w.agents) {
        if (!a.alive || a.anim !== 'run' || a.inside !== null) continue;
        if (Math.abs(a.x - focus.x) > 40 || Math.abs(a.z - focus.z) > 40) continue;
        const step = Math.floor(a.walkPhase / Math.PI);
        if (step === this.lastStep.get(a.id)) continue;
        this.lastStep.set(a.id, step);
        const gy = this.ground(a.x, a.z);
        if (gy < 0.3) continue;
        this.soft.spawn({ x: a.x, y: gy + 0.08, z: a.z, vx: (R() - 0.5) * 0.4, vy: 0.3, vz: (R() - 0.5) * 0.4, life: 0.6, size: 0.18, grow: 2, r: 0.85, g: 0.78, b: 0.62, a: 0.35, drag: 2 });
      }
    }

    // Fireflies drift over meadows near the camera at night.
    if (darkness > 0.6 && R() < dt * 25) {
      const x = focus.x + (R() - 0.5) * 50;
      const z = focus.z + (R() - 0.5) * 50;
      const h = this.terrain.heightAt(x, z);
      if (h > 1.3) this.glow.spawn({ x, y: h + 0.4 + R() * 1.2, z, vx: (R() - 0.5) * 0.3, vy: 0.05, vz: (R() - 0.5) * 0.3, life: 4 + R() * 3, size: 0.09, r: 0.85, g: 1, b: 0.45, wobble: 0.35, a: 0.9 });
    }

    this.divine.update(dt, simDt, time);
    this.soft.update(simDt > 0 ? dt : 0, time);
    this.glow.update(dt, time);
    this.rain.update(time, focus, camDist, w.weather.clouds, w.weather.windX, w.weather.windZ);
    this.lightning.update(dt);
    this.syncScorches(w.scorches);
  }

  addTo(parent: Object3D): void {
    parent.add(this.group);
  }
}

function makeScorchMaterial(): MeshBasicMaterial {
  // Soft dark stain with a ragged edge, drawn just above the ground.
  const m = new MeshBasicMaterial({ color: 0x1a1512, transparent: true, opacity: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  m.alphaMap = scorchAlpha();
  return m;
}

let _scorchTex: Texture | null = null;
function scorchAlpha(): Texture {
  if (_scorchTex) return _scorchTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.55, '#aaaaaa');
  grad.addColorStop(1, '#000000');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  // Ragged edge.
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(0,0,0,${0.3 + Math.random() * 0.5})`;
    const a = Math.random() * Math.PI * 2;
    g.beginPath();
    g.arc(32 + Math.cos(a) * 26, 32 + Math.sin(a) * 26, 3 + Math.random() * 5, 0, Math.PI * 2);
    g.fill();
  }
  _scorchTex = new CanvasTexture(c);
  return _scorchTex;
}
