import {
  AdditiveBlending,
  Color,
  ConeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PointLight,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { clamp01, smoothstep } from '../core/math';
import type { Terrain } from '../world/Terrain';
import { BLUEPRINTS } from '../sim/blueprints';
import type { Structure } from '../sim/types';
import { campfirePieces, gardenPieces, gravePieces, hutPieces, logPileGeometry, stakeRing, storagePieces, type Piece } from './structureGeometry';
import { prep } from './geometry';

interface Entry {
  s: Structure;
  root: Group;
  pieces: Array<{ mesh: Mesh; at: number; glow: boolean }>;
  stakes: Mesh | null;
  pile: InstancedMesh;
  flames: Mesh[];
  light: PointLight | null;
  glowMat: MeshBasicMaterial | null;
  basket: Mesh | null;
  shown: number[];
}

const ZERO = new Matrix4().makeScale(0, 0, 0);
const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();

/** Buildings with visible, piece-by-piece construction progress. */
export class StructureView {
  readonly group = new Group();
  private readonly entries = new Map<number, Entry>();
  private readonly mat = new MeshLambertMaterial({ vertexColors: true });
  private readonly flameMat = new MeshBasicMaterial({ color: 0xffa640, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false });
  private readonly flameCore = new MeshBasicMaterial({ color: 0xfff1b0, transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false });
  private readonly flameGeo = new ConeGeometry(0.22, 0.75, 7, 1, true);
  private readonly pileGeo = logPileGeometry();

  constructor(private readonly terrain: Terrain) {
    this.flameGeo.translate(0, 0.37, 0);
  }

  has(id: number): boolean {
    return this.entries.has(id);
  }

  add(s: Structure): void {
    if (this.entries.has(s.id)) return;
    const root = new Group();
    root.position.set(s.x, this.groundY(s), s.z);
    root.rotation.y = s.rot;
    root.name = `structure-${s.id}`;
    let defs: Piece[];
    switch (s.kind) {
      case 'hut':
        defs = hutPieces(s.id);
        break;
      case 'campfire':
        defs = campfirePieces(s.id);
        break;
      case 'storage':
        defs = storagePieces();
        break;
      case 'garden':
        defs = gardenPieces();
        break;
      default:
        defs = gravePieces();
    }
    let glowMat: MeshBasicMaterial | null = null;
    const pieces = defs.map((d) => {
      let mat = this.mat as MeshLambertMaterial | MeshBasicMaterial;
      if (d.glow) {
        glowMat = new MeshBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0 });
        mat = glowMat;
      }
      const mesh = new Mesh(d.geo, mat);
      mesh.castShadow = !d.glow;
      mesh.receiveShadow = true;
      mesh.visible = false;
      root.add(mesh);
      return { mesh, at: d.at, glow: !!d.glow };
    });
    let stakes: Mesh | null = null;
    if (s.kind !== 'grave') {
      stakes = new Mesh(stakeRing(Math.max(0.9, BLUEPRINTS[s.kind].radius - 0.5)), this.mat);
      stakes.castShadow = false;
      root.add(stakes);
    }
    const pile = new InstancedMesh(this.pileGeo, this.mat, 12);
    pile.castShadow = true;
    pile.frustumCulled = false;
    for (let i = 0; i < 12; i++) pile.setMatrixAt(i, ZERO);
    root.add(pile);

    const flames: Mesh[] = [];
    let light: PointLight | null = null;
    if (s.kind === 'campfire') {
      for (let i = 0; i < 3; i++) {
        const f = new Mesh(this.flameGeo, i === 0 ? this.flameCore : this.flameMat);
        f.position.set(Math.cos(i * 2.1) * 0.12 * (i ? 1 : 0), 0.08, Math.sin(i * 2.1) * 0.12 * (i ? 1 : 0));
        f.visible = false;
        f.renderOrder = 5;
        root.add(f);
        flames.push(f);
      }
      light = new PointLight(0xff9a45, 0, 16, 1.6);
      light.position.set(0, 1.0, 0);
      root.add(light);
    }
    let basket: Mesh | null = null;
    if (s.kind === 'storage' || s.kind === 'campfire') {
      const g = new SphereGeometry(0.28, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
      g.scale(1, 0.8, 1);
      const berries = prep(g, 0xc0283c);
      basket = new Mesh(berries, this.mat);
      basket.position.set(s.kind === 'storage' ? 1.35 : 1.0, s.kind === 'storage' ? 0.05 : 0.02, s.kind === 'storage' ? 1.25 : -0.8);
      basket.visible = false;
      root.add(basket);
    }
    this.group.add(root);
    const e: Entry = { s, root, pieces, stakes, pile, flames, light, glowMat, basket, shown: [] };
    this.entries.set(s.id, e);
    this.sync(s);
  }

  remove(id: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.group.remove(e.root);
    e.pile.dispose();
    e.glowMat?.dispose();
    this.entries.delete(id);
  }

  private groundY(s: Structure): number {
    // Sit on the lowest nearby point so no corner floats.
    let y = this.terrain.heightAt(s.x, s.z);
    const r = BLUEPRINTS[s.kind].radius * 0.6;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      y = Math.min(y, this.terrain.heightAt(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r));
    }
    return y - 0.02;
  }

  /** Update piece visibility and material piles after a state change. */
  sync(s: Structure): void {
    const e = this.entries.get(s.id);
    if (!e) return;
    e.s = s;
    const p = s.complete ? 1 : s.progress;
    for (const pc of e.pieces) pc.mesh.visible = !pc.glow ? p >= pc.at - 1e-4 : s.complete;
    if (e.stakes) e.stakes.visible = !s.complete && p < 0.5;
    // Delivered-but-unused materials sit in a neat pile beside the site.
    const bp = BLUEPRINTS[s.kind];
    const cost = bp.cost.wood ?? 0;
    const unused = s.complete ? 0 : Math.max(0, Math.round((s.delivered.wood ?? 0) - p * cost));
    const stored = s.complete ? s.stored.wood : 0;
    const logs = Math.min(12, unused + stored);
    const r = Math.max(bp.blockRadius, 0.7) + 0.9;
    for (let i = 0; i < 12; i++) {
      if (i < logs) {
        const row = Math.floor(i / 4);
        const col = i % 4;
        _p.set(-r * 0.2 + (row % 2) * 0.07, 0.08 + row * 0.13, -r + col * 0.16 - 0.25);
        _q.identity();
        _s.set(1, 1, 1);
        _m.compose(_p, _q, _s);
        _m.premultiply(new Matrix4().makeRotationY(Math.PI / 2 + 0.6));
        e.pile.setMatrixAt(i, _m);
      } else e.pile.setMatrixAt(i, ZERO);
    }
    e.pile.instanceMatrix.needsUpdate = true;
    if (e.basket) {
      const food = s.stored.berries + s.stored.fruit;
      e.basket.visible = s.complete && food > 0;
      const k = 0.5 + Math.min(1, food / 20) * 0.7;
      e.basket.scale.setScalar(k);
    }
  }

  /** Per-frame animation: fire flicker, lights, window glow, pieces popping in. */
  animate(time: number, darkness: number, occupied: (id: number) => number): void {
    for (const e of this.entries.values()) {
      const s = e.s;
      if (s.kind === 'campfire') {
        const lit = s.complete && s.lit;
        const size = lit ? 0.55 + s.fuel * 0.7 : 0;
        for (let i = 0; i < e.flames.length; i++) {
          const f = e.flames[i]!;
          f.visible = lit;
          if (!lit) continue;
          const fl = 0.85 + Math.sin(time * (9 + i * 3.1) + i) * 0.1 + Math.sin(time * 23 + i * 5) * 0.06;
          const k = size * (i === 0 ? 0.75 : 1) * fl;
          f.scale.set(k * (i === 0 ? 0.7 : 1), k * (1.05 + Math.sin(time * 7 + i) * 0.12), k * (i === 0 ? 0.7 : 1));
          f.rotation.y = time * (0.6 + i * 0.3);
        }
        if (e.light) {
          const flick = 0.85 + Math.sin(time * 11) * 0.08 + Math.sin(time * 17.3) * 0.07;
          e.light.intensity = lit ? (6 + s.fuel * 10) * flick * (0.35 + darkness * 0.9) : 0;
        }
      }
      if (e.glowMat) {
        const inside = occupied(s.id);
        const target = s.complete && inside > 0 ? smoothstep(0.35, 0.85, darkness) * 0.95 : 0;
        e.glowMat.opacity += (target - e.glowMat.opacity) * 0.05;
        e.glowMat.color.setRGB(1, 0.72 + Math.sin(time * 3 + s.id) * 0.03, 0.38);
      }
      // Burning buildings char and tilt slightly as they take damage.
      if (s.damage > 0) {
        const c = 1 - clamp01(s.damage) * 0.6;
        e.root.traverse((o: Object3D) => {
          const m = (o as Mesh).material as MeshLambertMaterial | undefined;
          if (m && m === this.mat) (o as Mesh).scale.setScalar(1 - s.damage * 0.08);
        });
        void c;
      }
    }
  }

  /** Temporary colour for a structure under construction when hovered (not used yet). */
  static readonly HIGHLIGHT = new Color(0xffffff);
}
