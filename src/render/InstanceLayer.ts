import { Box3, BufferGeometry, Color, DynamicDrawUsage, Frustum, InstancedBufferAttribute, InstancedMesh, Material, Matrix4, Vector3 } from 'three';
import { WORLD_HALF, WORLD_SIZE } from '../world/config';

/** Spatial bins used for culling and LOD of everything that grows on the ground. */
export const VCHUNK = 32;
export const VCHUNK_N = Math.ceil(WORLD_SIZE / VCHUNK);

export function chunkOf(x: number, z: number): number {
  const cx = Math.min(VCHUNK_N - 1, Math.max(0, Math.floor((x + WORLD_HALF) / VCHUNK)));
  const cz = Math.min(VCHUNK_N - 1, Math.max(0, Math.floor((z + WORLD_HALF) / VCHUNK)));
  return cz * VCHUNK_N + cx;
}

/** 0 = culled, 1 = near (full detail), 2 = far (low detail). */
export type ChunkVis = Uint8Array;

const _box = new Box3();
const _v = new Vector3();

/** Classify chunks against the camera frustum and distance. */
export function classifyChunks(out: ChunkVis, frustum: Frustum, cam: Vector3, nearDist: number, farDist: number, heights: (cx: number, cz: number) => [number, number]): boolean {
  let changed = false;
  for (let cz = 0; cz < VCHUNK_N; cz++) {
    for (let cx = 0; cx < VCHUNK_N; cx++) {
      const i = cz * VCHUNK_N + cx;
      const x0 = cx * VCHUNK - WORLD_HALF;
      const z0 = cz * VCHUNK - WORLD_HALF;
      const [y0, y1] = heights(cx, cz);
      _box.min.set(x0 - 4, y0 - 1, z0 - 4);
      _box.max.set(x0 + VCHUNK + 4, y1 + 16, z0 + VCHUNK + 4);
      let v = 0;
      if (frustum.intersectsBox(_box)) {
        _box.clampPoint(cam, _v);
        const d = _v.distanceTo(cam);
        v = d < nearDist ? 1 : d < farDist ? 2 : 0;
      }
      if (out[i] !== v) {
        out[i] = v;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * A pool of instances of one model, stored CPU-side by slot and copied into GPU buffers only for
 * chunks that are on screen, in a near (detailed, shadow-casting) and a far (cheap) mesh.
 * Changing one instance writes straight into the visible buffer.
 */
export class InstanceLayer {
  readonly hi: InstancedMesh;
  readonly lo: InstancedMesh | null;
  private src: Float32Array;
  private col: Float32Array | null;
  private chunk: Int32Array;
  private hidden: Uint8Array;
  private visHi: Int32Array;
  private visLo: Int32Array;
  private lists: number[][] = Array.from({ length: VCHUNK_N * VCHUNK_N }, () => []);
  private cap: number;
  size = 0;
  private free: number[] = [];
  /** Draw in the far mesh when the chunk is far (else it is simply culled when far). */
  constructor(
    readonly name: string,
    hiGeo: BufferGeometry,
    hiMat: Material,
    loGeo: BufferGeometry | null,
    loMat: Material | null,
    capacity: number,
    opts: { colors?: boolean; shadows?: boolean } = {},
  ) {
    this.cap = Math.max(16, capacity);
    this.src = new Float32Array(this.cap * 16);
    this.col = opts.colors ? new Float32Array(this.cap * 3).fill(1) : null;
    this.chunk = new Int32Array(this.cap).fill(-1);
    this.hidden = new Uint8Array(this.cap).fill(1);
    this.visHi = new Int32Array(this.cap).fill(-1);
    this.visLo = new Int32Array(this.cap).fill(-1);
    this.hi = this.makeMesh(hiGeo, hiMat, `${name}-hi`, opts.shadows ?? true);
    this.lo = loGeo && loMat ? this.makeMesh(loGeo, loMat, `${name}-lo`, false) : null;
  }

  private makeMesh(geo: BufferGeometry, mat: Material, name: string, shadows: boolean): InstancedMesh {
    const m = new InstancedMesh(geo, mat, this.cap);
    m.instanceMatrix.setUsage(DynamicDrawUsage);
    if (this.col) {
      m.instanceColor = new InstancedBufferAttribute(new Float32Array(this.cap * 3), 3);
      m.instanceColor.setUsage(DynamicDrawUsage);
    }
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = shadows;
    m.receiveShadow = true;
    m.name = name;
    return m;
  }

  private grow(): void {
    const cap = this.cap * 2;
    const grow = <T extends Float32Array | Int32Array | Uint8Array>(a: T, n: number, fill: number): T => {
      const b = new (a.constructor as new (n: number) => T)(n);
      b.fill(fill as never);
      b.set(a);
      return b;
    };
    this.src = grow(this.src, cap * 16, 0);
    if (this.col) this.col = grow(this.col, cap * 3, 1);
    this.chunk = grow(this.chunk, cap, -1);
    this.hidden = grow(this.hidden, cap, 1);
    this.visHi = grow(this.visHi, cap, -1);
    this.visLo = grow(this.visLo, cap, -1);
    for (const mesh of [this.hi, this.lo]) {
      if (!mesh) continue;
      mesh.instanceMatrix = new InstancedBufferAttribute(new Float32Array(cap * 16), 16);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      if (this.col) {
        mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        mesh.instanceColor.setUsage(DynamicDrawUsage);
      }
      (mesh as unknown as { maxInstanceCount: number }).maxInstanceCount = cap;
    }
    this.cap = cap;
    this.dirty = true;
  }

  alloc(): number {
    if (this.free.length) return this.free.pop()!;
    if (this.size >= this.cap) this.grow();
    return this.size++;
  }

  release(slot: number): void {
    this.set(slot, null, 0, 0);
    this.free.push(slot);
  }

  /** Needs a full re-copy on the next refresh (set when chunks change). */
  dirty = true;

  /** Place (or hide, with null) an instance. */
  set(slot: number, m: Matrix4 | null, x: number, z: number): void {
    if (!m) {
      if (!this.hidden[slot]) {
        this.hidden[slot] = 1;
        this.dirty = true;
      }
      return;
    }
    const ch = chunkOf(x, z);
    if (this.chunk[slot] !== ch) {
      const old = this.chunk[slot]!;
      if (old >= 0) {
        const l = this.lists[old]!;
        const i = l.indexOf(slot);
        if (i >= 0) l.splice(i, 1);
      }
      this.lists[ch]!.push(slot);
      this.chunk[slot] = ch;
      this.dirty = true;
    }
    m.toArray(this.src, slot * 16);
    if (this.hidden[slot]) {
      this.hidden[slot] = 0;
      this.dirty = true;
      return;
    }
    // Visible already: patch the live buffer in place.
    const h = this.visHi[slot]!;
    if (h >= 0) {
      m.toArray(this.hi.instanceMatrix.array as Float32Array, h * 16);
      this.hi.instanceMatrix.needsUpdate = true;
    }
    const l = this.visLo[slot]!;
    if (l >= 0 && this.lo) {
      m.toArray(this.lo.instanceMatrix.array as Float32Array, l * 16);
      this.lo.instanceMatrix.needsUpdate = true;
    }
  }

  setColor(slot: number, c: Color): void {
    if (!this.col) return;
    c.toArray(this.col, slot * 3);
    const h = this.visHi[slot]!;
    if (h >= 0 && this.hi.instanceColor) {
      c.toArray(this.hi.instanceColor.array as Float32Array, h * 3);
      this.hi.instanceColor.needsUpdate = true;
    }
    const l = this.visLo[slot]!;
    if (l >= 0 && this.lo?.instanceColor) {
      c.toArray(this.lo.instanceColor.array as Float32Array, l * 3);
      this.lo.instanceColor.needsUpdate = true;
    }
  }

  /** Copy on-screen instances into the GPU buffers. */
  refresh(vis: ChunkVis): void {
    this.visHi.fill(-1);
    this.visLo.fill(-1);
    let nh = 0;
    let nl = 0;
    const hiM = this.hi.instanceMatrix.array as Float32Array;
    const loM = this.lo ? (this.lo.instanceMatrix.array as Float32Array) : null;
    const hiC = this.hi.instanceColor?.array as Float32Array | undefined;
    const loC = this.lo?.instanceColor?.array as Float32Array | undefined;
    for (let c = 0; c < this.lists.length; c++) {
      const v = vis[c]!;
      if (v === 0) continue;
      const far = v === 2;
      if (far && !this.lo) continue;
      const list = this.lists[c]!;
      for (let k = 0; k < list.length; k++) {
        const s = list[k]!;
        if (this.hidden[s]) continue;
        if (!far) {
          hiM.set(this.src.subarray(s * 16, s * 16 + 16), nh * 16);
          if (hiC && this.col) hiC.set(this.col.subarray(s * 3, s * 3 + 3), nh * 3);
          this.visHi[s] = nh++;
        } else {
          loM!.set(this.src.subarray(s * 16, s * 16 + 16), nl * 16);
          if (loC && this.col) loC.set(this.col.subarray(s * 3, s * 3 + 3), nl * 3);
          this.visLo[s] = nl++;
        }
      }
    }
    this.hi.count = nh;
    this.hi.instanceMatrix.needsUpdate = true;
    if (this.hi.instanceColor) this.hi.instanceColor.needsUpdate = true;
    if (this.lo) {
      this.lo.count = nl;
      this.lo.instanceMatrix.needsUpdate = true;
      if (this.lo.instanceColor) this.lo.instanceColor.needsUpdate = true;
    }
    this.dirty = false;
  }

  get drawn(): number {
    return this.hi.count + (this.lo?.count ?? 0);
  }
}
