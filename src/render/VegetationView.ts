import {
  BufferGeometry,
  Color,
  Euler,
  Frustum,
  Group,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type Camera,
  type IUniform,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { Rng, hash01 } from '../core/rng';
import { Simplex2 } from '../core/noise';
import { smoothstep } from '../core/math';
import { NO_WATER, type Terrain } from '../world/Terrain';
import { WORLD_HALF, WORLD_SIZE } from '../world/config';
import { Biome } from '../world/biomes';
import { TreeVariant, type ResourceNode } from '../sim/types';
import {
  BERRY_SLOTS,
  FRUIT_SLOTS,
  broadleafTree,
  burntTreeGeometry,
  bushGeometry,
  flowerGeometry,
  fruitTree,
  grassTuftGeometry,
  palmTree,
  pebbleGeometry,
  pineTree,
  reedGeometry,
  rockGeometry,
  saplingGeometry,
  stumpGeometry,
} from './geometry';
import {
  birchTree,
  birchTreeLo,
  broadleafLo,
  bushLo,
  crystalCluster,
  crystalShards,
  deadwoodTree,
  deadwoodTreeLo,
  driftwoodGeometry,
  elderTree,
  elderTreeLo,
  fernGeometry,
  fruitTreeLo,
  glowPlantGeometry,
  heatherGeometry,
  mushroomPatch,
  palmLo,
  pineLo,
  rockLo,
  rubbleGeometry,
  silverbarkTree,
  silverbarkTreeLo,
} from './flora';
import { windMaterial, windUniforms } from './windMaterial';
import { applySeeThrough } from './seeThrough';
import { PAL } from './palette';
import { InstanceLayer, VCHUNK, VCHUNK_N, classifyChunks, type ChunkVis } from './InstanceLayer';

const _m = new Matrix4();
const _m2 = new Matrix4();
const _base = new Matrix4();
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _e = new Euler();
const _c = new Color();
const _frustum = new Frustum();
const _pv = new Matrix4();

interface Slots {
  main: number;
  /** Slot in the current state layer (stump/sapling/burnt/rubble/shards), -1 if none. */
  aux: number;
  auxLayer: InstanceLayer | null;
  /** First slot of berries/fruits (consecutive block). */
  sub: number;
}

/** Tints that make one species read differently from region to region. */
const BIOME_TINT: Partial<Record<number, [number, number, number]>> = {
  [Biome.Elderwood]: [0.82, 0.92, 0.82],
  [Biome.Highlands]: [0.9, 0.95, 0.92],
  [Biome.CrystalWilds]: [0.88, 1.02, 1.04],
  [Biome.Ashen]: [0.9, 0.88, 0.78],
  [Biome.Isles]: [1.02, 1.05, 0.95],
};

/**
 * Renders all resource nodes plus decorative ground cover. Everything lives in chunked instance
 * layers: only chunks in view are uploaded, near chunks use detailed shadow-casting models and far
 * chunks cheap ones. Ground cover is generated on demand around the camera.
 */
export class VegetationView {
  readonly group = new Group();
  private readonly terrain: Terrain;
  private readonly trees: InstanceLayer[] = [];
  private readonly fruitTrees: InstanceLayer;
  private readonly stumps: InstanceLayer;
  private readonly saplings: InstanceLayer;
  private readonly burnt: InstanceLayer;
  private readonly bushes: InstanceLayer;
  private readonly berries: InstanceLayer;
  private readonly fruits: InstanceLayer;
  private readonly rocks: InstanceLayer[] = [];
  private readonly rubble: InstanceLayer;
  private readonly mushrooms: InstanceLayer;
  private readonly crystals: InstanceLayer;
  private readonly shards: InstanceLayer;
  private readonly layers: InstanceLayer[] = [];
  private readonly decor: Record<string, InstanceLayer> = {};
  private readonly decorChunks = new Map<number, Array<{ layer: InstanceLayer; slot: number }>>();
  private readonly slots = new Map<number, Slots>();
  private readonly nodes = new Map<number, ResourceNode>();
  /** Resources animating (shake after a hit, growth pop-in). */
  private readonly active = new Map<number, number>();
  private readonly vis: ChunkVis = new Uint8Array(VCHUNK_N * VCHUNK_N);
  private readonly chunkH: Array<[number, number]> = [];
  readonly crystalMat: MeshLambertMaterial;
  readonly glowMat: MeshLambertMaterial;
  private readonly treeGeos: BufferGeometry[];
  private readonly treeMats: Material[];
  private frame = 0;

  constructor(terrain: Terrain, resources: ResourceNode[], wearTex: IUniform) {
    this.terrain = terrain;
    const leafMat = windMaterial({ amplitude: 0.0045, frequency: 1.1, flatShading: false, key: 'tree' });
    const bigMat = windMaterial({ amplitude: 0.0012, frequency: 0.7, flatShading: false, key: 'elder' });
    const palmMat = windMaterial({ amplitude: 0.006, frequency: 1.3, key: 'palm' });
    palmMat.side = 2;
    applySeeThrough(leafMat, 'tree');
    applySeeThrough(palmMat, 'palm');
    applySeeThrough(bigMat, 'elder');
    const plain = new MeshLambertMaterial({ vertexColors: true });
    const far = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const count = (pred: (r: ResourceNode) => boolean) => resources.filter(pred).length;

    this.treeGeos = [broadleafTree(11), pineTree(22), palmTree(33), elderTree(44), silverbarkTree(55), deadwoodTree(66), birchTree(77)];
    const treeLo = [broadleafLo(), pineLo(), palmLo(), elderTreeLo(), silverbarkTreeLo(), deadwoodTreeLo(), birchTreeLo()];
    this.treeMats = [leafMat, leafMat, palmMat, bigMat, leafMat, plain, leafMat];
    for (let v = 0; v < this.treeGeos.length; v++) {
      const n = count((r) => r.kind === 'tree' && r.variant === v);
      this.trees.push(this.layer(new InstanceLayer(`trees-${v}`, this.treeGeos[v]!, this.treeMats[v]!, treeLo[v]!, far, n + 64, { colors: true })));
    }
    const trees = count((r) => r.kind === 'tree');
    this.stumps = this.layer(new InstanceLayer('stumps', stumpGeometry(), plain, null, null, trees / 4 + 64));
    this.saplings = this.layer(new InstanceLayer('saplings', saplingGeometry(), windMaterial({ amplitude: 0.03, frequency: 1.6, key: 'sapling' }), null, null, trees / 4 + 64));
    this.burnt = this.layer(new InstanceLayer('burnt', burntTreeGeometry(), plain, null, null, trees / 4 + 64));

    const bushMat = windMaterial({ amplitude: 0.02, frequency: 1.4, key: 'bush' });
    applySeeThrough(bushMat, 'bush');
    const nb = count((r) => r.kind === 'berryBush');
    this.bushes = this.layer(new InstanceLayer('bushes', bushGeometry(5), bushMat, bushLo(), far, nb + 64, { colors: true }));
    this.berries = this.layer(new InstanceLayer('berries', new IcosahedronGeometry(0.09, 0), new MeshLambertMaterial({ color: PAL.berry, emissive: 0x3a0008, flatShading: true }), null, null, (nb + 64) * BERRY_SLOTS.length, { shadows: false }));
    const nf = count((r) => r.kind === 'fruitTree');
    this.fruitTrees = this.layer(new InstanceLayer('fruit-trees', fruitTree(7), leafMat, fruitTreeLo(), far, nf + 40, { colors: true }));
    this.fruits = this.layer(new InstanceLayer('fruits', new IcosahedronGeometry(0.16, 1), new MeshLambertMaterial({ color: PAL.fruit, emissive: 0x401200 }), null, null, (nf + 40) * FRUIT_SLOTS.length, { shadows: false }));
    const rockLoGeo = rockLo();
    for (let v = 0; v < 3; v++) {
      const n = count((r) => r.kind === 'rock' && r.variant === v);
      this.rocks.push(this.layer(new InstanceLayer(`rocks-${v}`, rockGeometry(100 + v), plain, rockLoGeo, far, n + 16, { colors: true })));
    }
    this.rubble = this.layer(new InstanceLayer('rubble', rubbleGeometry(), plain, null, null, 64));
    const nm = count((r) => r.kind === 'mushroom');
    this.mushrooms = this.layer(new InstanceLayer('mushrooms', mushroomPatch(3), plain, null, null, nm + 32));
    this.crystalMat = new MeshLambertMaterial({ vertexColors: true, emissive: 0x4a3f9a, emissiveIntensity: 0.4, flatShading: true });
    const nc = count((r) => r.kind === 'crystal');
    this.crystals = this.layer(new InstanceLayer('crystals', crystalCluster(9), this.crystalMat, crystalCluster(9), this.crystalMat, nc + 16));
    this.shards = this.layer(new InstanceLayer('shards', crystalShards(), this.crystalMat, null, null, nc + 16));

    for (const r of resources) this.register(r);

    // Ground cover (generated around the camera, never simulated).
    this.glowMat = new MeshLambertMaterial({ vertexColors: true, emissive: 0x3fd8c8, emissiveIntensity: 0.6 });
    const grassMat = makeGrassMaterial(wearTex);
    this.decor.grass = this.layer(new InstanceLayer('grass', grassTuftGeometry(77), grassMat, null, null, 40000, { colors: true, shadows: false }));
    this.decor.flower = this.layer(new InstanceLayer('flowers', flowerGeometry(), windMaterial({ amplitude: 0.2, frequency: 1.7, key: 'flower' }), null, null, 6000, { colors: true, shadows: false }));
    this.decor.fern = this.layer(new InstanceLayer('ferns', fernGeometry(4), windMaterial({ amplitude: 0.15, frequency: 1.2, key: 'fern' }), null, null, 6000, { colors: true, shadows: false }));
    this.decor.glow = this.layer(new InstanceLayer('glowplants', glowPlantGeometry(), this.glowMat, null, null, 1500, { colors: true, shadows: false }));
    this.decor.heather = this.layer(new InstanceLayer('heather', heatherGeometry(8), new MeshLambertMaterial({ vertexColors: true, flatShading: true }), null, null, 5000, { colors: true, shadows: false }));
    this.decor.pebble = this.layer(new InstanceLayer('pebbles', pebbleGeometry(), new MeshLambertMaterial({ vertexColors: true, flatShading: true }), null, null, 5000, { colors: true, shadows: false }));
    this.decor.reed = this.layer(new InstanceLayer('reeds', reedGeometry(3), windMaterial({ amplitude: 0.05, frequency: 1.2, key: 'reed' }), null, null, 4000, { shadows: true }));
    this.decor.drift = this.layer(new InstanceLayer('driftwood', driftwoodGeometry(), plain, null, null, 400, { shadows: true }));

    // Height range per chunk (for culling boxes).
    for (let cz = 0; cz < VCHUNK_N; cz++) {
      for (let cx = 0; cx < VCHUNK_N; cx++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let k = 0; k <= 4; k++) {
          for (let j = 0; j <= 4; j++) {
            const h = terrain.heightAt(cx * VCHUNK - WORLD_HALF + (k / 4) * VCHUNK, cz * VCHUNK - WORLD_HALF + (j / 4) * VCHUNK);
            lo = Math.min(lo, h);
            hi = Math.max(hi, h);
          }
        }
        this.chunkH.push([lo, hi]);
      }
    }
  }

  private layer(l: InstanceLayer): InstanceLayer {
    this.layers.push(l);
    this.group.add(l.hi);
    if (l.lo) this.group.add(l.lo);
    return l;
  }

  private mainLayer(r: ResourceNode): InstanceLayer | null {
    switch (r.kind) {
      case 'tree':
        return this.trees[r.variant] ?? this.trees[0]!;
      case 'berryBush':
        return this.bushes;
      case 'fruitTree':
        return this.fruitTrees;
      case 'rock':
        return this.rocks[r.variant] ?? this.rocks[0]!;
      case 'mushroom':
        return this.mushrooms;
      case 'crystal':
        return this.crystals;
    }
  }

  private register(r: ResourceNode): void {
    const main = this.mainLayer(r);
    if (!main) return;
    const slot: Slots = { main: main.alloc(), aux: -1, auxLayer: null, sub: -1 };
    if (r.kind === 'berryBush') {
      slot.sub = this.berries.alloc();
      for (let i = 1; i < BERRY_SLOTS.length; i++) this.berries.alloc();
    } else if (r.kind === 'fruitTree') {
      slot.sub = this.fruits.alloc();
      for (let i = 1; i < FRUIT_SLOTS.length; i++) this.fruits.alloc();
    }
    this.slots.set(r.id, slot);
    this.nodes.set(r.id, r);
    this.write(r);
  }

  /** A standalone copy of a tree (used for the felling animation). */
  treeMesh(variant: number): Mesh {
    const m = new Mesh(this.treeGeos[variant] ?? this.treeGeos[0]!, this.treeMats[variant] ?? this.treeMats[0]!);
    m.castShadow = true;
    return m;
  }

  /** Add a resource created after startup (god powers, regrowth, gardens). */
  addResource(r: ResourceNode): void {
    if (this.slots.has(r.id)) return;
    this.register(r);
    this.active.set(r.id, 0);
  }

  removeResource(id: number): void {
    const r = this.nodes.get(id);
    if (!r) return;
    const s = this.slots.get(id)!;
    this.mainLayer(r)?.set(s.main, null, 0, 0);
    if (s.auxLayer && s.aux >= 0) s.auxLayer.release(s.aux);
    this.nodes.delete(id);
    this.slots.delete(id);
  }

  /** Re-write matrices for a resource whose state changed. */
  sync(r: ResourceNode, shake = 0): void {
    this.write(r, shake);
  }

  /** Mark a resource to play a short hit/shake animation. */
  poke(id: number): void {
    this.active.set(id, 0);
  }

  private base(r: ResourceNode, scale: number, sink: number, shake: number, out: Matrix4): Matrix4 {
    const y = this.terrain.heightAt(r.x, r.z) - sink;
    _p.set(r.x, y, r.z);
    _e.set(Math.sin(shake * 40) * shake * 0.12, r.rot, Math.cos(shake * 33) * shake * 0.12);
    _q.setFromEuler(_e);
    _s.setScalar(scale);
    return out.compose(_p, _q, _s);
  }

  /** Put the resource's secondary model (stump, sapling...) in the right layer. */
  private aux(r: ResourceNode, s: Slots, layer: InstanceLayer | null, m: Matrix4 | null): void {
    if (s.auxLayer !== layer || !m) {
      if (s.auxLayer && s.aux >= 0) s.auxLayer.release(s.aux);
      s.auxLayer = null;
      s.aux = -1;
    }
    if (!layer || !m) return;
    if (s.aux < 0) {
      s.aux = layer.alloc();
      s.auxLayer = layer;
    }
    layer.set(s.aux, m, r.x, r.z);
  }

  private tint(r: ResourceNode, out: Color): Color {
    const h = hash01(r.id, 3);
    out.setRGB(1, 1, 1).offsetHSL((h - 0.5) * 0.05, (h - 0.5) * 0.15, (hash01(r.id, 9) - 0.5) * 0.1);
    const t = BIOME_TINT[this.terrain.biomeAt(r.x, r.z)];
    if (t && r.variant !== TreeVariant.Silverbark && r.variant !== TreeVariant.Elder) out.multiplyScalar(1).setRGB(out.r * t[0], out.g * t[1], out.b * t[2]);
    // A few trees on the high slopes turn gold.
    if (r.kind === 'tree' && r.variant === TreeVariant.Broadleaf && this.terrain.heightAt(r.x, r.z) > 14 && h > 0.7) out.setRGB(1.35, 1.05, 0.55);
    return out;
  }

  private write(r: ResourceNode, shake = 0): void {
    const s = this.slots.get(r.id);
    if (!s) return;
    const main = this.mainLayer(r)!;
    switch (r.kind) {
      case 'tree': {
        const grown = r.state === 'grown';
        main.set(s.main, grown ? this.base(r, r.scale * (r.burning > 0 ? 0.97 : 1), 0.05, shake, _m) : null, r.x, r.z);
        if (grown) {
          this.tint(r, _c);
          if (r.burning > 0) _c.setRGB(0.55, 0.4, 0.3);
          main.setColor(s.main, _c);
        }
        const aux = r.state === 'stump' ? this.stumps : r.state === 'sapling' ? this.saplings : r.state === 'burnt' ? this.burnt : null;
        const scale = r.state === 'sapling' ? r.scale * (0.35 + r.growth * 0.9) * (r.variant === TreeVariant.Elder ? 1.6 : 1) : r.scale * (r.variant === TreeVariant.Elder ? 2.6 : 1);
        this.aux(r, s, aux, aux ? this.base(r, scale, 0.05, shake, _m2) : null);
        break;
      }
      case 'berryBush': {
        const visible = r.state !== 'burnt' && r.state !== 'stump';
        const scale = r.scale * (r.state === 'sapling' ? 0.4 + r.growth * 0.6 : 1);
        main.set(s.main, visible ? this.base(r, scale, 0.05, shake, _m) : null, r.x, r.z);
        main.setColor(s.main, r.blessed ? _c.setRGB(1.1, 1.15, 0.85) : this.tint(r, _c));
        this.base(r, scale, 0.05, shake, _base);
        for (let i = 0; i < BERRY_SLOTS.length; i++) {
          if (visible && i < r.amount && r.state === 'grown') {
            const [bx, by, bz] = BERRY_SLOTS[i]!;
            _m2.makeTranslation(bx, by, bz);
            this.berries.set(s.sub + i, _m.multiplyMatrices(_base, _m2), r.x, r.z);
          } else this.berries.set(s.sub + i, null, r.x, r.z);
        }
        break;
      }
      case 'fruitTree': {
        const visible = r.state === 'grown' || r.state === 'sapling';
        const scale = r.scale * (r.state === 'sapling' ? 0.35 + r.growth * 0.65 : 1);
        main.set(s.main, visible ? this.base(r, scale, 0.05, shake, _m) : null, r.x, r.z);
        main.setColor(s.main, r.blessed ? _c.setRGB(1.05, 1.15, 0.9) : _c.setRGB(1, 1, 1));
        this.base(r, scale, 0.05, shake, _base);
        for (let i = 0; i < FRUIT_SLOTS.length; i++) {
          if (visible && r.state === 'grown' && i < r.amount) {
            const [fx, fy, fz] = FRUIT_SLOTS[i]!;
            _m2.makeTranslation(fx, fy, fz);
            this.fruits.set(s.sub + i, _m.multiplyMatrices(_base, _m2), r.x, r.z);
          } else this.fruits.set(s.sub + i, null, r.x, r.z);
        }
        this.aux(r, s, r.state === 'burnt' ? this.burnt : null, r.state === 'burnt' ? this.base(r, r.scale, 0.05, 0, _m2) : null);
        break;
      }
      case 'rock': {
        const whole = r.state !== 'stump';
        // Quarried boulders shrink as stone is taken.
        const left = r.max > 0 ? 0.55 + 0.45 * (r.amount / r.max) : 1;
        main.set(s.main, whole ? this.base(r, r.scale * left, 0.15, shake * 0.3, _m) : null, r.x, r.z);
        const b = this.terrain.biomeAt(r.x, r.z);
        _c.setRGB(1, 1, 1);
        if (b === Biome.Ashen) _c.setRGB(0.42, 0.38, 0.38);
        else if (b === Biome.CrystalWilds) _c.setRGB(0.92, 0.88, 1.08);
        else if (b === Biome.Elderwood) _c.setRGB(0.85, 0.95, 0.8);
        main.setColor(s.main, _c.offsetHSL(0, 0, (hash01(r.id, 4) - 0.5) * 0.08));
        this.aux(r, s, whole ? null : this.rubble, whole ? null : this.base(r, r.scale, 0.05, 0, _m2));
        break;
      }
      case 'mushroom': {
        const visible = r.state === 'grown' && r.amount > 0;
        const k = visible ? 0.45 + 0.55 * Math.min(1, r.amount / Math.max(1, r.max)) : 0;
        main.set(s.main, visible ? this.base(r, r.scale * k, 0.02, shake, _m) : null, r.x, r.z);
        break;
      }
      case 'crystal': {
        const whole = r.state === 'grown' && r.amount > 0;
        const left = r.max > 0 ? 0.5 + 0.5 * (r.amount / r.max) : 1;
        main.set(s.main, whole ? this.base(r, r.scale * left, 0.1, shake * 0.3, _m) : null, r.x, r.z);
        this.aux(r, s, whole ? null : this.shards, whole ? null : this.base(r, r.scale, 0.05, 0, _m2));
        break;
      }
    }
  }

  /** Per-frame: animate hits, cull and pick detail levels, stream ground cover. */
  update(dt: number, time: number, camera?: Camera, focus?: Vector3, darkness = 0): void {
    windUniforms.uWindTime.value = time;
    this.crystalMat.emissiveIntensity = 0.35 + darkness * 0.9 + Math.sin(time * 1.3) * 0.08;
    this.glowMat.emissiveIntensity = 0.3 + darkness * 1.4;
    for (const [id, t] of this.active) {
      const r = this.nodes.get(id);
      const nt = t + dt;
      if (!r || nt > 0.6) {
        this.active.delete(id);
        if (r) this.sync(r, 0);
        continue;
      }
      this.active.set(id, nt);
      this.sync(r, (0.6 - nt) / 0.6);
    }
    if (!camera) return;
    this.frame++;
    if (focus && this.frame % 10 === 1) this.streamDecor(focus, camera.position);
    camera.updateMatrixWorld();
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    const camY = camera.position.y;
    // Near detail reaches further when looking from high up (fewer, larger things on screen).
    const near = 95 + Math.min(80, camY * 0.25);
    const far = Math.max(520, camY * 1.9 + 200);
    const changed = classifyChunks(this.vis, _frustum, camera.position, near, far, (cx, cz) => this.chunkH[cz * VCHUNK_N + cx]!);
    for (const l of this.layers) if (changed || l.dirty) l.refresh(this.vis);
  }

  get drawnInstances(): number {
    let n = 0;
    for (const l of this.layers) n += l.drawn;
    return n;
  }

  // -------------------------------------------------------------------------
  // Decorative ground cover (not part of the simulation)
  // -------------------------------------------------------------------------

  private streamDecor(focus: Vector3, cam: Vector3): void {
    const height = Math.max(0, cam.y - focus.y);
    // No ground cover at all from far above: it would be sub-pixel anyway.
    const radius = height > 130 ? 0 : 118;
    const keep = radius + 40;
    for (const [c, list] of this.decorChunks) {
      const cx = (c % VCHUNK_N) * VCHUNK - WORLD_HALF + VCHUNK / 2;
      const cz = Math.floor(c / VCHUNK_N) * VCHUNK - WORLD_HALF + VCHUNK / 2;
      if (Math.hypot(cx - focus.x, cz - focus.z) > keep || radius === 0) {
        for (const e of list) e.layer.release(e.slot);
        this.decorChunks.delete(c);
      }
    }
    if (radius === 0) return;
    let built = 0;
    const r = Math.ceil(radius / VCHUNK);
    const fcx = Math.floor((focus.x + WORLD_HALF) / VCHUNK);
    const fcz = Math.floor((focus.z + WORLD_HALF) / VCHUNK);
    const todo: Array<[number, number]> = [];
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = fcx + dx;
        const cz = fcz + dz;
        if (cx < 0 || cz < 0 || cx >= VCHUNK_N || cz >= VCHUNK_N) continue;
        const c = cz * VCHUNK_N + cx;
        if (this.decorChunks.has(c)) continue;
        const d = Math.hypot(cx * VCHUNK - WORLD_HALF + VCHUNK / 2 - focus.x, cz * VCHUNK - WORLD_HALF + VCHUNK / 2 - focus.z);
        if (d > radius) continue;
        todo.push([c, d]);
      }
    }
    todo.sort((a, b) => a[1] - b[1]);
    for (const [c] of todo) {
      if (built++ >= 3) break;
      this.decorChunks.set(c, this.buildDecor(c));
    }
  }

  private readonly clump = new Simplex2(4242);
  private readonly flowerCols = [0xffffff, 0xffe066, 0xff8fb1, 0xc9a0ff, 0xff9f45, 0x8fd3ff].map((h) => new Color(h));

  private buildDecor(c: number): Array<{ layer: InstanceLayer; slot: number }> {
    const t = this.terrain;
    const out: Array<{ layer: InstanceLayer; slot: number }> = [];
    const rng = new Rng(0x9001 + c * 7919);
    const x0 = (c % VCHUNK_N) * VCHUNK - WORLD_HALF;
    const z0 = Math.floor(c / VCHUNK_N) * VCHUNK - WORLD_HALF;
    const put = (layer: InstanceLayer, x: number, y: number, z: number, scale: number, sy = scale, color?: Color, tilt = 0) => {
      const slot = layer.alloc();
      _p.set(x, y, z);
      _q.setFromEuler(_e.set(tilt ? rng.range(-tilt, tilt) : 0, rng.range(0, Math.PI * 2), tilt ? rng.range(-tilt, tilt) : 0));
      _s.set(scale, sy, scale);
      layer.set(slot, _m.compose(_p, _q, _s), x, z);
      if (color) layer.setColor(slot, color);
      out.push({ layer, slot });
    };
    const grassTint: Record<number, Color> = {
      [Biome.Greenheart]: new Color(1, 1.02, 0.95),
      [Biome.Elderwood]: new Color(0.78, 0.9, 0.78),
      [Biome.Highlands]: new Color(1.05, 1.0, 0.82),
      [Biome.CrystalWilds]: new Color(0.85, 1.05, 1.02),
      [Biome.Ashen]: new Color(0.9, 0.85, 0.62),
      [Biome.Coast]: new Color(1.05, 1.05, 0.85),
      [Biome.Isles]: new Color(1.05, 1.08, 0.9),
    };
    const tries = 1700;
    for (let k = 0; k < tries; k++) {
      const x = x0 + rng.next() * VCHUNK;
      const z = z0 + rng.next() * VCHUNK;
      const h = t.heightAt(x, z);
      if (h < -0.6) continue;
      const b = t.biomeAt(x, z);
      const wl = t.waterLevelAt(x, z);
      if (wl > NO_WATER && h < wl + 0.02) {
        // Reeds stand in the shallows.
        if (h > wl - 0.45 && rng.chance(0.25)) put(this.decor.reed!, x, h - 0.05, z, rng.range(0.8, 1.3));
        continue;
      }
      if (h < 0.05) continue;
      const slope = t.slopeAt(x, z);
      const m = t.moistureAt(x, z);
      const cl = this.clump.fbm(x * 0.12, z * 0.12, 2) * 0.5 + 0.5;
      // Reeds along the banks too.
      if (wl > NO_WATER && h < wl + 0.35 && rng.chance(0.2)) {
        put(this.decor.reed!, x, h - 0.05, z, rng.range(0.8, 1.2));
        continue;
      }
      const roll = rng.next();
      if (h < 1.3) {
        if (roll < 0.03) put(this.decor.pebble!, x, h - 0.05, z, rng.range(0.1, 0.3), undefined, undefined, 0.3);
        else if (roll < 0.034 && b !== Biome.Ashen) put(this.decor.drift!, x, h, z, rng.range(0.8, 1.2));
        continue;
      }
      if (h > 34 || slope > 0.9) {
        if (roll < 0.05) put(this.decor.pebble!, x, h - 0.05, z, rng.range(0.12, 0.35), undefined, undefined, 0.3);
        continue;
      }
      switch (b) {
        case Biome.Elderwood:
          if (roll < 0.05) put(this.decor.fern!, x, h - 0.02, z, rng.range(0.8, 1.5), undefined, _c.setRGB(0.9 + rng.next() * 0.2, 1, 0.9));
          else if (roll < 0.0535) put(this.decor.glow!, x, h - 0.02, z, rng.range(0.8, 1.3), undefined, _c.setRGB(0.6, 1.0, 0.95));
          else if (roll < 0.3 && cl > 0.45) put(this.decor.grass!, x, h - 0.02, z, rng.range(0.7, 1.2), undefined, grassTint[b]);
          break;
        case Biome.CrystalWilds:
          if (roll < 0.012) put(this.decor.glow!, x, h - 0.02, z, rng.range(0.8, 1.4), undefined, _c.setRGB(0.75, 0.7, 1.05));
          else if (roll < 0.05) put(this.decor.flower!, x, h - 0.02, z, rng.range(0.8, 1.3), undefined, _c.set(roll < 0.03 ? 0xbfe8ff : 0xd9c8ff));
          else if (roll < 0.38 && cl > 0.35) put(this.decor.grass!, x, h - 0.02, z, rng.range(0.75, 1.3), undefined, grassTint[b]);
          break;
        case Biome.Highlands:
          if (roll < 0.06) put(this.decor.heather!, x, h - 0.03, z, rng.range(0.8, 1.5), undefined, _c.set(roll < 0.03 ? 0x9a6fb0 : 0x7a8f4a));
          else if (roll < 0.075) put(this.decor.pebble!, x, h - 0.05, z, rng.range(0.12, 0.3), undefined, undefined, 0.3);
          else if (roll < 0.09) put(this.decor.flower!, x, h - 0.02, z, rng.range(0.7, 1.0), undefined, this.flowerCols[0]);
          else if (roll < 0.36 && cl > 0.4) put(this.decor.grass!, x, h - 0.02, z, rng.range(0.6, 1.1), undefined, grassTint[b]);
          break;
        case Biome.Ashen:
          if (roll < 0.035) put(this.decor.heather!, x, h - 0.03, z, rng.range(0.7, 1.2), undefined, _c.set(roll < 0.015 ? 0x8a5a3a : 0x6b7040));
          else if (roll < 0.06) put(this.decor.pebble!, x, h - 0.05, z, rng.range(0.15, 0.4), undefined, _c.setRGB(0.4, 0.37, 0.36), 0.3);
          else if (roll < 0.14 && cl > 0.6) put(this.decor.grass!, x, h - 0.02, z, rng.range(0.6, 1.0), undefined, grassTint[b]);
          break;
        default: {
          // Valley, coast and isles: grass clumps, wildflower meadows.
          const density = smoothstep(0.25, 0.75, cl) * (1 - smoothstep(0.6, 0.85, m) * 0.6);
          if (roll < 0.045 && m < 0.62 && this.clump.noise(x * 0.07 + 30, z * 0.07 - 12) > 0.1) {
            const idx = Math.floor((this.clump.noise(x * 0.03, z * 0.03) * 0.5 + 0.5) * this.flowerCols.length * 0.999 + rng.range(0, 1.2)) % this.flowerCols.length;
            put(this.decor.flower!, x, h - 0.02, z, rng.range(0.8, 1.3), undefined, this.flowerCols[idx]);
          } else if (roll < 0.05 + density * 0.55) put(this.decor.grass!, x, h - 0.02, z, rng.range(0.75, 1.45) * (0.8 + cl * 0.4), undefined, grassTint[b] ?? grassTint[Biome.Greenheart]);
          else if (slope > 0.4 && roll > 0.97) put(this.decor.pebble!, x, h - 0.05, z, rng.range(0.1, 0.3), undefined, undefined, 0.3);
        }
      }
    }
    return out;
  }
}

function makeGrassMaterial(wearTex: IUniform): MeshLambertMaterial {
  const mat = windMaterial({ amplitude: 0.35, frequency: 1.9, key: 'grass' });
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, r) => {
    prev.call(mat, shader, r);
    shader.uniforms.uWearTex = wearTex;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D uWearTex;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  vec3 gp = vec3(0.0);
  #ifdef USE_INSTANCING
    gp = instanceMatrix[3].xyz;
  #endif
  float wear = texture2D(uWearTex, (gp.xz + ${WORLD_HALF.toFixed(1)}) / ${WORLD_SIZE.toFixed(1)}).r;
  transformed.y *= 1.0 - smoothstep(0.05, 0.6, wear) * 0.92;
}`,
      );
  };
  mat.customProgramCacheKey = () => 'grass-wear';
  return mat;
}

export { VCHUNK };
