import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';
import { Simplex2 } from '../core/noise';
import { PAL } from './palette';

/** Strip to position/normal/color so heterogeneous primitives can be merged. */
export function prep(geo: BufferGeometry, color: number | ((p: Vector3, n: Vector3) => Color), flat = false): BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  if (flat) g.computeVertexNormals();
  else if (!g.getAttribute('normal')) g.computeVertexNormals();
  const pos = g.getAttribute('position') as BufferAttribute;
  const nor = g.getAttribute('normal') as BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const p = new Vector3();
  const n = new Vector3();
  const fixed = typeof color === 'number' ? new Color(color) : null;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    const c = fixed ?? (color as (p: Vector3, n: Vector3) => Color)(p, n);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new BufferAttribute(colors, 3));
  return g;
}

export function merge(geos: BufferGeometry[]): BufferGeometry {
  const m = mergeGeometries(geos, false);
  if (!m) throw new Error('mergeGeometries failed');
  return m;
}

function place(geo: BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): BufferGeometry {
  const m = new Matrix4().compose(
    new Vector3(x, y, z),
    new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), rx).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), ry)).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), rz)),
    new Vector3(sx, sy, sz),
  );
  geo.applyMatrix4(m);
  return geo;
}

/** Displace vertices of a blob for an organic, hand-made feel. */
function lumpy(geo: BufferGeometry, amount: number, seed: number): BufferGeometry {
  const n = new Simplex2(seed);
  const pos = geo.getAttribute('position') as BufferAttribute;
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = 1 + amount * n.noise(v.x * 1.7 + v.y * 0.7, v.z * 1.7 - v.y * 0.9);
    pos.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  return geo;
}

const tmpC = new Color();
function gradient(bottom: number, top: number, y0: number, y1: number, jitter = 0, rng?: Rng) {
  const cb = new Color(bottom);
  const ct = new Color(top);
  return (p: Vector3, n: Vector3): Color => {
    const t = Math.min(1, Math.max(0, (p.y - y0) / (y1 - y0)));
    tmpC.copy(cb).lerp(ct, t);
    // Faces pointing up catch more light: subtle painterly highlight.
    const up = Math.max(0, n.y) * 0.12;
    tmpC.offsetHSL(0, 0, up + (rng ? (rng.next() - 0.5) * jitter : 0));
    return tmpC;
  };
}

export function broadleafTree(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const parts: BufferGeometry[] = [];
  parts.push(prep(place(new CylinderGeometry(0.14, 0.24, 2.2, 7), 0, 1.1, 0), gradient(PAL.trunkDark, PAL.trunk, 0, 2)));
  // A couple of short branches peeking out.
  parts.push(prep(place(new CylinderGeometry(0.05, 0.08, 0.9, 5), 0.3, 1.9, 0, 0, 0, -0.9), PAL.trunk));
  parts.push(prep(place(new CylinderGeometry(0.05, 0.08, 0.8, 5), -0.25, 2.0, 0.1, 0.3, 0, 0.9), PAL.trunk));
  const blobs: Array<[number, number, number, number]> = [
    [0, 2.9, 0, 1.3],
    [0.75, 2.45, 0.25, 0.95],
    [-0.7, 2.5, -0.3, 1.0],
    [0.15, 3.55, -0.1, 0.85],
    [-0.1, 2.5, 0.75, 0.85],
  ];
  for (const [x, y, z, r] of blobs) {
    const g = lumpy(new IcosahedronGeometry(r, 1), 0.16, rng.int(0, 1e6));
    place(g, x, y, z, 0, rng.range(0, 6), 0, 1, 0.88, 1);
    parts.push(prep(g, gradient(PAL.leafB, PAL.leafC, 1.8, 4.3, 0.05, rng), true));
  }
  return merge(parts);
}

export function fruitTree(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const parts: BufferGeometry[] = [];
  parts.push(prep(place(new CylinderGeometry(0.13, 0.22, 1.9, 7), 0, 0.95, 0), gradient(PAL.trunkDark, PAL.trunk, 0, 2)));
  const blobs: Array<[number, number, number, number]> = [
    [0, 2.55, 0, 1.25],
    [0.65, 2.2, 0.3, 0.85],
    [-0.6, 2.25, -0.25, 0.9],
    [0.1, 3.1, -0.05, 0.8],
  ];
  for (const [x, y, z, r] of blobs) {
    const g = lumpy(new IcosahedronGeometry(r, 1), 0.12, rng.int(0, 1e6));
    place(g, x, y, z, 0, rng.range(0, 6), 0, 1, 0.9, 1);
    parts.push(prep(g, gradient(0x5c9e3c, 0x9ccf5a, 1.6, 3.8, 0.05, rng), true));
  }
  return merge(parts);
}

/** Positions where fruit hang on the fruit-tree canopy (local space, unscaled). */
export const FRUIT_SLOTS: Array<[number, number, number]> = [
  [0.95, 2.45, 0.55],
  [-0.9, 2.3, 0.6],
  [0.2, 2.05, 1.15],
  [-1.2, 2.5, -0.35],
  [0.75, 2.0, -0.85],
  [1.35, 2.65, -0.1],
  [-0.3, 3.3, 0.75],
];

export function pineTree(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const parts: BufferGeometry[] = [];
  parts.push(prep(place(new CylinderGeometry(0.11, 0.2, 1.6, 6), 0, 0.8, 0), gradient(PAL.trunkDark, PAL.trunk, 0, 1.6)));
  const tiers: Array<[number, number, number]> = [
    [1.9, 1.35, 1.9],
    [2.85, 1.05, 1.7],
    [3.7, 0.75, 1.5],
  ];
  for (const [y, r, h] of tiers) {
    const g = new ConeGeometry(r, h, 8, 1);
    place(g, rng.range(-0.04, 0.04), y, rng.range(-0.04, 0.04), 0, rng.range(0, 6), 0);
    parts.push(prep(g, gradient(PAL.pine, PAL.pineLight, y - h / 2, y + h / 2, 0.04, rng), true));
  }
  return merge(parts);
}

export function palmTree(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const parts: BufferGeometry[] = [];
  const segs = 7;
  const height = 3.6;
  const lean = rng.range(0.5, 1.0);
  let top = new Vector3();
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const y0 = t0 * height;
    const y1 = t1 * height;
    const x0 = lean * t0 * t0;
    const x1 = lean * t1 * t1;
    const len = Math.hypot(y1 - y0, x1 - x0);
    const g = new CylinderGeometry(0.13 - t1 * 0.04, 0.15 - t0 * 0.04, len * 1.02, 6);
    const ang = Math.atan2(x1 - x0, y1 - y0);
    place(g, (x0 + x1) / 2, (y0 + y1) / 2, 0, 0, 0, -ang);
    parts.push(prep(g, i % 2 === 0 ? 0x8a6a45 : 0x9c7a50, true));
    top = new Vector3(x1, y1, 0);
  }
  const fronds = 7;
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const g = new PlaneGeometry(2.1, 0.55, 6, 1);
    const pos = g.getAttribute('position') as BufferAttribute;
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k) + 1.05; // 0..2.1 along the leaf
      const y = pos.getY(k);
      const w = Math.sin((x / 2.1) * Math.PI) * 1.0 + 0.15;
      pos.setXYZ(k, x, -0.18 * x * x + 0.35 * x, y * w);
    }
    g.rotateX(-Math.PI / 2 + 0.25);
    g.rotateY(a);
    g.translate(top.x, top.y, top.z);
    const leafCol = new Color(PAL.palmLeaf).offsetHSL(rng.range(-0.02, 0.02), 0, rng.range(-0.05, 0.03));
    parts.push(prep(g, (p) => tmpC.copy(leafCol).offsetHSL(0, 0, (p.y - top.y) * 0.08)));
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    parts.push(prep(place(new SphereGeometry(0.12, 6, 5), top.x + Math.cos(a) * 0.16, top.y - 0.15, Math.sin(a) * 0.16), 0x6b4a2a, true));
  }
  const merged = merge(parts);
  // Palm geometry uses double-sided leaves; duplicate faces with flipped normals for correct lighting.
  return merged;
}

export function bushGeometry(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const parts: BufferGeometry[] = [];
  const blobs: Array<[number, number, number, number]> = [
    [0, 0.42, 0, 0.55],
    [0.45, 0.33, 0.2, 0.42],
    [-0.4, 0.35, -0.15, 0.45],
    [0.05, 0.36, -0.45, 0.4],
  ];
  for (const [x, y, z, r] of blobs) {
    const g = lumpy(new IcosahedronGeometry(r, 1), 0.14, rng.int(0, 1e6));
    place(g, x, y, z, 0, rng.range(0, 6), 0, 1, 0.85, 1);
    parts.push(prep(g, gradient(PAL.bush, PAL.bushLight, 0, 0.9, 0.05, rng), true));
  }
  return merge(parts);
}

/** Berry positions on a bush (local space). */
export const BERRY_SLOTS: Array<[number, number, number]> = [
  [0.35, 0.7, 0.35],
  [-0.3, 0.72, 0.3],
  [0.62, 0.45, 0.45],
  [-0.62, 0.5, -0.2],
  [0.1, 0.85, -0.25],
  [0.35, 0.45, -0.55],
];

export function rockGeometry(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const g = lumpy(new IcosahedronGeometry(1, 1), 0.28, rng.int(0, 1e6));
  const pos = g.getAttribute('position') as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setY(i, y < -0.2 ? -0.2 + (y + 0.2) * 0.3 : y * 0.8);
  }
  g.translate(0, 0.25, 0);
  return prep(g, gradient(PAL.rockDark, PAL.rockLight, -0.2, 1.1, 0.06, rng), true);
}

export function stumpGeometry(): BufferGeometry {
  const parts = [
    prep(place(new CylinderGeometry(0.22, 0.3, 0.38, 8), 0, 0.19, 0), PAL.trunk, true),
    prep(place(new CylinderGeometry(0.2, 0.2, 0.02, 8), 0, 0.39, 0), 0xd9b98a, true),
  ];
  return merge(parts);
}

export function saplingGeometry(): BufferGeometry {
  const parts = [
    prep(place(new CylinderGeometry(0.04, 0.06, 0.8, 5), 0, 0.4, 0), PAL.trunk, true),
    prep(place(lumpy(new IcosahedronGeometry(0.35, 1), 0.15, 7), 0, 0.9, 0), PAL.leafC, true),
  ];
  return merge(parts);
}

export function burntTreeGeometry(): BufferGeometry {
  const parts = [
    prep(place(new CylinderGeometry(0.1, 0.22, 2.2, 6), 0, 1.1, 0), PAL.charcoal, true),
    prep(place(new CylinderGeometry(0.03, 0.06, 0.9, 4), 0.3, 1.9, 0, 0, 0, -0.9), PAL.charcoal, true),
    prep(place(new CylinderGeometry(0.03, 0.06, 0.7, 4), -0.25, 2.0, 0.1, 0.3, 0, 0.9), PAL.charcoal, true),
  ];
  return merge(parts);
}

/** A tuft of grass blades with a dark base and sunlit tips. */
export function grassTuftGeometry(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const blades = 6;
  const positions: number[] = [];
  const colors: number[] = [];
  const base = new Color(0x3f7a2c);
  const tip = new Color(0xa6d66a);
  for (let i = 0; i < blades; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(0, 0.14);
    const bx = Math.cos(a) * r;
    const bz = Math.sin(a) * r;
    const h = rng.range(0.28, 0.55);
    const w = rng.range(0.04, 0.06);
    const lean = rng.range(0.05, 0.2);
    const la = rng.range(0, Math.PI * 2);
    const px = Math.cos(a + Math.PI / 2) * w;
    const pz = Math.sin(a + Math.PI / 2) * w;
    const tx = bx + Math.cos(la) * lean;
    const tz = bz + Math.sin(la) * lean;
    positions.push(bx - px, 0, bz - pz, bx + px, 0, bz + pz, tx, h, tz);
    colors.push(base.r, base.g, base.b, base.r, base.g, base.b, tip.r, tip.g, tip.b);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  // Normals point up so blades are lit like the ground they grow from.
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1;
  g.setAttribute('normal', new BufferAttribute(normals, 3));
  return g;
}

export function flowerGeometry(): BufferGeometry {
  const parts = [
    prep(place(new CylinderGeometry(0.012, 0.012, 0.3, 3), 0, 0.15, 0), 0x4c8a36),
    prep(place(new IcosahedronGeometry(0.07, 0), 0, 0.32, 0, 0, 0, 0, 1, 0.6, 1), 0xffffff, true),
  ];
  return merge(parts);
}

export function reedGeometry(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const h = rng.range(0.7, 1.3);
    const x = rng.range(-0.2, 0.2);
    const z = rng.range(-0.2, 0.2);
    parts.push(prep(place(new CylinderGeometry(0.012, 0.025, h, 3), x, h / 2, z), gradient(0x4a6b2a, 0x9fb85a, 0, h)));
    if (rng.chance(0.5)) parts.push(prep(place(new CylinderGeometry(0.035, 0.035, 0.2, 5), x, h - 0.08, z), 0x6b4a2a));
  }
  return merge(parts);
}
