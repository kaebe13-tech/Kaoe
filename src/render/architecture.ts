import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  ExtrudeGeometry,
  IcosahedronGeometry,
  Shape,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { Rng } from '../core/rng';
import { merge, prep } from './geometry';
import { lumpy, place } from './flora';
import { CULTURES, type CultureId, type RoofStyle } from '../civ/cultures';
import type { StructureKind } from '../sim/types';
import { campfirePieces, gardenPieces, gravePieces, shrinePieces, storagePieces, type Piece } from './structureGeometry';

/** Visual language of one people's buildings. */
export interface Style {
  culture: CultureId;
  roof: RoofStyle;
  roofColor: number;
  wallColor: number;
  wood: number;
  banner: number;
  accent: number;
  stone: number;
}

export function styleFor(culture: CultureId | undefined): Style {
  const c = CULTURES[culture ?? 'vale'];
  return {
    culture: c.id,
    roof: c.roof,
    roofColor: c.roofColor,
    wallColor: c.wallColor,
    wood: c.woodColor,
    banner: c.banner,
    accent: c.accent,
    stone: c.id === 'ember' ? 0x4a4442 : c.id === 'glass' ? 0xc8c4d8 : 0x9a958c,
  };
}

const tmp = new Color();
function shade(hex: number, l: number): number {
  return tmp.set(hex).offsetHSL(0, 0, l).getHex();
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, ry = 0, rx = 0, rz = 0): BufferGeometry {
  return prep(place(new BoxGeometry(w, h, d), x, y, z, rx, ry, rz), color, true);
}

function post(x: number, z: number, h: number, r: number, color: number, y0 = 0): BufferGeometry {
  return prep(place(new CylinderGeometry(r * 0.85, r, h, 6), x, y0 + h / 2, z), color, true);
}

/** Stone footing of irregular blocks around a rectangle. */
function footing(w: number, d: number, color: number, rng: Rng): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const n = Math.ceil((w + d) * 1.2);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const per = 2 * (w + d);
    let s = t * per;
    let x: number;
    let z: number;
    if (s < w) {
      x = -w / 2 + s;
      z = -d / 2;
    } else if ((s -= w) < d) {
      x = w / 2;
      z = -d / 2 + s;
    } else if ((s -= d) < w) {
      x = w / 2 - s;
      z = d / 2;
    } else {
      s -= w;
      x = -w / 2;
      z = d / 2 - s;
    }
    const g = lumpy(new BoxGeometry(0.62, 0.34, 0.5), 0.12, rng.int(0, 1e6));
    place(g, x, 0.14, z, 0, rng.range(-0.2, 0.2), 0);
    parts.push(prep(g, shade(color, rng.range(-0.06, 0.05)), true));
  }
  parts.push(box(w, 0.2, d, 0, 0.1, 0, shade(color, -0.1)));
  return merge(parts);
}

/** Gable roof of two sloping slabs plus ridge beam; `overhang` beyond the walls. */
function gable(w: number, d: number, rise: number, y: number, style: Style, rng: Rng): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  const half = d / 2 + 0.35;
  const slope = Math.atan2(rise, half);
  const len = Math.hypot(half, rise) + 0.1;
  const color = style.roofColor;
  const thick = style.roof === 'thatch' ? 0.28 : style.roof === 'moss' ? 0.3 : 0.14;
  for (const s of [1, -1]) {
    const slab = new BoxGeometry(w + 0.6, thick, len);
    place(slab, 0, y + rise / 2, (s * half) / 2, s * slope, 0, 0);
    parts.push(prep(slab, (p) => tmp.set(color).offsetHSL(0, 0, ((p.y - y) / rise) * 0.08 + (Math.sin(p.x * 3.1) > 0.8 ? -0.04 : 0)), true));
    // Shingle/thatch courses give the roof texture.
    const courses = style.roof === 'slate' ? 5 : 4;
    for (let k = 1; k < courses; k++) {
      const t = k / courses;
      const c = new BoxGeometry(w + 0.62, 0.05, 0.06);
      place(c, 0, y + rise * (1 - t) + thick * 0.55, s * half * t, s * slope, 0, 0);
      parts.push(prep(c, shade(color, -0.12), true));
    }
  }
  parts.push(prep(place(new CylinderGeometry(0.09, 0.09, w + 0.7, 6), 0, y + rise + 0.05, 0, 0, 0, Math.PI / 2), shade(style.wood, -0.05), true));
  void rng;
  return parts;
}

/** Triangular gable end walls. */
function gableEnds(w: number, d: number, rise: number, y: number, color: number): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  for (const s of [1, -1]) {
    const shape = new Shape();
    shape.moveTo(-d / 2, 0);
    shape.lineTo(d / 2, 0);
    shape.lineTo(0, rise);
    shape.closePath();
    const tri = new ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: false });
    tri.translate(0, 0, -0.07);
    tri.rotateY(Math.PI / 2);
    tri.translate((s * w) / 2, y, 0);
    parts.push(prep(tri, color, true));
  }
  return parts;
}

function windowGlow(x: number, y: number, z: number, w: number, h: number, ry: number): BufferGeometry {
  return prep(place(new BoxGeometry(w, h, 0.03), x, y, z, 0, ry, 0), 0xffc46b);
}

function scaffold(w: number, d: number, h: number, color: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const [x, z] of [
    [-w / 2 - 0.4, -d / 2 - 0.4],
    [w / 2 + 0.4, -d / 2 - 0.4],
    [-w / 2 - 0.4, d / 2 + 0.4],
    [w / 2 + 0.4, d / 2 + 0.4],
  ] as const) {
    parts.push(post(x, z, h, 0.04, color));
  }
  for (const y of [h * 0.45, h * 0.9]) {
    parts.push(box(w + 0.9, 0.05, 0.05, 0, y, -d / 2 - 0.4, color));
    parts.push(box(w + 0.9, 0.05, 0.05, 0, y, d / 2 + 0.4, color));
    parts.push(box(0.05, 0.05, d + 0.9, -w / 2 - 0.4, y, 0, color));
    parts.push(box(0.05, 0.05, d + 0.9, w / 2 + 0.4, y, 0, color));
  }
  return merge(parts);
}

/** Barrels, sacks, firewood: the clutter that makes a place look lived in. */
function props(rng: Rng, style: Style, spots: Array<[number, number]>): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const [x, z] of spots) {
    const r = rng.next();
    if (r < 0.35) {
      parts.push(prep(place(new CylinderGeometry(0.22, 0.2, 0.5, 8), x, 0.25, z), shade(style.wood, 0.05), true));
      parts.push(prep(place(new TorusGeometry(0.215, 0.02, 3, 10), x, 0.36, z, Math.PI / 2), 0x3a3030, true));
    } else if (r < 0.65) {
      const logs: BufferGeometry[] = [];
      for (let i = 0; i < 5; i++) logs.push(prep(place(new CylinderGeometry(0.06, 0.06, 0.8, 5), x + (i % 3) * 0.13 - 0.13, 0.07 + Math.floor(i / 3) * 0.12, z, 0, 0, Math.PI / 2), shade(0x8a5c36, (i % 2) * 0.05), true));
      parts.push(merge(logs));
    } else {
      const sack = lumpy(new SphereGeometry(0.22, 7, 5), 0.12, rng.int(0, 1e6));
      place(sack, x, 0.18, z, 0, 0, 0, 1, 0.85, 1);
      parts.push(prep(sack, 0xc9b184, true));
    }
  }
  return merge(parts);
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

function tentPieces(seed: number, style: Style): Piece[] {
  const rng = new Rng(seed);
  const pieces: Piece[] = [];
  const hide = style.culture === 'vale' ? 0xe6d8b8 : style.culture === 'grove' ? 0x7a8f5a : style.culture === 'stone' ? 0x8a8a84 : style.culture === 'ember' ? 0x9a4a30 : 0xd8cfe8;
  const R = 1.25;
  // Poles.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const g = new CylinderGeometry(0.03, 0.04, 2.9, 5);
    place(g, Math.cos(a) * 0.55, 1.35, Math.sin(a) * 0.55, Math.sin(a) * 0.42, 0, -Math.cos(a) * 0.42);
    pieces.push({ geo: prep(g, style.wood, true), at: 0.05 + i * 0.05 });
  }
  // Hide cover with a door slit (+z) and painted band.
  const cover = new ConeGeometry(R, 2.3, 12, 1, true, Math.PI * 0.18, Math.PI * 1.64);
  place(cover, 0, 1.15, 0, 0, Math.PI / 2 - Math.PI * 0.18 + Math.PI, 0);
  pieces.push({ geo: prep(cover, (p) => tmp.set(hide).offsetHSL(0, 0, Math.abs(p.y - 0.7) < 0.12 ? -0.2 : (p.y / 2.3) * 0.08), true), at: 0.5 });
  const flap = new BoxGeometry(0.5, 1.1, 0.04);
  place(flap, 0.28, 0.55, R * 0.8, 0, 0.5, 0);
  pieces.push({ geo: prep(flap, shade(hide, -0.1), true), at: 0.85 });
  pieces.push({ geo: prep(place(new BoxGeometry(0.3, 0.6, 0.02), 0, 0.35, R * 0.6), 0xffb85a), at: 1, glow: true });
  pieces.push({ geo: props(rng, style, [[1.4, -0.6]]), at: 0.99 });
  return pieces;
}

function roundHutPieces(seed: number, style: Style): Piece[] {
  const rng = new Rng(seed);
  const pieces: Piece[] = [];
  const R = 1.55;
  const stoneWall = style.culture === 'stone' || style.culture === 'glass';
  pieces.push({ geo: prep(place(new CylinderGeometry(R + 0.14, R + 0.22, 0.16, 20), 0, 0.03, 0), shade(style.stone, -0.05), true), at: 0.02 });
  const n = 8;
  if (!stoneWall) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.PI / n;
      pieces.push({ geo: post(Math.sin(a) * R, Math.cos(a) * R, 1.4 + rng.range(-0.05, 0.05), 0.08, style.wood), at: 0.06 + (i / n) * 0.24 });
    }
  }
  // Walls: wattle panels, bark, or stacked stone courses. Door on +z.
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2 + Math.PI / n;
    const a1 = ((i + 1) / n) * Math.PI * 2 + Math.PI / n;
    const mid = (a0 + a1) / 2;
    if (Math.abs(Math.sin(mid)) < 0.2 && Math.cos(mid) > 0) continue;
    const w = 2 * R * Math.sin(Math.PI / n) + 0.04;
    if (stoneWall) {
      const parts: BufferGeometry[] = [];
      for (let k = 0; k < 4; k++) {
        const g = lumpy(new BoxGeometry(w, 0.3, 0.32), 0.1, rng.int(0, 1e6));
        place(g, Math.sin(mid) * R, 0.2 + k * 0.3, Math.cos(mid) * R, 0, mid + (k % 2) * 0.1, 0);
        parts.push(prep(g, shade(style.wallColor, rng.range(-0.08, 0.04)), true));
      }
      pieces.push({ geo: merge(parts), at: 0.12 + (i / n) * 0.5 });
    } else {
      const panel = new BoxGeometry(w, 1.15, 0.12);
      panel.rotateY(mid);
      panel.translate(Math.sin(mid) * R * 0.97, 0.64, Math.cos(mid) * R * 0.97);
      const wall = style.culture === 'grove' ? shade(style.wallColor, (i % 2) * 0.04) : style.culture === 'ember' ? shade(style.wallColor, (i % 2) * 0.05) : shade(style.wallColor, i % 2 ? -0.06 : 0);
      pieces.push({ geo: prep(panel, (p) => tmp.set(wall).offsetHSL(0, 0, Math.sin(p.y * 22) * 0.03), true), at: 0.34 + (i / n) * 0.34 });
    }
  }
  pieces.push({ geo: box(0.95, 0.13, 0.16, 0, 1.2, R * 0.98, shade(style.wood, 0.08)), at: 0.66 });
  pieces.push({ geo: windowGlow(0, 0.62, R * 0.72, 0.62, 0.95, 0), at: 0.99, glow: true });
  // Roof by culture.
  const rc = style.roofColor;
  if (style.roof === 'moss') {
    const dome = lumpy(new SphereGeometry(R + 0.45, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0.08, seed);
    place(dome, 0, 1.25, 0, 0, 0, 0, 1, 0.75, 1);
    pieces.push({ geo: prep(dome, (p) => tmp.set(rc).offsetHSL(0, 0.05, (p.y - 1.25) * 0.08 + Math.sin(p.x * 5 + p.z * 3) * 0.03), true), at: 0.78 });
    const flowers: BufferGeometry[] = [];
    for (let i = 0; i < 7; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(0.3, 1.4);
      const y = 1.25 + Math.sqrt(Math.max(0, 1 - (r / (R + 0.45)) ** 2)) * (R + 0.45) * 0.75;
      flowers.push(prep(place(new IcosahedronGeometry(0.07, 0), Math.cos(a) * r, y, Math.sin(a) * r), [0xffffff, 0xffe066, 0xff8fb1][i % 3]!, true));
    }
    pieces.push({ geo: merge(flowers), at: 0.96 });
  } else {
    const steep = style.roof === 'hide' ? 1.25 : style.roof === 'slate' ? 1.0 : style.roof === 'glass' ? 1.4 : 0.9;
    const r1 = new ConeGeometry(R + 0.5, 0.75 * steep, 20, 1, true);
    r1.translate(0, 1.47, 0);
    pieces.push({ geo: prep(r1, shade(rc, -0.08), true), at: 0.72 });
    const r2 = new ConeGeometry(R + 0.22, 0.95 * steep, 20);
    r2.translate(0, 1.47 + 0.3 * steep, 0);
    pieces.push({ geo: prep(r2, (p) => tmp.set(rc).offsetHSL(0, 0, Math.sin(p.y * 14) * 0.035), true), at: 0.82 });
    const r3 = new ConeGeometry(0.8, 0.8 * steep, 16);
    r3.translate(0, 1.47 + 0.78 * steep, 0);
    pieces.push({ geo: prep(r3, shade(rc, -0.05), true), at: 0.92 });
    const top = 1.47 + 1.18 * steep;
    if (style.roof === 'hide') {
      // Crossed poles above the smoke hole.
      const poles: BufferGeometry[] = [];
      for (let i = 0; i < 4; i++) poles.push(prep(place(new CylinderGeometry(0.03, 0.03, 0.9, 4), 0, top + 0.1, 0, 0.35 * Math.cos(i * 1.57), 0, 0.35 * Math.sin(i * 1.57)), style.wood, true));
      pieces.push({ geo: merge(poles), at: 0.97 });
    } else if (style.roof === 'glass') {
      const c = new OctahedronGeometry(0.2, 0);
      c.scale(1, 2.2, 1);
      pieces.push({ geo: prep(place(c, 0, top + 0.25, 0), 0xc8f0ff, true), at: 0.97 });
    } else {
      pieces.push({ geo: prep(place(new SphereGeometry(0.12, 8, 6), 0, top - 0.1, 0), style.wood, true), at: 0.97 });
    }
  }
  pieces.push({ geo: scaffold(R * 2, R * 2, 2.3, 0xb08a5a), at: 0.25, until: 0.97 });
  pieces.push({ geo: props(rng, style, [[R + 0.5, -0.8]]), at: 0.99 });
  return pieces;
}

function housePieces(seed: number, style: Style): Piece[] {
  const rng = new Rng(seed);
  const pieces: Piece[] = [];
  const W = 4.2;
  const D = 3.2;
  const H = 1.9;
  pieces.push({ geo: footing(W + 0.2, D + 0.2, style.stone, rng), at: 0.03 });
  // Timber frame.
  const frame: BufferGeometry[] = [];
  for (const [x, z] of [
    [-W / 2, -D / 2],
    [W / 2, -D / 2],
    [-W / 2, D / 2],
    [W / 2, D / 2],
    [0, -D / 2],
    [0, D / 2],
  ] as const) {
    frame.push(post(x, z, H, 0.1, style.wood, 0.25));
  }
  pieces.push({ geo: merge(frame), at: 0.14 });
  pieces.push({ geo: merge([box(W + 0.2, 0.14, 0.16, 0, 0.25 + H, -D / 2, style.wood), box(W + 0.2, 0.14, 0.16, 0, 0.25 + H, D / 2, style.wood), box(0.16, 0.14, D + 0.2, -W / 2, 0.25 + H, 0, style.wood), box(0.16, 0.14, D + 0.2, W / 2, 0.25 + H, 0, style.wood)]), at: 0.26 });
  // Walls: plaster/stone infill panels; door and windows on the front (+z).
  const infill = style.culture === 'stone' ? shade(style.wallColor, -0.04) : style.wallColor;
  const walls: BufferGeometry[] = [];
  walls.push(box(W, H, 0.14, 0, 0.25 + H / 2, -D / 2, infill));
  walls.push(box(0.14, H, D, -W / 2, 0.25 + H / 2, 0, infill));
  walls.push(box(0.14, H, D, W / 2, 0.25 + H / 2, 0, infill));
  pieces.push({ geo: merge(walls), at: 0.42 });
  const front: BufferGeometry[] = [];
  front.push(box(W / 2 - 0.55, H, 0.14, -W / 4 - 0.28, 0.25 + H / 2, D / 2, infill));
  front.push(box(W / 2 - 0.55, H, 0.14, W / 4 + 0.28, 0.25 + H / 2, D / 2, infill));
  front.push(box(1.1, 0.4, 0.14, 0, 0.25 + H - 0.2, D / 2, infill));
  // Diagonal braces for a half-timbered look.
  for (const s of [-1, 1]) front.push(box(0.1, 1.4, 0.05, s * (W / 2 - 0.55), 0.25 + H / 2, D / 2 + 0.08, style.wood, 0, 0, s * 0.55));
  pieces.push({ geo: merge(front), at: 0.55 });
  pieces.push({ geo: merge([box(1.0, 1.5, 0.08, 0, 1.0, D / 2 + 0.02, shade(style.wood, -0.12)), box(0.07, 0.07, 0.03, 0.3, 1.0, D / 2 + 0.07, 0x2a2420)]), at: 0.66 });
  // Window shutters.
  const shutters: BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    shutters.push(box(0.1, 0.62, 0.05, s * (W / 4 + 0.28) - 0.42, 1.3, D / 2 + 0.09, style.banner));
    shutters.push(box(0.1, 0.62, 0.05, s * (W / 4 + 0.28) + 0.42, 1.3, D / 2 + 0.09, style.banner));
  }
  pieces.push({ geo: merge(shutters), at: 0.95 });
  pieces.push({ geo: merge([windowGlow(-(W / 4 + 0.28), 1.3, D / 2 + 0.03, 0.62, 0.55, 0), windowGlow(W / 4 + 0.28, 1.3, D / 2 + 0.03, 0.62, 0.55, 0), windowGlow(0, 1.0, D / 2 - 0.03, 0.9, 1.4, 0)]), at: 1, glow: true });
  // Roof: gable, roof ridge along x.
  const rise = style.roof === 'slate' ? 1.4 : style.roof === 'hide' ? 1.6 : 1.5;
  const roof = gable(W, D, rise, 0.25 + H, style, rng);
  pieces.push({ geo: merge([...gableEnds(W, D, rise, 0.25 + H, shade(style.wallColor, -0.05))]), at: 0.68 });
  pieces.push({ geo: merge(roof.slice(0, Math.ceil(roof.length / 2))), at: 0.78 });
  pieces.push({ geo: merge(roof.slice(Math.ceil(roof.length / 2))), at: 0.88 });
  // Chimney.
  const chimney = lumpy(new BoxGeometry(0.55, 1.6, 0.55, 1, 3, 1), 0.06, seed + 3);
  place(chimney, W / 2 - 0.7, 0.25 + H + 0.9, -0.5);
  pieces.push({ geo: prep(chimney, shade(style.stone, -0.04), true), at: 0.93 });
  // Porch posts and a little awning over the door.
  pieces.push({ geo: merge([post(-0.7, D / 2 + 0.8, 1.8, 0.06, style.wood), post(0.7, D / 2 + 0.8, 1.8, 0.06, style.wood), box(1.7, 0.08, 1.0, 0, 2.02, D / 2 + 0.45, shade(style.roofColor, -0.05), 0, -0.22)]), at: 0.97 });
  pieces.push({ geo: scaffold(W, D, 3.2, 0xb08a5a), at: 0.2, until: 0.97 });
  pieces.push({ geo: props(rng, style, [[W / 2 + 0.6, 0.6], [-W / 2 - 0.5, -0.8]]), at: 0.99 });
  return pieces;
}

function workshopPieces(seed: number, style: Style): Piece[] {
  const rng = new Rng(seed);
  const pieces: Piece[] = [];
  const W = 3.8;
  const D = 2.8;
  pieces.push({ geo: prep(place(new BoxGeometry(W + 0.4, 0.12, D + 0.4), 0, 0.05, 0), 0x8c7a5c, true), at: 0.03 });
  const posts: BufferGeometry[] = [];
  for (const [x, z, h] of [
    [-W / 2, -D / 2, 2.6],
    [W / 2, -D / 2, 2.6],
    [-W / 2, D / 2, 2.0],
    [W / 2, D / 2, 2.0],
  ] as const) {
    posts.push(post(x, z, h, 0.1, style.wood));
  }
  pieces.push({ geo: merge(posts), at: 0.15 });
  pieces.push({ geo: box(W, 1.5, 0.12, 0, 0.8, -D / 2, style.culture === 'stone' ? style.wallColor : shade(style.wood, 0.1)), at: 0.4 });
  // Lean-to roof sloping to the front.
  const roof = new BoxGeometry(W + 0.7, 0.16, D + 0.9);
  place(roof, 0, 2.35, 0, 0.21, 0, 0);
  pieces.push({ geo: prep(roof, (p) => tmp.set(style.roofColor).offsetHSL(0, 0, Math.sin(p.z * 9) * 0.04), true), at: 0.7 });
  // Workbench, anvil, kiln with a glowing mouth.
  pieces.push({ geo: merge([box(1.6, 0.1, 0.6, -0.6, 0.85, -0.7, shade(style.wood, 0.15)), post(-1.3, -0.95, 0.85, 0.05, style.wood), post(0.1, -0.95, 0.85, 0.05, style.wood), post(-1.3, -0.45, 0.85, 0.05, style.wood), post(0.1, -0.45, 0.85, 0.05, style.wood)]), at: 0.8 });
  const kiln = lumpy(new SphereGeometry(0.75, 9, 7, 0, Math.PI * 2, 0, Math.PI / 2), 0.08, seed);
  place(kiln, 1.2, 0.1, -0.4);
  pieces.push({ geo: merge([prep(kiln, shade(style.stone, -0.05), true), prep(place(new CylinderGeometry(0.12, 0.15, 0.9, 6), 1.2, 1.0, -0.4), shade(style.stone, -0.1), true)]), at: 0.88 });
  pieces.push({ geo: prep(place(new BoxGeometry(0.4, 0.3, 0.05), 1.2, 0.3, 0.33), 0xff8a3a), at: 1, glow: true });
  pieces.push({ geo: merge([box(0.5, 0.35, 0.3, 0.2, 0.18, 0.5, 0x3a3434), box(0.7, 0.12, 0.25, 0.2, 0.42, 0.5, 0x4a4444)]), at: 0.92 });
  // Tool rack.
  const tools: BufferGeometry[] = [box(1.2, 0.06, 0.06, -0.7, 1.6, -D / 2 + 0.1, style.wood)];
  for (let i = 0; i < 4; i++) tools.push(box(0.05, 0.8, 0.05, -1.1 + i * 0.28, 1.25, -D / 2 + 0.15, i % 2 ? 0x5a4a3a : 0x6a6a70));
  pieces.push({ geo: merge(tools), at: 0.95 });
  pieces.push({ geo: props(rng, style, [[W / 2 + 0.5, 0.8], [-W / 2 - 0.4, 0.9]]), at: 0.99 });
  return pieces;
}

function hallPieces(seed: number, style: Style): Piece[] {
  const rng = new Rng(seed);
  const pieces: Piece[] = [];
  const W = 7.6;
  const D = 4.4;
  const H = 2.4;
  pieces.push({ geo: footing(W + 0.3, D + 0.3, style.stone, rng), at: 0.03 });
  const frame: BufferGeometry[] = [];
  for (let i = 0; i <= 4; i++) {
    const x = -W / 2 + (i / 4) * W;
    frame.push(post(x, -D / 2, H + 0.3, 0.13, style.wood, 0.2), post(x, D / 2, H + 0.3, 0.13, style.wood, 0.2));
  }
  pieces.push({ geo: merge(frame), at: 0.12 });
  const walls: BufferGeometry[] = [];
  walls.push(box(W, H, 0.16, 0, 0.2 + H / 2, -D / 2, style.wallColor));
  walls.push(box(0.16, H, D, -W / 2, 0.2 + H / 2, 0, style.wallColor));
  walls.push(box(0.16, H, D, W / 2, 0.2 + H / 2, 0, style.wallColor));
  walls.push(box(W / 2 - 0.8, H, 0.16, -W / 4 - 0.4, 0.2 + H / 2, D / 2, style.wallColor));
  walls.push(box(W / 2 - 0.8, H, 0.16, W / 4 + 0.4, 0.2 + H / 2, D / 2, style.wallColor));
  walls.push(box(1.6, 0.5, 0.16, 0, 0.2 + H - 0.25, D / 2, style.wallColor));
  pieces.push({ geo: merge(walls), at: 0.4 });
  pieces.push({ geo: merge([box(0.75, 1.8, 0.1, -0.4, 1.1, D / 2 + 0.02, shade(style.wood, -0.1)), box(0.75, 1.8, 0.1, 0.4, 1.1, D / 2 + 0.02, shade(style.wood, -0.14))]), at: 0.6 });
  const glows: BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) glows.push(windowGlow(-W / 2 + 1.1 + i * 0.9, 1.5, D / 2 + 0.05, 0.4, 0.55, 0), windowGlow(W / 2 - 1.1 - i * 0.9, 1.5, D / 2 + 0.05, 0.4, 0.55, 0));
  glows.push(windowGlow(0, 1.1, D / 2 - 0.05, 1.4, 1.7, 0));
  pieces.push({ geo: merge(glows), at: 1, glow: true });
  const rise = 2.3;
  pieces.push({ geo: merge(gableEnds(W, D, rise, 0.2 + H, shade(style.wallColor, -0.06))), at: 0.66 });
  const roof = gable(W, D, rise, 0.2 + H, style, rng);
  pieces.push({ geo: merge(roof.slice(0, Math.ceil(roof.length / 2))), at: 0.76 });
  pieces.push({ geo: merge(roof.slice(Math.ceil(roof.length / 2))), at: 0.86 });
  // Carved crossed gable horns and banners in the people's colour.
  const horns: BufferGeometry[] = [];
  for (const s of [1, -1]) {
    for (const t of [1, -1]) horns.push(box(0.12, 1.3, 0.12, (s * (W + 0.5)) / 2, 0.2 + H + rise + 0.25, t * 0.25, style.wood, 0, 0, t * 0.6));
  }
  pieces.push({ geo: merge(horns), at: 0.92 });
  const banners: BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    banners.push(post(s * 1.3, D / 2 + 1.1, 3.6, 0.05, style.wood));
    banners.push(box(0.7, 1.1, 0.03, s * 1.3 + 0.38, 2.9, D / 2 + 1.1, style.banner));
    banners.push(box(0.7, 0.12, 0.035, s * 1.3 + 0.38, 2.4, D / 2 + 1.1, style.accent));
  }
  pieces.push({ geo: merge(banners), at: 0.97 });
  pieces.push({ geo: scaffold(W, D, 3.8, 0xb08a5a), at: 0.15, until: 0.97 });
  pieces.push({ geo: props(rng, style, [[W / 2 + 0.7, 1], [-W / 2 - 0.7, 1.2], [W / 2 + 0.7, -1]]), at: 0.99 });
  return pieces;
}

function wellPieces(seed: number, style: Style): Piece[] {
  const rng = new Rng(seed);
  const pieces: Piece[] = [];
  const ring: BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + k * 0.3;
      const g = lumpy(new BoxGeometry(0.45, 0.24, 0.3), 0.1, rng.int(0, 1e6));
      place(g, Math.cos(a) * 0.72, 0.12 + k * 0.24, Math.sin(a) * 0.72, 0, -a, 0);
      ring.push(prep(g, shade(style.stone, rng.range(-0.06, 0.05)), true));
    }
    pieces.push({ geo: merge(ring.splice(0)), at: 0.1 + k * 0.25 });
  }
  pieces.push({ geo: prep(place(new CylinderGeometry(0.6, 0.6, 0.05, 16), 0, 0.55, 0), 0x2f5a6a), at: 0.8 });
  pieces.push({ geo: merge([post(-0.8, 0, 1.8, 0.06, style.wood), post(0.8, 0, 1.8, 0.06, style.wood), prep(place(new CylinderGeometry(0.06, 0.06, 1.8, 6), 0, 1.6, 0, 0, 0, Math.PI / 2), style.wood, true)]), at: 0.88 });
  pieces.push({ geo: merge([prep(place(new ConeGeometry(1.2, 0.7, 4), 0, 2.05, 0, 0, Math.PI / 4), style.roofColor, true), prep(place(new CylinderGeometry(0.14, 0.11, 0.22, 8), 0.25, 1.05, 0), shade(style.wood, 0.1), true)]), at: 0.96 });
  return pieces;
}

function towerPieces(seed: number, style: Style): Piece[] {
  const rng = new Rng(seed);
  const pieces: Piece[] = [];
  const base: BufferGeometry[] = [];
  for (let k = 0; k < 7; k++) {
    for (let side = 0; side < 4; side++) {
      const g = lumpy(new BoxGeometry(2.1, 0.5, 0.45), 0.08, rng.int(0, 1e6));
      const a = (side / 4) * Math.PI * 2;
      place(g, Math.sin(a) * 0.95, 0.25 + k * 0.5, Math.cos(a) * 0.95, 0, a, 0);
      base.push(prep(g, shade(style.stone, rng.range(-0.06, 0.05)), true));
    }
    if (k === 2 || k === 5) pieces.push({ geo: merge(base.splice(0)), at: 0.05 + k * 0.08 });
  }
  pieces.push({ geo: merge(base.splice(0)), at: 0.5 });
  pieces.push({ geo: box(2.8, 0.14, 2.8, 0, 3.6, 0, style.wood), at: 0.6 });
  const rail: BufferGeometry[] = [];
  for (const [x, z] of [
    [-1.3, -1.3],
    [1.3, -1.3],
    [-1.3, 1.3],
    [1.3, 1.3],
  ] as const) {
    rail.push(post(x, z, 1.6, 0.06, style.wood, 3.6));
  }
  for (const s of [-1, 1]) rail.push(box(2.7, 0.07, 0.07, 0, 4.2, s * 1.3, style.wood), box(0.07, 0.07, 2.7, s * 1.3, 4.2, 0, style.wood));
  pieces.push({ geo: merge(rail), at: 0.75 });
  pieces.push({ geo: prep(place(new ConeGeometry(2.2, 1.5, 4), 0, 5.9, 0, 0, Math.PI / 4), style.roofColor, true), at: 0.88 });
  pieces.push({ geo: merge([post(0, 0, 1.6, 0.04, style.wood, 6.5), box(0.9, 0.5, 0.03, 0.47, 7.8, 0, style.banner)]), at: 0.97 });
  pieces.push({ geo: scaffold(2.2, 2.2, 4.5, 0xb08a5a), at: 0.15, until: 0.95 });
  return pieces;
}

function monumentPieces(seed: number, style: Style): Piece[] {
  const rng = new Rng(seed);
  const pieces: Piece[] = [];
  for (let s = 0; s < 3; s++) {
    const g = lumpy(new BoxGeometry(4.2 - s * 1.1, 0.4, 4.2 - s * 1.1), 0.03, seed + s);
    place(g, 0, 0.2 + s * 0.4, 0);
    pieces.push({ geo: prep(g, shade(style.stone, 0.05 - s * 0.03), true), at: 0.05 + s * 0.15 });
  }
  const pillar = lumpy(new BoxGeometry(0.7, 3.2, 0.7, 1, 4, 1), 0.04, seed);
  place(pillar, 0, 2.8, 0);
  pieces.push({ geo: prep(pillar, shade(style.stone, 0.08), true), at: 0.6 });
  const ring = new TorusGeometry(0.9, 0.12, 6, 20);
  place(ring, 0, 4.9, 0);
  pieces.push({ geo: prep(ring, 0xd9b45a, true), at: 0.8 });
  const gem = new OctahedronGeometry(0.45, 0);
  gem.scale(1, 1.5, 1);
  place(gem, 0, 4.9, 0);
  pieces.push({ geo: prep(gem, 0xd8f0ff, true), at: 0.95 });
  pieces.push({ geo: prep(place(new SphereGeometry(0.55, 10, 8), 0, 4.9, 0), 0x9fe8ff), at: 1, glow: true });
  const braziers: BufferGeometry[] = [];
  for (const [x, z] of [
    [-1.6, -1.6],
    [1.6, -1.6],
    [-1.6, 1.6],
    [1.6, 1.6],
  ] as const) {
    braziers.push(prep(place(new CylinderGeometry(0.1, 0.14, 0.9, 6), x, 0.85, z), shade(style.stone, -0.1), true));
    braziers.push(prep(place(new CylinderGeometry(0.3, 0.18, 0.25, 8), x, 1.35, z), 0x6a5a4a, true));
  }
  pieces.push({ geo: merge(braziers), at: 0.9 });
  void rng;
  return pieces;
}

/** Pieces for any building in a culture's style. */
export function buildingPieces(kind: StructureKind, seed: number, style: Style): Piece[] {
  switch (kind) {
    case 'tent':
      return tentPieces(seed, style);
    case 'hut':
      return roundHutPieces(seed, style);
    case 'house':
      return housePieces(seed, style);
    case 'workshop':
      return workshopPieces(seed, style);
    case 'hall':
      return hallPieces(seed, style);
    case 'well':
      return wellPieces(seed, style);
    case 'tower':
      return towerPieces(seed, style);
    case 'monument':
      return monumentPieces(seed, style);
    case 'campfire':
      return campfirePieces(seed);
    case 'storage':
      return recolor(storagePieces(), style);
    case 'garden':
      return gardenPieces();
    case 'shrine':
      return recolor(shrinePieces(), style);
    default:
      return gravePieces();
  }
}

/** Swap the default thatch/wood tones of older models for a culture's palette. */
function recolor(pieces: Piece[], style: Style): Piece[] {
  const thatch = new Color(0xdcb65e);
  const roof = new Color(style.roofColor);
  const wattle = new Color(0xc9a071);
  const wall = new Color(style.wallColor);
  const c = new Color();
  for (const p of pieces) {
    const col = p.geo.getAttribute('color');
    if (!col) continue;
    for (let i = 0; i < col.count; i++) {
      c.setRGB(col.getX(i), col.getY(i), col.getZ(i));
      if (dist(c, thatch) < 0.12) c.copy(roof);
      else if (dist(c, wattle) < 0.1) c.copy(wall);
      col.setXYZ(i, c.r, c.g, c.b);
    }
  }
  return pieces;
}

function dist(a: Color, b: Color): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

export { Vector3, DodecahedronGeometry };
