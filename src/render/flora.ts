import { BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, IcosahedronGeometry, OctahedronGeometry, SphereGeometry, Vector3 } from 'three';
import { Rng } from '../core/rng';
import { Simplex2 } from '../core/noise';
import { merge, prep } from './geometry';
import { PAL } from './palette';

/**
 * Stylized low/mid-poly flora for the new biomes, each with a cheap far-LOD twin.
 * Shapes favour strong silhouettes: the elder's buttressed trunk and cloud canopy, the birch's
 * pale column, the silverbark's drooping pale-teal crown, the deadwood's bare forks.
 */

const tmp = new Color();

export function place(geo: BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): BufferGeometry {
  geo.scale(sx, sy, sz);
  geo.rotateX(rx);
  geo.rotateY(ry);
  geo.rotateZ(rz);
  geo.translate(x, y, z);
  return geo;
}

export function lumpy(geo: BufferGeometry, amount: number, seed: number): BufferGeometry {
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

export function gradient(bottom: number, top: number, y0: number, y1: number, jitter = 0, rng?: Rng) {
  const cb = new Color(bottom);
  const ct = new Color(top);
  return (p: Vector3, n: Vector3): Color => {
    const t = Math.min(1, Math.max(0, (p.y - y0) / (y1 - y0)));
    tmp.copy(cb).lerp(ct, t);
    const up = Math.max(0, n.y) * 0.12;
    tmp.offsetHSL(0, 0, up + (rng ? (rng.next() - 0.5) * jitter : 0));
    return tmp;
  };
}

/** A tapered trunk with a slight bend, built from stacked segments. */
function trunk(parts: BufferGeometry[], height: number, r0: number, r1: number, segs: number, bend: number, dark: number, light: number, sides = 7): Vector3 {
  let top = new Vector3();
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const x0 = bend * t0 * t0;
    const x1 = bend * t1 * t1;
    const y0 = t0 * height;
    const y1 = t1 * height;
    const len = Math.hypot(y1 - y0, x1 - x0);
    const g = new CylinderGeometry(r0 + (r1 - r0) * t1, r0 + (r1 - r0) * t0, len * 1.02, sides);
    const ang = Math.atan2(x1 - x0, y1 - y0);
    place(g, 0, 0, 0, 0, 0, -ang);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
    parts.push(prep(g, gradient(dark, light, 0, height), true));
    top = new Vector3(x1, y1, 0);
  }
  return top;
}

/** Ancient forest giant: flared roots, thick trunk, broad layered canopy. ~12 m tall. */
export function elderTree(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const parts: BufferGeometry[] = [];
  const dark = 0x4a3222;
  const light = 0x6e4c32;
  // Buttress roots.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const g = new ConeGeometry(0.45, 2.2, 5);
    place(g, Math.cos(a) * 0.75, 0.6, Math.sin(a) * 0.75, 0, -a, 0.55 * (i % 2 ? 1 : 0.8));
    g.rotateY(0);
    parts.push(prep(g, gradient(dark, light, 0, 1.6), true));
  }
  const top = trunk(parts, 7.5, 1.1, 0.55, 5, 0.3, dark, light, 9);
  // Great limbs.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const g = new CylinderGeometry(0.18, 0.32, 3.2, 6);
    place(g, top.x + Math.cos(a) * 1.1, 6.6, Math.sin(a) * 1.1, Math.sin(a) * 0.8, 0, -Math.cos(a) * 0.8);
    parts.push(prep(g, light, true));
  }
  // Canopy: layered cloud of lumpy blobs, darker underneath.
  const blobs: Array<[number, number, number, number]> = [
    [0, 9.2, 0, 3.4],
    [2.4, 8.3, 0.8, 2.6],
    [-2.3, 8.5, -0.9, 2.7],
    [0.6, 8.2, 2.5, 2.4],
    [-0.8, 8.4, -2.5, 2.5],
    [0.3, 10.8, 0.2, 2.3],
    [1.8, 10.1, -1.4, 1.9],
    [-1.7, 10.2, 1.3, 1.9],
  ];
  for (const [x, y, z, r] of blobs) {
    const g = lumpy(new IcosahedronGeometry(r, 1), 0.18, rng.int(0, 1e6));
    place(g, x + top.x * 0.5, y, z, 0, rng.range(0, 6), 0, 1, 0.78, 1);
    parts.push(prep(g, gradient(0x2e5a2a, 0x5f9a45, 6.5, 12, 0.05, rng), true));
  }
  return merge(parts);
}

export function elderTreeLo(): BufferGeometry {
  const parts = [
    prep(place(new CylinderGeometry(0.6, 1.2, 8, 5), 0, 4, 0), 0x5a3b28, true),
    prep(place(new IcosahedronGeometry(4.2, 0), 0, 9.4, 0, 0, 0, 0, 1.2, 0.75, 1.2), 0x3f7a35, true),
  ];
  return merge(parts);
}

/** Pale-barked birch: slim white column with dark bands and a light airy crown. */
export function birchTree(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const parts: BufferGeometry[] = [];
  const top = trunk(parts, 3.6, 0.13, 0.08, 4, rng.range(-0.2, 0.2), 0xe8e4da, 0xf4f1ea, 6);
  // Dark bark marks.
  for (let i = 0; i < 5; i++) {
    const y = 0.5 + i * 0.6 + rng.range(-0.1, 0.1);
    const g = new CylinderGeometry(0.125, 0.13, 0.05, 6);
    place(g, top.x * (y / 3.6) * (y / 3.6), y, 0);
    parts.push(prep(g, 0x3a3530, true));
  }
  const blobs: Array<[number, number, number, number]> = [
    [0, 3.8, 0, 0.9],
    [0.5, 3.3, 0.3, 0.7],
    [-0.45, 3.4, -0.2, 0.72],
    [0.1, 4.4, -0.1, 0.6],
  ];
  for (const [x, y, z, r] of blobs) {
    const g = lumpy(new IcosahedronGeometry(r, 1), 0.15, rng.int(0, 1e6));
    place(g, x + top.x, y, z, 0, rng.range(0, 6), 0, 1, 1.1, 1);
    parts.push(prep(g, gradient(0x6ea83e, 0xb6d85c, 2.6, 4.9, 0.06, rng), true));
  }
  return merge(parts);
}

export function birchTreeLo(): BufferGeometry {
  return merge([prep(place(new CylinderGeometry(0.08, 0.13, 3.4, 4), 0, 1.7, 0), 0xefece4, true), prep(place(new IcosahedronGeometry(1.1, 0), 0, 3.9, 0, 0, 0, 0, 1, 1.2, 1), 0x8cc24c, true)]);
}

/** Silverbark of the Crystal Wilds: pale trunk, drooping teal-silver fronds. */
export function silverbarkTree(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const parts: BufferGeometry[] = [];
  const top = trunk(parts, 3.2, 0.18, 0.1, 4, rng.range(0.1, 0.4), 0xb8b4c8, 0xe4e2f0, 6);
  // Umbrella of drooping cones (like a willow crossed with a pine).
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const g = new ConeGeometry(0.55, 2.2, 5, 1);
    place(g, top.x + Math.cos(a) * 0.9, top.y - 0.4, Math.sin(a) * 0.9, Math.PI + Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
    parts.push(prep(g, gradient(0x5fb3a6, 0xbfe8e0, top.y - 1.5, top.y + 0.6, 0.05, rng), true));
  }
  const cap = lumpy(new IcosahedronGeometry(1.1, 1), 0.12, rng.int(0, 1e6));
  place(cap, top.x, top.y + 0.2, 0, 0, 0, 0, 1.3, 0.6, 1.3);
  parts.push(prep(cap, gradient(0x7fcabd, 0xd8f4ee, top.y - 0.4, top.y + 0.8), true));
  return merge(parts);
}

export function silverbarkTreeLo(): BufferGeometry {
  return merge([prep(place(new CylinderGeometry(0.1, 0.18, 3, 4), 0, 1.5, 0), 0xcfcce0, true), prep(place(new ConeGeometry(1.6, 2.2, 6), 0, 2.9, 0, Math.PI), 0x8fd0c4, true)]);
}

/** Charred snag of the ashlands: black forked trunk with a few stubborn tufts. */
export function deadwoodTree(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const parts: BufferGeometry[] = [];
  const top = trunk(parts, 3.0, 0.2, 0.08, 3, rng.range(-0.3, 0.3), 0x2a2220, 0x4a3b33, 6);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const len = rng.range(0.9, 1.5);
    const g = new CylinderGeometry(0.03, 0.08, len, 4);
    place(g, top.x * 0.8 + Math.cos(a) * 0.35, 2.2 + i * 0.25, Math.sin(a) * 0.35, Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9);
    parts.push(prep(g, 0x3a2e28, true));
  }
  for (let i = 0; i < 3; i++) {
    const a = rng.range(0, Math.PI * 2);
    const g = lumpy(new IcosahedronGeometry(0.35, 0), 0.2, rng.int(0, 1e6));
    place(g, top.x + Math.cos(a) * 0.6, 2.6 + rng.range(0, 0.6), Math.sin(a) * 0.6);
    parts.push(prep(g, 0x6b7a3a, true));
  }
  return merge(parts);
}

export function deadwoodTreeLo(): BufferGeometry {
  return merge([prep(place(new CylinderGeometry(0.08, 0.2, 3, 4), 0, 1.5, 0), 0x3a2e28, true)]);
}

// ---- Far LODs for the classic trees ------------------------------------------

export function broadleafLo(): BufferGeometry {
  return merge([prep(place(new CylinderGeometry(0.12, 0.22, 2.2, 4), 0, 1.1, 0), PAL.trunk, true), prep(place(new IcosahedronGeometry(1.55, 0), 0, 2.9, 0, 0, 0, 0, 1.05, 0.85, 1.05), PAL.leafA, true)]);
}

export function pineLo(): BufferGeometry {
  return merge([prep(place(new CylinderGeometry(0.1, 0.18, 1.6, 4), 0, 0.8, 0), PAL.trunk, true), prep(place(new ConeGeometry(1.35, 3.6, 6), 0, 2.9, 0), PAL.pine, true)]);
}

export function palmLo(): BufferGeometry {
  return merge([prep(place(new CylinderGeometry(0.1, 0.15, 3.6, 4), 0.4, 1.8, 0, 0, 0, -0.2), 0x8a6a45, true), prep(place(new ConeGeometry(1.6, 0.8, 6), 0.8, 3.5, 0, Math.PI), PAL.palmLeaf, true)]);
}

export function fruitTreeLo(): BufferGeometry {
  return merge([prep(place(new CylinderGeometry(0.12, 0.2, 1.9, 4), 0, 0.95, 0), PAL.trunk, true), prep(place(new IcosahedronGeometry(1.4, 0), 0, 2.6, 0, 0, 0, 0, 1, 0.85, 1), 0x7ab84a, true)]);
}

export function bushLo(): BufferGeometry {
  return prep(place(new IcosahedronGeometry(0.62, 0), 0, 0.4, 0, 0, 0, 0, 1.2, 0.8, 1.2), PAL.bush, true);
}

export function rockLo(): BufferGeometry {
  const g = new IcosahedronGeometry(1, 0);
  g.scale(1, 0.75, 1);
  g.translate(0, 0.2, 0);
  return prep(g, 0x9a958c, true);
}

// ---- Food, crystal and ground cover --------------------------------------------

/** A cluster of stout forest mushrooms with spotted caps. */
export function mushroomPatch(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const parts: BufferGeometry[] = [];
  const caps = [0xc8503a, 0xd9a441, 0xb86b3a];
  for (let i = 0; i < 5; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = i === 0 ? 0 : rng.range(0.15, 0.45);
    const h = i === 0 ? 0.42 : rng.range(0.18, 0.32);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    parts.push(prep(place(new CylinderGeometry(0.04, 0.06, h, 6), x, h / 2, z), 0xefe6d4, true));
    const cap = new SphereGeometry(h * 0.55, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2);
    place(cap, x, h - 0.02, z, 0, 0, 0, 1, 0.6, 1);
    const cc = caps[(seed + i) % caps.length]!;
    parts.push(prep(cap, (p) => tmp.set(cc).offsetHSL(0, 0, (Math.sin(p.x * 40) * Math.cos(p.z * 40) > 0.7 ? 0.35 : 0) + p.y * 0.2), true));
  }
  return merge(parts);
}

/** Faceted crystal cluster growing from the rock. */
export function crystalCluster(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const parts: BufferGeometry[] = [];
  const base = lumpy(new IcosahedronGeometry(0.55, 0), 0.25, rng.int(0, 1e6));
  place(base, 0, 0.05, 0, 0, 0, 0, 1.2, 0.5, 1.1);
  parts.push(prep(base, 0x6f6a80, true));
  for (let i = 0; i < 6; i++) {
    const a = rng.range(0, Math.PI * 2);
    const tilt = i === 0 ? 0.05 : rng.range(0.25, 0.7);
    const h = i === 0 ? 1.6 : rng.range(0.6, 1.2);
    const g = new OctahedronGeometry(0.22, 0);
    g.scale(1, h / 0.44, 1);
    place(g, Math.cos(a) * (i === 0 ? 0 : 0.3), h * 0.42, Math.sin(a) * (i === 0 ? 0 : 0.3), Math.sin(a) * tilt, 0, -Math.cos(a) * tilt);
    parts.push(prep(g, gradient(0x8a7fd8, 0xd4f4ff, 0, h * 0.9), true));
  }
  return merge(parts);
}

export function crystalShards(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const g = new OctahedronGeometry(0.1, 0);
    g.scale(1, 1.8, 1);
    place(g, Math.cos(a) * 0.25, 0.1, Math.sin(a) * 0.25, 0.6, a, 0);
    parts.push(prep(g, 0x9a8fe0, true));
  }
  return merge(parts);
}

export function rubbleGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const rng = new Rng(55);
  for (let i = 0; i < 5; i++) {
    const g = lumpy(new IcosahedronGeometry(rng.range(0.15, 0.3), 0), 0.2, i);
    place(g, rng.range(-0.5, 0.5), 0.08, rng.range(-0.5, 0.5));
    parts.push(prep(g, 0x8a857c, true));
  }
  return merge(parts);
}

/** Fern fronds for the forest floor. */
export function fernGeometry(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const pos: number[] = [];
  const col: number[] = [];
  const nor: number[] = [];
  const base = new Color(0x2f5a26);
  const tip = new Color(0x7fb04a);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const len = rng.range(0.45, 0.7);
    const w = 0.12;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const px = -dz * w;
    const pz = dx * w;
    const mx = dx * len * 0.5;
    const mz = dz * len * 0.5;
    pos.push(0, 0.02, 0, mx + px, 0.28, mz + pz, dx * len, 0.12, dz * len);
    pos.push(0, 0.02, 0, dx * len, 0.12, dz * len, mx - px, 0.28, mz - pz);
    for (let k = 0; k < 6; k++) {
      const c = k % 3 === 0 ? base : tip;
      col.push(c.r, c.g, c.b);
      nor.push(0, 1, 0);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  return g;
}

/** Luminous bell-flowers (rare, in the old forest and the crystal wilds). */
export function glowPlantGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const h = 0.35 + i * 0.08;
    parts.push(prep(place(new CylinderGeometry(0.012, 0.015, h, 3), Math.cos(a) * 0.08, h / 2, Math.sin(a) * 0.08, 0.2 * Math.cos(a), 0, 0.2 * Math.sin(a)), 0x3f6a4a));
    parts.push(prep(place(new SphereGeometry(0.06, 6, 4), Math.cos(a) * 0.12, h, Math.sin(a) * 0.12), 0xffffff, true));
  }
  return merge(parts);
}

/** Low dry heather / scrub for the highlands and ashlands. */
export function heatherGeometry(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const g = lumpy(new IcosahedronGeometry(rng.range(0.16, 0.24), 0), 0.25, rng.int(0, 1e6));
    place(g, rng.range(-0.2, 0.2), 0.1, rng.range(-0.2, 0.2), 0, 0, 0, 1, 0.6, 1);
    parts.push(prep(g, 0xffffff, true));
  }
  return merge(parts);
}

/** Driftwood log for beaches. */
export function driftwoodGeometry(): BufferGeometry {
  return merge([prep(place(new CylinderGeometry(0.08, 0.1, 1.4, 5), 0, 0.07, 0, 0, 0, Math.PI / 2), 0xbfae94, true), prep(place(new CylinderGeometry(0.03, 0.05, 0.5, 4), 0.3, 0.15, 0.12, 0.4, 0, 0.6), 0xbfae94, true)]);
}
