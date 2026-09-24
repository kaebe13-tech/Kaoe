import { BoxGeometry, BufferGeometry, ConeGeometry, CylinderGeometry, DodecahedronGeometry, IcosahedronGeometry, SphereGeometry, TorusGeometry } from 'three';
import { Rng } from '../core/rng';
import { merge, prep } from './geometry';

/** A piece of a building that appears when construction passes `at` (0..1). */
export interface Piece {
  geo: BufferGeometry;
  at: number;
  /** Optional: the piece glows at night (windows). */
  glow?: boolean;
}

const WOOD = 0x7a5232;
const WOOD_LIGHT = 0x9c7048;
const WATTLE = 0xc9a071;
const THATCH = 0xdcb65e;
const THATCH_DARK = 0xc29640;
const STONE = 0x9a958c;

function post(x: number, z: number, h: number, r = 0.075, color = WOOD): BufferGeometry {
  const g = new CylinderGeometry(r * 0.85, r, h, 6);
  g.translate(x, h / 2, z);
  return prep(g, color, true);
}

/** Round thatched hut, door facing +z (local). */
export function hutPieces(seed: number): Piece[] {
  const rng = new Rng(seed);
  const pieces: Piece[] = [];
  const R = 1.55;
  const base = new CylinderGeometry(R + 0.12, R + 0.2, 0.14, 20);
  base.translate(0, 0.02, 0);
  pieces.push({ geo: prep(base, 0x8c7a5c, true), at: 0.02 });
  const n = 8;
  // Posts (skip the doorway gap at angle 0 / +z)
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / n;
    pieces.push({ geo: post(Math.sin(a) * R, Math.cos(a) * R, 1.35 + rng.range(-0.05, 0.05)), at: 0.06 + (i / n) * 0.26 });
  }
  // Wall panels between posts, leaving a door on +z.
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2 + Math.PI / n;
    const a1 = ((i + 1) / n) * Math.PI * 2 + Math.PI / n;
    const mid = (a0 + a1) / 2;
    if (Math.abs(Math.sin(mid)) < 0.2 && Math.cos(mid) > 0) continue; // doorway
    const w = 2 * R * Math.sin(Math.PI / n) + 0.02;
    const panel = new BoxGeometry(w, 1.12, 0.1);
    panel.rotateY(mid);
    panel.translate(Math.sin(mid) * R * 0.97, 0.62, Math.cos(mid) * R * 0.97);
    const tint = WATTLE + (i % 2 === 0 ? 0 : 0x060403);
    pieces.push({ geo: prep(panel, tint, true), at: 0.34 + (i / n) * 0.34 });
  }
  // Door frame lintel + warm window.
  const lintel = new BoxGeometry(0.95, 0.12, 0.14);
  lintel.translate(0, 1.18, R * 0.98);
  pieces.push({ geo: prep(lintel, WOOD_LIGHT, true), at: 0.66 });
  const glow = new BoxGeometry(0.62, 0.95, 0.02);
  glow.translate(0, 0.6, R * 0.72);
  pieces.push({ geo: prep(glow, 0xffc46b), at: 0.99, glow: true });
  // Thatch roof in three rings.
  const r1 = new ConeGeometry(R + 0.5, 0.75, 20, 1, true);
  r1.translate(0, 1.45, 0);
  pieces.push({ geo: prep(r1, THATCH_DARK, true), at: 0.72 });
  const r2 = new ConeGeometry(R + 0.2, 0.9, 20);
  r2.translate(0, 1.75, 0);
  pieces.push({ geo: prep(r2, THATCH, true), at: 0.82 });
  const r3 = new ConeGeometry(0.8, 0.8, 16);
  r3.translate(0, 2.25, 0);
  pieces.push({ geo: prep(r3, THATCH_DARK, true), at: 0.92 });
  const knob = new SphereGeometry(0.12, 8, 6);
  knob.translate(0, 2.68, 0);
  pieces.push({ geo: prep(knob, WOOD, true), at: 0.97 });
  return pieces;
}

export function campfirePieces(seed: number): Piece[] {
  const rng = new Rng(seed);
  const pieces: Piece[] = [];
  const stones: BufferGeometry[] = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const g = new DodecahedronGeometry(0.17 + rng.range(-0.03, 0.04), 0);
    g.scale(1, 0.7, 1);
    g.translate(Math.cos(a) * 0.62, 0.08, Math.sin(a) * 0.62);
    stones.push(prep(g, STONE + (i % 3) * 0x050505, true));
  }
  pieces.push({ geo: merge(stones.slice(0, 5)), at: 0.05 });
  pieces.push({ geo: merge(stones.slice(5)), at: 0.35 });
  const ash = new CylinderGeometry(0.45, 0.5, 0.04, 12);
  ash.translate(0, 0.02, 0);
  pieces.push({ geo: prep(ash, 0x3b3530), at: 0.4 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const log = new CylinderGeometry(0.05, 0.06, 0.8, 6);
    log.translate(0, 0.4, 0);
    log.rotateZ(0.55);
    log.rotateY(a);
    log.translate(Math.cos(a) * -0.05, 0, Math.sin(a) * -0.05);
    pieces.push({ geo: prep(log, i % 2 ? WOOD : 0x5a3b24, true), at: 0.55 + i * 0.1 });
  }
  return pieces;
}

/** Raised granary on stilts with a thatch roof; door faces +z. */
export function storagePieces(): Piece[] {
  const pieces: Piece[] = [];
  const hw = 0.95;
  for (const [x, z] of [
    [-hw, -hw],
    [hw, -hw],
    [-hw, hw],
    [hw, hw],
  ] as const) {
    pieces.push({ geo: post(x, z, 0.75, 0.08), at: 0.04 + pieces.length * 0.05 });
  }
  const deck = new BoxGeometry(hw * 2 + 0.3, 0.1, hw * 2 + 0.3);
  deck.translate(0, 0.78, 0);
  pieces.push({ geo: prep(deck, WOOD_LIGHT, true), at: 0.3 });
  const wallDefs: Array<[number, number, number, number]> = [
    [0, -hw, hw * 2, 0.08],
    [-hw, 0, 0.08, hw * 2],
    [hw, 0, 0.08, hw * 2],
  ];
  wallDefs.forEach(([x, z, w, d], i) => {
    const g = new BoxGeometry(w, 0.8, d);
    g.translate(x, 1.23, z);
    pieces.push({ geo: prep(g, WATTLE, true), at: 0.42 + i * 0.1 });
  });
  const front = new BoxGeometry(hw * 2, 0.4, 0.08);
  front.translate(0, 1.03, hw);
  pieces.push({ geo: prep(front, WATTLE, true), at: 0.7 });
  const ladder = new BoxGeometry(0.4, 0.06, 0.9);
  ladder.rotateX(-0.9);
  ladder.translate(0, 0.42, hw + 0.45);
  pieces.push({ geo: prep(ladder, WOOD, true), at: 0.74 });
  const roof = new ConeGeometry(1.85, 1.1, 4, 1);
  roof.rotateY(Math.PI / 4);
  roof.translate(0, 2.15, 0);
  pieces.push({ geo: prep(roof, THATCH, true), at: 0.82 });
  return pieces;
}

/** Fenced garden plot (the bushes themselves are simulation resources). */
export function gardenPieces(): Piece[] {
  const pieces: Piece[] = [];
  const soil = new BoxGeometry(3.6, 0.08, 3.6);
  soil.translate(0, 0.02, 0);
  pieces.push({ geo: prep(soil, 0x6b4a30, true), at: 0.03 });
  const rows: BufferGeometry[] = [];
  for (let i = -1; i <= 1; i++) {
    const r = new BoxGeometry(3.2, 0.06, 0.18);
    r.translate(0, 0.08, i * 1.0);
    rows.push(prep(r, 0x5a3c26));
  }
  pieces.push({ geo: merge(rows), at: 0.15 });
  const h = 2.0;
  let k = 0;
  for (let i = -2; i <= 2; i++) {
    for (const [x, z] of [
      [i, -h],
      [i, h],
      [-h, i],
      [h, i],
    ] as const) {
      if (Math.abs(x) === h && Math.abs(z) === h && k > 0 && (x !== -h || z !== -h)) {
        // corners placed once
      }
      pieces.push({ geo: post(x, z, 0.6, 0.05, WOOD_LIGHT), at: 0.2 + (k++ / 20) * 0.45 });
    }
  }
  const rails: BufferGeometry[] = [];
  for (const [x, z, rot] of [
    [0, -h, 0],
    [0, h, 0],
    [-h, 0, Math.PI / 2],
    [h, 0, Math.PI / 2],
  ] as const) {
    for (const y of [0.25, 0.48]) {
      const r = new BoxGeometry(4.0, 0.05, 0.04);
      r.rotateY(rot);
      r.translate(x, y, z);
      rails.push(prep(r, WOOD, true));
    }
  }
  pieces.push({ geo: merge(rails.slice(0, 4)), at: 0.7 });
  pieces.push({ geo: merge(rails.slice(4)), at: 0.85 });
  return pieces;
}

export function gravePieces(): Piece[] {
  const mound = new SphereGeometry(0.55, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  mound.scale(1, 0.35, 1.6);
  const stone = new BoxGeometry(0.42, 0.55, 0.12);
  stone.translate(0, 0.27, -0.95);
  const top = new CylinderGeometry(0.21, 0.21, 0.12, 12, 1, false, 0, Math.PI);
  top.rotateX(Math.PI / 2);
  top.rotateZ(Math.PI / 2);
  top.translate(0, 0.55, -0.95);
  const flowers: BufferGeometry[] = [];
  const rng = new Rng(3);
  for (let i = 0; i < 5; i++) {
    const f = new IcosahedronGeometry(0.05, 0);
    f.translate(rng.range(-0.3, 0.3), 0.2, rng.range(-0.5, 0.6));
    flowers.push(prep(f, [0xffffff, 0xffe066, 0xff8fb1][i % 3]!, true));
  }
  return [{ geo: merge([prep(mound, 0x6b5a3a, true), prep(stone, 0xa7a29a, true), prep(top, 0xa7a29a, true), ...flowers]), at: 0 }];
}

/** A small stack of delivered logs next to a construction site. */
export function logPileGeometry(): BufferGeometry {
  const g = new CylinderGeometry(0.07, 0.07, 0.9, 7);
  g.rotateZ(Math.PI / 2);
  return prep(g, 0x8a5c36, true);
}

/** Survey stakes with a rope outline marking a building footprint. */
export function stakeRing(radius: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const s = new CylinderGeometry(0.025, 0.03, 0.45, 5);
    s.translate(Math.cos(a) * radius, 0.22, Math.sin(a) * radius);
    parts.push(prep(s, 0xb08a5a, true));
  }
  const rope = new TorusGeometry(radius, 0.012, 4, 36);
  rope.rotateX(Math.PI / 2);
  rope.translate(0, 0.35, 0);
  parts.push(prep(rope, 0xe8dcc0));
  return merge(parts);
}

/** Carved totem with painted faces, spread wings and an offering bowl. */
export function shrinePieces(): Piece[] {
  const pieces: Piece[] = [];
  const rng = new Rng(9);
  const stones: BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const g = new DodecahedronGeometry(0.22 + rng.range(-0.04, 0.05), 0);
    g.scale(1, 0.7, 1);
    g.translate(Math.cos(a) * 0.62, 0.1, Math.sin(a) * 0.62);
    stones.push(prep(g, STONE + (i % 2) * 0x080808, true));
  }
  pieces.push({ geo: merge(stones), at: 0.04 });
  const cols = [0x8a5a36, 0x9c6a40, 0x7a4c2c];
  for (let i = 0; i < 3; i++) {
    const seg = new CylinderGeometry(0.28 - i * 0.03, 0.3 - i * 0.03, 0.62, 8);
    seg.translate(0, 0.33 + i * 0.62, 0);
    const parts = [prep(seg, cols[i]!, true)];
    // Painted face on each segment (facing +z).
    for (const sx of [-1, 1]) {
      const eye = new BoxGeometry(0.1, 0.07, 0.04);
      eye.translate(sx * 0.1, 0.43 + i * 0.62, 0.27 - i * 0.03);
      parts.push(prep(eye, i === 1 ? 0xf5f0e0 : 0x1a1410));
    }
    const mouth = new BoxGeometry(0.2, 0.05, 0.04);
    mouth.translate(0, 0.22 + i * 0.62, 0.27 - i * 0.03);
    parts.push(prep(mouth, i === 1 ? 0xd9283e : 0x1a1410));
    const band = new CylinderGeometry(0.3 - i * 0.03, 0.3 - i * 0.03, 0.05, 8);
    band.translate(0, 0.62 + i * 0.62, 0);
    parts.push(prep(band, [0xe07a5f, 0x3f8f86, 0xf2c14e][i]!, true));
    pieces.push({ geo: merge(parts), at: 0.18 + i * 0.2 });
  }
  const wings: BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const w = new BoxGeometry(0.7, 0.26, 0.06);
    w.rotateZ(sx * 0.35);
    w.translate(sx * 0.5, 1.95, 0);
    wings.push(prep(w, 0xe0a53a, true));
    const tip = new BoxGeometry(0.3, 0.14, 0.07);
    tip.rotateZ(sx * 0.6);
    tip.translate(sx * 0.9, 2.12, 0);
    wings.push(prep(tip, 0x3f8f86, true));
  }
  pieces.push({ geo: merge(wings), at: 0.82 });
  const crown = new ConeGeometry(0.2, 0.4, 6);
  crown.translate(0, 2.25, 0);
  pieces.push({ geo: prep(crown, 0xf2c14e, true), at: 0.9 });
  const bowl = new SphereGeometry(0.2, 10, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  bowl.translate(0, 0.2, 0.55);
  const berries: BufferGeometry[] = [prep(bowl, 0x9c6a40, true)];
  for (let i = 0; i < 5; i++) {
    const b = new SphereGeometry(0.05, 6, 5);
    b.translate(rng.range(-0.1, 0.1), 0.22, 0.55 + rng.range(-0.08, 0.08));
    berries.push(prep(b, 0xd9283e));
  }
  pieces.push({ geo: merge(berries), at: 0.97 });
  return pieces;
}
