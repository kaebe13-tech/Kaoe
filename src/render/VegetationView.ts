import {
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Euler,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type IUniform,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { Rng, hash01 } from '../core/rng';
import { Simplex2 } from '../core/noise';
import { smoothstep } from '../core/math';
import type { Terrain } from '../world/Terrain';
import { ISLAND_RADIUS, WORLD_HALF, WORLD_SIZE } from '../world/config';
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
import { windMaterial, windUniforms } from './windMaterial';
import { applySeeThrough } from './seeThrough';
import { PAL } from './palette';

const _m = new Matrix4();
const _m2 = new Matrix4();
const _base = new Matrix4();
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _e = new Euler();
const _c = new Color();
const ZERO = new Matrix4().makeScale(0, 0, 0);

interface Slots {
  tree: number; // index within its variant mesh
  aux: number; // unused (kept for layout compatibility)
}

/** Free-list allocator so rarely used instance buffers only draw what's in use. */
class SlotPool {
  private free: number[] = [];
  private high = 0;
  readonly owner = new Map<number, number>();

  constructor(private readonly mesh: InstancedMesh) {
    mesh.count = 0;
  }

  get(id: number): number {
    let s = this.owner.get(id);
    if (s !== undefined) return s;
    s = this.free.length ? this.free.pop()! : this.high++;
    if (s >= this.mesh.instanceMatrix.count) {
      this.high--;
      return -1;
    }
    this.owner.set(id, s);
    this.mesh.count = Math.max(this.mesh.count, s + 1);
    return s;
  }

  release(id: number): void {
    const s = this.owner.get(id);
    if (s === undefined) return;
    this.owner.delete(id);
    this.mesh.setMatrixAt(s, ZERO);
    this.free.push(s);
  }
}

/**
 * Renders all resource nodes with instancing. Each resource owns fixed slots so state changes
 * (felled, regrowing, burnt, harvested) are a cheap matrix update.
 */
export class VegetationView {
  readonly group = new Group();
  private readonly terrain: Terrain;
  private readonly treeMeshes: InstancedMesh[] = [];
  private readonly stumps: InstancedMesh;
  private readonly saplings: InstancedMesh;
  private readonly burnt: InstancedMesh;
  private readonly bushes: InstancedMesh;
  private readonly berries: InstancedMesh;
  private readonly fruitTrees: InstancedMesh;
  private readonly fruits: InstancedMesh;
  private readonly rocks: InstancedMesh[] = [];
  private readonly slots = new Map<number, Slots>();
  private readonly nodes = new Map<number, ResourceNode>();
  /** Resources animating (shake after a hit, growth pop-in). */
  private readonly active = new Map<number, number>();

  constructor(terrain: Terrain, resources: ResourceNode[], wearTex: IUniform) {
    this.terrain = terrain;
    const trees = resources.filter((r) => r.kind === 'tree');
    const counts = [0, 0, 0];
    for (const t of trees) counts[t.variant]!++;

    const leafMat = windMaterial({ amplitude: 0.0045, frequency: 1.1, flatShading: false, key: 'tree' });
    const palmMat = windMaterial({ amplitude: 0.006, frequency: 1.3, key: 'palm' });
    palmMat.side = 2; // DoubleSide for leaf planes
    applySeeThrough(leafMat, 'tree');
    applySeeThrough(palmMat, 'palm');
    const geos: BufferGeometry[] = [broadleafTree(11), pineTree(22), palmTree(33)];
    for (let v = 0; v < 3; v++) {
      const mesh = new InstancedMesh(geos[v]!, v === TreeVariant.Palm ? palmMat : leafMat, Math.max(1, counts[v]! + 64));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.count = mesh.instanceMatrix.count;
      mesh.name = `trees-${v}`;
      this.treeMeshes.push(mesh);
      this.group.add(mesh);
    }
    const plain = new MeshLambertMaterial({ vertexColors: true });
    const cap = trees.length + 64;
    this.stumps = this.makeMesh(stumpGeometry(), plain, cap, 'stumps');
    this.saplings = this.makeMesh(saplingGeometry(), windMaterial({ amplitude: 0.03, frequency: 1.6, key: 'sapling' }), cap, 'saplings');
    this.burnt = this.makeMesh(burntTreeGeometry(), plain, cap, 'burnt');
    this.stumpPool = new SlotPool(this.stumps);
    this.saplingPool = new SlotPool(this.saplings);
    this.burntPool = new SlotPool(this.burnt);

    const bushes = resources.filter((r) => r.kind === 'berryBush');
    const bushCap = bushes.length + 48;
    const bushMat = windMaterial({ amplitude: 0.02, frequency: 1.4, key: 'bush' });
    applySeeThrough(bushMat, 'bush');
    this.bushes = this.makeMesh(bushGeometry(5), bushMat, bushCap, 'bushes');
    const berryGeo = new IcosahedronGeometry(0.09, 0);
    this.berries = this.makeMesh(berryGeo, new MeshLambertMaterial({ color: PAL.berry, emissive: 0x3a0008, flatShading: true }), bushCap * BERRY_SLOTS.length, 'berries');
    this.berries.castShadow = false;

    const fts = resources.filter((r) => r.kind === 'fruitTree');
    const ftCap = fts.length + 40;
    this.fruitTrees = this.makeMesh(fruitTree(7), leafMat, ftCap, 'fruit-trees');
    this.fruits = this.makeMesh(new IcosahedronGeometry(0.16, 1), new MeshLambertMaterial({ color: PAL.fruit, emissive: 0x401200 }), ftCap * FRUIT_SLOTS.length, 'fruits');

    const rockCounts = [0, 0, 0];
    for (const r of resources) if (r.kind === 'rock') rockCounts[r.variant]!++;
    for (let v = 0; v < 3; v++) {
      const mesh = this.makeMesh(rockGeometry(100 + v), plain, rockCounts[v]! + 4, `rocks-${v}`);
      this.rocks.push(mesh);
    }

    // Assign slots and write initial matrices.
    const treeIdx = [0, 0, 0];
    let aux = 0;
    const rockIdx = [0, 0, 0];
    let bushIdx = 0;
    let ftIdx = 0;
    for (const r of resources) {
      let slot: Slots;
      if (r.kind === 'tree') slot = { tree: treeIdx[r.variant]!++, aux: aux++ };
      else if (r.kind === 'berryBush') slot = { tree: bushIdx++, aux: -1 };
      else if (r.kind === 'fruitTree') slot = { tree: ftIdx++, aux: -1 };
      else slot = { tree: rockIdx[r.variant]!++, aux: -1 };
      this.slots.set(r.id, slot);
      this.nodes.set(r.id, r);
    }
    this.nextFree = { tree: treeIdx, aux, bush: bushIdx, ft: ftIdx };
    for (const r of resources) this.write(r);
    for (const m of this.allMeshes()) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    }

    this.buildGroundCover(resources, wearTex);
  }

  private nextFree: { tree: number[]; aux: number; bush: number; ft: number };
  private stumpPool!: SlotPool;
  private saplingPool!: SlotPool;
  private burntPool!: SlotPool;

  /** A standalone copy of a tree (used for the felling animation). */
  treeMesh(variant: number): Mesh {
    const src = this.treeMeshes[variant] ?? this.treeMeshes[0]!;
    const m = new Mesh(src.geometry, src.material);
    m.castShadow = true;
    return m;
  }

  private makeMesh(geo: BufferGeometry, mat: Material, cap: number, name: string): InstancedMesh {
    const mesh = new InstancedMesh(geo, mat, Math.max(1, cap));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, ZERO);
    mesh.name = name;
    this.group.add(mesh);
    return mesh;
  }

  private allMeshes(): InstancedMesh[] {
    return [...this.treeMeshes, this.stumps, this.saplings, this.burnt, this.bushes, this.berries, this.fruitTrees, this.fruits, ...this.rocks];
  }

  /** Add a resource created after startup (god powers, regrowth, gardens). */
  addResource(r: ResourceNode): void {
    if (this.slots.has(r.id)) return;
    let slot: Slots;
    if (r.kind === 'tree') slot = { tree: this.nextFree.tree[r.variant]!++, aux: this.nextFree.aux++ };
    else if (r.kind === 'berryBush') slot = { tree: this.nextFree.bush++, aux: -1 };
    else if (r.kind === 'fruitTree') slot = { tree: this.nextFree.ft++, aux: -1 };
    else return;
    this.slots.set(r.id, slot);
    this.nodes.set(r.id, r);
    this.active.set(r.id, 0);
    this.sync(r);
  }

  removeResource(id: number): void {
    const r = this.nodes.get(id);
    if (!r) return;
    r.state = 'stump';
    r.amount = 0;
    this.hide(r);
    this.nodes.delete(id);
    this.slots.delete(id);
  }

  /** Re-write matrices for a resource whose state changed. */
  sync(r: ResourceNode, shake = 0): void {
    this.write(r, shake);
    this.flag(r);
  }

  /** Mark a resource to play a short hit/shake animation. */
  poke(id: number): void {
    this.active.set(id, 0);
  }

  private flag(r: ResourceNode): void {
    if (r.kind === 'tree') {
      this.treeMeshes[r.variant]!.instanceMatrix.needsUpdate = true;
      this.stumps.instanceMatrix.needsUpdate = true;
      this.saplings.instanceMatrix.needsUpdate = true;
      this.burnt.instanceMatrix.needsUpdate = true;
    } else if (r.kind === 'berryBush') {
      this.bushes.instanceMatrix.needsUpdate = true;
      this.berries.instanceMatrix.needsUpdate = true;
    } else if (r.kind === 'fruitTree') {
      this.fruitTrees.instanceMatrix.needsUpdate = true;
      this.fruits.instanceMatrix.needsUpdate = true;
    }
  }

  private hide(r: ResourceNode): void {
    const s = this.slots.get(r.id);
    if (!s) return;
    if (r.kind === 'tree') {
      this.treeMeshes[r.variant]!.setMatrixAt(s.tree, ZERO);
      this.stumpPool.release(r.id);
      this.saplingPool.release(r.id);
      this.burntPool.release(r.id);
    } else if (r.kind === 'berryBush') {
      this.bushes.setMatrixAt(s.tree, ZERO);
      for (let i = 0; i < BERRY_SLOTS.length; i++) this.berries.setMatrixAt(s.tree * BERRY_SLOTS.length + i, ZERO);
    } else if (r.kind === 'fruitTree') {
      this.fruitTrees.setMatrixAt(s.tree, ZERO);
      for (let i = 0; i < FRUIT_SLOTS.length; i++) this.fruits.setMatrixAt(s.tree * FRUIT_SLOTS.length + i, ZERO);
    }
    this.flag(r);
  }

  private base(r: ResourceNode, scale: number, sink: number, shake: number, out: Matrix4): Matrix4 {
    const y = this.terrain.heightAt(r.x, r.z) - sink;
    _p.set(r.x, y, r.z);
    _e.set(Math.sin(shake * 40) * shake * 0.12, r.rot, Math.cos(shake * 33) * shake * 0.12);
    _q.setFromEuler(_e);
    _s.setScalar(scale);
    return out.compose(_p, _q, _s);
  }

  private write(r: ResourceNode, shake = 0): void {
    const s = this.slots.get(r.id);
    if (!s) return;
    switch (r.kind) {
      case 'tree': {
        const main = this.treeMeshes[r.variant]!;
        const grownScale = r.scale;
        main.setMatrixAt(s.tree, r.state === 'grown' ? this.base(r, grownScale * (r.burning > 0 ? 0.97 : 1), 0.05, shake, _m) : ZERO);
        const pooled = (pool: SlotPool, mesh: InstancedMesh, visible: boolean, scale: number) => {
          if (!visible) {
            pool.release(r.id);
            return;
          }
          const idx = pool.get(r.id);
          if (idx >= 0) mesh.setMatrixAt(idx, this.base(r, scale, 0.05, shake, _m));
        };
        pooled(this.stumpPool, this.stumps, r.state === 'stump', r.scale);
        pooled(this.saplingPool, this.saplings, r.state === 'sapling', r.scale * (0.35 + r.growth * 0.9));
        pooled(this.burntPool, this.burnt, r.state === 'burnt', r.scale);
        if (r.state === 'grown') {
          const h = hash01(r.id, 3);
          _c.setRGB(1, 1, 1).offsetHSL((h - 0.5) * 0.05, (h - 0.5) * 0.15, (hash01(r.id, 9) - 0.5) * 0.1);
          if (r.burning > 0) _c.setRGB(0.55, 0.4, 0.3);
          main.setColorAt(s.tree, _c);
          if (main.instanceColor) main.instanceColor.needsUpdate = true;
        }
        break;
      }
      case 'berryBush': {
        const visible = r.state !== 'burnt' && r.state !== 'stump';
        const scale = r.scale * (r.state === 'sapling' ? 0.4 + r.growth * 0.6 : 1);
        this.bushes.setMatrixAt(s.tree, visible ? this.base(r, scale, 0.05, shake, _m) : ZERO);
        if (r.blessed) {
          this.bushes.setColorAt(s.tree, _c.setRGB(1.1, 1.15, 0.85));
          if (this.bushes.instanceColor) this.bushes.instanceColor.needsUpdate = true;
        }
        this.base(r, scale, 0.05, shake, _base);
        for (let i = 0; i < BERRY_SLOTS.length; i++) {
          const idx = s.tree * BERRY_SLOTS.length + i;
          if (visible && i < r.amount && r.state === 'grown') {
            const [bx, by, bz] = BERRY_SLOTS[i]!;
            _m2.makeTranslation(bx, by, bz);
            this.berries.setMatrixAt(idx, _m.multiplyMatrices(_base, _m2));
          } else this.berries.setMatrixAt(idx, ZERO);
        }
        break;
      }
      case 'fruitTree': {
        const visible = r.state === 'grown' || r.state === 'sapling';
        const scale = r.scale * (r.state === 'sapling' ? 0.35 + r.growth * 0.65 : 1);
        this.fruitTrees.setMatrixAt(s.tree, visible ? this.base(r, scale, 0.05, shake, _m) : ZERO);
        if (r.blessed) {
          this.fruitTrees.setColorAt(s.tree, _c.setRGB(1.05, 1.15, 0.9));
          if (this.fruitTrees.instanceColor) this.fruitTrees.instanceColor.needsUpdate = true;
        }
        this.base(r, scale, 0.05, shake, _base);
        for (let i = 0; i < FRUIT_SLOTS.length; i++) {
          const idx = s.tree * FRUIT_SLOTS.length + i;
          if (visible && r.state === 'grown' && i < r.amount) {
            const [fx, fy, fz] = FRUIT_SLOTS[i]!;
            _m2.makeTranslation(fx, fy, fz);
            this.fruits.setMatrixAt(idx, _m.multiplyMatrices(_base, _m2));
          } else this.fruits.setMatrixAt(idx, ZERO);
        }
        break;
      }
      case 'rock': {
        const mesh = this.rocks[r.variant]!;
        mesh.setMatrixAt(s.tree, this.base(r, r.scale, 0.15, 0, _m));
        break;
      }
    }
  }

  update(dt: number, time: number): void {
    windUniforms.uWindTime.value = time;
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
  }

  // -------------------------------------------------------------------------
  // Decorative ground cover (not part of the simulation)
  // -------------------------------------------------------------------------

  private buildGroundCover(resources: ResourceNode[], wearTex: IUniform): void {
    const t = this.terrain;
    const rng = new Rng(9001);
    const clump = new Simplex2(4242);
    const blocked = (x: number, z: number, r: number): boolean => {
      for (const n of resources) {
        if (n.blockRadius <= 0) continue;
        const dx = n.x - x;
        const dz = n.z - z;
        if (dx * dx + dz * dz < (n.blockRadius + r) ** 2) return true;
      }
      return false;
    };
    void blocked;

    // Grass, chunked so frustum culling works.
    const CH = 8;
    const chunkSize = WORLD_SIZE / CH;
    const buckets: Matrix4[][] = Array.from({ length: CH * CH }, () => []);
    const target = 26000;
    let placed = 0;
    for (let k = 0; k < target * 4 && placed < target; k++) {
      const x = rng.range(-ISLAND_RADIUS * 1.15, ISLAND_RADIUS * 1.15);
      const z = rng.range(-ISLAND_RADIUS * 1.15, ISLAND_RADIUS * 1.15);
      const h = t.heightAt(x, z);
      if (h < 1.25 || h > 13) continue;
      const slope = t.slopeAt(x, z);
      if (slope > 0.6) continue;
      if (t.isWater(x, z)) continue;
      const m = t.moistureAt(x, z);
      const c = clump.fbm(x * 0.12, z * 0.12, 2) * 0.5 + 0.5;
      const density = smoothstep(0.25, 0.75, c) * (1 - smoothstep(0.6, 0.85, m) * 0.7) * smoothstep(1.25, 1.8, h);
      if (!rng.chance(density)) continue;
      const cx = Math.min(CH - 1, Math.max(0, Math.floor((x + WORLD_HALF) / chunkSize)));
      const cz = Math.min(CH - 1, Math.max(0, Math.floor((z + WORLD_HALF) / chunkSize)));
      const s = rng.range(0.75, 1.45) * (0.8 + c * 0.4);
      _p.set(x, h - 0.02, z);
      _q.setFromAxisAngle(_s.set(0, 1, 0), rng.range(0, Math.PI * 2));
      _s.set(s, s * rng.range(0.8, 1.2), s);
      buckets[cz * CH + cx]!.push(new Matrix4().compose(_p, _q, _s));
      placed++;
    }
    const grassMat = makeGrassMaterial(wearTex);
    const grassGeo = grassTuftGeometry(77);
    for (const list of buckets) {
      if (!list.length) continue;
      const mesh = new InstancedMesh(grassGeo, grassMat, list.length);
      list.forEach((mm, i) => mesh.setMatrixAt(i, mm));
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.computeBoundingSphere();
      mesh.name = 'grass';
      this.group.add(mesh);
    }

    // Flowers in dry meadows.
    const flowerCols = [0xffffff, 0xffe066, 0xff8fb1, 0xc9a0ff, 0xff9f45, 0x8fd3ff].map((h) => new Color(h));
    const fm: Matrix4[] = [];
    const fc: Color[] = [];
    for (let k = 0; k < 20000 && fm.length < 2200; k++) {
      const x = rng.range(-ISLAND_RADIUS, ISLAND_RADIUS);
      const z = rng.range(-ISLAND_RADIUS, ISLAND_RADIUS);
      const h = t.heightAt(x, z);
      if (h < 1.6 || h > 10 || t.slopeAt(x, z) > 0.4 || t.isWater(x, z)) continue;
      const m = t.moistureAt(x, z);
      const patch = clump.noise(x * 0.07 + 30, z * 0.07 - 12);
      if (m > 0.62 || patch < 0.15) continue;
      const colorIdx = Math.floor((clump.noise(x * 0.03, z * 0.03) * 0.5 + 0.5) * flowerCols.length * 0.999 + rng.range(0, 1.2)) % flowerCols.length;
      const s = rng.range(0.8, 1.3);
      _p.set(x, h - 0.02, z);
      _q.setFromAxisAngle(_s.set(0, 1, 0), rng.range(0, 6.28));
      _s.setScalar(s);
      fm.push(new Matrix4().compose(_p, _q, _s));
      fc.push(flowerCols[colorIdx]!);
    }
    const flowers = new InstancedMesh(flowerGeometry(), windMaterial({ amplitude: 0.2, frequency: 1.7, key: 'flower' }), fm.length);
    fm.forEach((mm, i) => {
      flowers.setMatrixAt(i, mm);
      flowers.setColorAt(i, fc[i]!);
    });
    flowers.computeBoundingSphere();
    flowers.name = 'flowers';
    this.group.add(flowers);

    // Reeds around pond shores.
    const rm: Matrix4[] = [];
    for (const p of t.ponds) {
      for (let k = 0; k < 400 && rm.length < 60 * (p.id + 1); k++) {
        const a = rng.range(0, Math.PI * 2);
        const d = p.radius * rng.range(0.75, 1.35);
        const x = p.x + Math.cos(a) * d;
        const z = p.z + Math.sin(a) * d;
        const h = t.heightAt(x, z);
        if (h < p.level - 0.35 || h > p.level + 0.35) continue;
        _p.set(x, h - 0.05, z);
        _q.setFromAxisAngle(_s.set(0, 1, 0), rng.range(0, 6.28));
        _s.setScalar(rng.range(0.8, 1.3));
        rm.push(new Matrix4().compose(_p, _q, _s));
      }
    }
    if (rm.length) {
      const reeds = new InstancedMesh(reedGeometry(3), windMaterial({ amplitude: 0.05, frequency: 1.2, key: 'reed' }), rm.length);
      rm.forEach((mm, i) => reeds.setMatrixAt(i, mm));
      reeds.computeBoundingSphere();
      reeds.castShadow = true;
      reeds.name = 'reeds';
      this.group.add(reeds);
    }

    // Pebbles and small stones on beaches and hillsides.
    const pm: Matrix4[] = [];
    for (let k = 0; k < 8000 && pm.length < 700; k++) {
      const x = rng.range(-ISLAND_RADIUS * 1.1, ISLAND_RADIUS * 1.1);
      const z = rng.range(-ISLAND_RADIUS * 1.1, ISLAND_RADIUS * 1.1);
      const h = t.heightAt(x, z);
      if (h < -0.6 || t.pondAt(x, z)) continue;
      const slope = t.slopeAt(x, z);
      const p = h < 1.3 ? 0.25 : slope > 0.4 ? 0.4 : 0.04;
      if (!rng.chance(p)) continue;
      _p.set(x, h - 0.05, z);
      _q.setFromEuler(_e.set(rng.range(-0.3, 0.3), rng.range(0, 6.28), rng.range(-0.3, 0.3)));
      _s.setScalar(rng.range(0.1, 0.3));
      pm.push(new Matrix4().compose(_p, _q, _s));
    }
    const pebbles = new InstancedMesh(pebbleGeometry(), new MeshLambertMaterial({ vertexColors: true, flatShading: true }), pm.length);
    pm.forEach((mm, i) => pebbles.setMatrixAt(i, mm));
    pebbles.computeBoundingSphere();
    pebbles.receiveShadow = true;
    pebbles.name = 'pebbles';
    this.group.add(pebbles);
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

export { Object3D };
