import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  LatheGeometry,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { merge, prep } from './geometry';
import { place } from './flora';

/**
 * A stylized villager: big friendly head, compact body, two-segment limbs (knees and elbows),
 * so poses read clearly from the god camera. All parts are authored white (or with baked
 * accent colours) and tinted per person through instance colours.
 */
export const BODY = {
  hipY: 0.5,
  hipX: 0.085,
  thigh: 0.25,
  shin: 0.23,
  shoulderY: 0.34,
  shoulderX: 0.19,
  neckY: 0.43,
  upperArm: 0.19,
  forearm: 0.17,
  headR: 0.19,
  /** Head centre above the neck pivot. */
  headY: 0.2,
};

const WHITE = 0xffffff;
const tmp = new Color();

// ---------------------------------------------------------------------------
// Limbs (tinted: thighs/shins = trousers, sleeves = shirt, forearms/hands = skin, boots = boots)
// ---------------------------------------------------------------------------

export function thighGeometry(): BufferGeometry {
  const g = new CapsuleGeometry(0.072, BODY.thigh - 0.1, 4, 8);
  g.translate(0, -BODY.thigh / 2, 0);
  return prep(g, WHITE);
}

export function shinGeometry(): BufferGeometry {
  const g = new CapsuleGeometry(0.06, BODY.shin - 0.09, 4, 8);
  g.translate(0, -BODY.shin / 2, 0);
  return prep(g, WHITE);
}

/** Boot, origin at the ankle, toe toward +z. */
export function bootGeometry(): BufferGeometry {
  const g = new SphereGeometry(0.07, 10, 7);
  g.scale(0.95, 0.62, 1.55);
  g.translate(0, -0.02, 0.04);
  const cuff = new CylinderGeometry(0.066, 0.07, 0.07, 10);
  cuff.translate(0, 0.02, 0);
  return merge([prep(g, (p) => tmp.set(WHITE).multiplyScalar(p.y < -0.045 ? 0.55 : 1)), prep(cuff, WHITE)]);
}

/** Sleeve: upper arm, origin at the shoulder. */
export function upperArmGeometry(): BufferGeometry {
  const g = new CapsuleGeometry(0.058, BODY.upperArm - 0.08, 4, 8);
  g.translate(0, -BODY.upperArm / 2 + 0.01, 0);
  const cap = new SphereGeometry(0.075, 8, 6);
  cap.scale(1, 0.8, 1);
  return merge([prep(g, WHITE), prep(cap, WHITE)]);
}

/** Forearm and hand, origin at the elbow. */
export function forearmGeometry(): BufferGeometry {
  const g = new CapsuleGeometry(0.046, BODY.forearm - 0.07, 4, 8);
  g.translate(0, -BODY.forearm / 2, 0);
  const hand = new SphereGeometry(0.052, 8, 7);
  hand.scale(0.9, 1.1, 0.75);
  hand.translate(0, -BODY.forearm - 0.02, 0.005);
  const thumb = new SphereGeometry(0.022, 6, 5);
  thumb.translate(0.03, -BODY.forearm - 0.005, 0.03);
  return merge([prep(g, WHITE), prep(hand, WHITE), prep(thumb, WHITE)]);
}

// ---------------------------------------------------------------------------
// Garments: body (tinted clothing colour) + trim (tinted accent colour)
// ---------------------------------------------------------------------------

function lathe(points: Array<[number, number]>, segs = 16, depth = 0.8): BufferGeometry {
  const g = new LatheGeometry(
    points.map(([r, y]) => new Vector2(r, y)),
    segs,
  );
  g.scale(1, 1, depth);
  return g;
}

/** Garment bodies, origin at the pelvis. 0 tunic, 1 robe, 2 wrap, 3 vest. */
export function garmentGeometry(kind: number): BufferGeometry {
  switch (kind) {
    case 1:
      // Robe top; the long skirt is a separate piece that follows the legs.
      return prep(lathe([[0, -0.08], [0.2, -0.07], [0.19, 0.08], [0.2, 0.24], [0.2, 0.33], [0.15, 0.41], [0.07, 0.45], [0, 0.45]]), WHITE);
    case 2:
      // Wrap: a fuller tunic cinched high, with a soft fold line.
      return prep(lathe([[0, -0.18], [0.215, -0.17], [0.22, -0.05], [0.19, 0.1], [0.2, 0.25], [0.2, 0.33], [0.15, 0.41], [0.07, 0.45], [0, 0.45]]), (p) => tmp.set(WHITE).multiplyScalar(Math.abs(p.x + p.y * 0.6 - 0.05) < 0.02 ? 0.82 : 1));
    case 3:
      // Vest over a shirt: slimmer, shorter.
      return prep(lathe([[0, -0.1], [0.19, -0.09], [0.185, 0.05], [0.19, 0.24], [0.2, 0.33], [0.15, 0.41], [0.07, 0.45], [0, 0.45]]), WHITE);
    default:
      // Tunic flaring over the hips.
      return prep(lathe([[0, -0.16], [0.215, -0.15], [0.205, -0.04], [0.185, 0.1], [0.195, 0.25], [0.2, 0.33], [0.15, 0.41], [0.07, 0.45], [0, 0.45]]), WHITE);
  }
}

/** Accent pieces for each garment: belt, collar, hems, sash, lapels. */
export function garmentTrimGeometry(kind: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const belt = new TorusGeometry(0.195, 0.022, 5, 20);
  belt.rotateX(Math.PI / 2);
  belt.scale(1, 1, 0.8);
  belt.translate(0, kind === 2 ? 0.07 : -0.01, 0);
  parts.push(prep(belt, WHITE));
  const buckle = new BoxGeometry(0.05, 0.04, 0.02);
  buckle.translate(0, kind === 2 ? 0.07 : -0.01, 0.165);
  parts.push(prep(buckle, 0xd9c27a));
  const collar = new TorusGeometry(0.1, 0.02, 5, 16);
  collar.rotateX(Math.PI / 2);
  collar.scale(1, 1, 0.85);
  collar.translate(0, 0.43, 0);
  parts.push(prep(collar, WHITE));
  if (kind === 0 || kind === 2) {
    const hem = new TorusGeometry(kind === 2 ? 0.215 : 0.212, 0.014, 4, 20);
    hem.rotateX(Math.PI / 2);
    hem.scale(1, 1, 0.8);
    hem.translate(0, kind === 2 ? -0.17 : -0.145, 0);
    parts.push(prep(hem, WHITE));
  }
  if (kind === 2) {
    // Sash across the chest.
    const sash = new BoxGeometry(0.06, 0.5, 0.02);
    place(sash, 0, 0.2, 0.16, 0.15, 0, 0.62);
    parts.push(prep(sash, WHITE));
    const sashB = new BoxGeometry(0.06, 0.5, 0.02);
    place(sashB, 0, 0.2, -0.16, -0.15, 0, -0.62);
    parts.push(prep(sashB, WHITE));
  }
  if (kind === 3) {
    // Open vest panels.
    for (const s of [-1, 1]) {
      const panel = new BoxGeometry(0.1, 0.38, 0.03);
      place(panel, s * 0.085, 0.16, 0.155, 0.06, 0, s * 0.08);
      parts.push(prep(panel, WHITE));
    }
  }
  return merge(parts);
}

/** Long robe skirt, origin at the hips; tilts with the legs. */
export function robeSkirtGeometry(): BufferGeometry {
  return prep(lathe([[0.2, 0.02], [0.23, -0.12], [0.26, -0.3], [0.285, -0.42], [0.2, -0.44], [0, -0.44]], 16, 0.85), (p) => tmp.set(WHITE).multiplyScalar(p.y < -0.41 ? 0.8 : 1));
}

// ---------------------------------------------------------------------------
// Heads and faces
// ---------------------------------------------------------------------------

/**
 * Head with a baked face; origin at the neck. Four face variants change the eyes and mouth
 * so a crowd never looks cloned. Skin areas are white (tinted by skin colour).
 */
export function headGeometry(face: number): BufferGeometry {
  const r = BODY.headR;
  const cy = BODY.headY;
  const skull = new SphereGeometry(r, 18, 14);
  skull.scale(1, 0.97, 0.94);
  // Softer jaw: pull the lower back inward a touch.
  const pos = skull.getAttribute('position');
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (v.y < -r * 0.3) v.x *= 1 - (-(v.y + r * 0.3) / r) * 0.25;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  skull.translate(0, cy, 0);
  const parts: BufferGeometry[] = [prep(skull, WHITE)];
  const neck = new CylinderGeometry(0.055, 0.065, 0.1, 8);
  neck.translate(0, 0.03, 0);
  parts.push(prep(neck, WHITE));
  // Ears.
  for (const sx of [-1, 1]) {
    const ear = new SphereGeometry(0.038, 7, 6);
    ear.scale(0.5, 1, 0.8);
    ear.translate(sx * r * 0.93, cy + 0.005, 0);
    parts.push(prep(ear, WHITE));
  }
  // Nose.
  const nose = new SphereGeometry(face === 3 ? 0.03 : 0.026, 7, 6);
  nose.scale(1, 0.9, 1.1);
  nose.translate(0, cy - 0.02, r * 0.93);
  parts.push(prep(nose, WHITE));
  // Eyes: white, dark iris, a highlight.
  const eyeY = cy + 0.025;
  const spread = face === 2 ? 0.075 : 0.068;
  const eyeS = face === 2 ? 1.2 : face === 1 ? 0.85 : 1;
  for (const sx of [-1, 1]) {
    if (face === 1) {
      // Content, half-closed eyes: a dark arc.
      const lid = new BoxGeometry(0.05, 0.012, 0.012);
      place(lid, sx * spread, eyeY, r * 0.9, 0, 0, sx * 0.25);
      parts.push(prep(lid, 0x20150f));
    } else {
      const white = new SphereGeometry(0.03 * eyeS, 8, 6);
      white.scale(1, 1.15, 0.5);
      white.translate(sx * spread, eyeY, r * 0.86);
      parts.push(prep(white, 0xfbf7f0));
      const iris = new SphereGeometry(0.019 * eyeS, 8, 6);
      iris.scale(1, 1.15, 0.55);
      iris.translate(sx * spread, eyeY - 0.002, r * 0.895);
      parts.push(prep(iris, 0x2a1d14));
      const hi = new SphereGeometry(0.006, 5, 4);
      hi.translate(sx * spread + 0.006, eyeY + 0.008, r * 0.915);
      parts.push(prep(hi, 0xffffff));
    }
    // Rosy cheeks.
    const cheek = new SphereGeometry(0.032, 8, 6);
    cheek.scale(1, 0.55, 0.35);
    cheek.translate(sx * 0.105, cy - 0.04, r * 0.82);
    parts.push(prep(cheek, 0xf2b0a0));
  }
  // Mouth.
  if (face === 2) {
    const mouth = new SphereGeometry(0.018, 7, 5);
    mouth.scale(1.2, 0.8, 0.5);
    mouth.translate(0, cy - 0.075, r * 0.88);
    parts.push(prep(mouth, 0x6a2a24));
  } else {
    const smile = new TorusGeometry(0.03, 0.007, 4, 10, Math.PI);
    smile.rotateZ(Math.PI);
    smile.translate(0, cy - 0.058, r * 0.9);
    parts.push(prep(smile, 0x6a2a24));
  }
  if (face === 3) {
    // Freckles.
    for (let i = 0; i < 6; i++) {
      const f = new SphereGeometry(0.005, 4, 3);
      f.translate((i % 3) * 0.02 - 0.02 + (i < 3 ? -0.075 : 0.075) * 0.9, cy - 0.02 - Math.floor((i % 3) / 2) * 0.01, r * 0.9);
      parts.push(prep(f, 0xa06a4a));
    }
  }
  return merge(parts);
}

// ---------------------------------------------------------------------------
// Hair (tinted hair colour; brows included so they match)
// ---------------------------------------------------------------------------

function brows(parts: BufferGeometry[], thick: boolean): void {
  const r = BODY.headR;
  for (const sx of [-1, 1]) {
    const b = new BoxGeometry(0.055, thick ? 0.018 : 0.012, 0.015);
    place(b, sx * 0.07, BODY.headY + 0.075, r * 0.9, 0, 0, sx * -0.12);
    parts.push(prep(b, WHITE));
  }
}

/** 0 short, 1 long, 2 bun, 3 ponytail, 4 braids, 5 shaved, 6 curly. Origin at the neck. */
export function hairGeometry(style: number): BufferGeometry {
  const r = BODY.headR * 1.07;
  const cy = BODY.headY;
  const parts: BufferGeometry[] = [];
  brows(parts, style === 5 || style === 6);
  if (style !== 5) {
    const cap = new SphereGeometry(r, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.5);
    cap.rotateX(-0.42);
    cap.scale(1, 1, 0.97);
    cap.translate(0, cy + 0.012, -0.018);
    parts.push(prep(cap, WHITE));
    // Fringe.
    for (let i = 0; i < 4; i++) {
      const f = new SphereGeometry(0.05, 7, 5);
      f.scale(1, 0.6, 0.6);
      f.translate(-0.075 + i * 0.05, cy + 0.12 - Math.abs(i - 1.5) * 0.012, r * 0.72);
      parts.push(prep(f, WHITE));
    }
  } else {
    const stubble = new SphereGeometry(r * 0.97, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.42);
    stubble.rotateX(-0.5);
    stubble.translate(0, cy + 0.005, -0.02);
    parts.push(prep(stubble, (p) => tmp.set(WHITE).multiplyScalar(0.8 + Math.sin(p.x * 60) * 0.05)));
  }
  switch (style) {
    case 1: {
      const back = new CapsuleGeometry(0.15, 0.22, 6, 12);
      back.scale(1.12, 1, 0.5);
      back.translate(0, cy - 0.12, -0.11);
      parts.push(prep(back, WHITE));
      for (const sx of [-1, 1]) {
        const side = new CapsuleGeometry(0.05, 0.16, 4, 8);
        side.translate(sx * 0.17, cy - 0.06, -0.01);
        parts.push(prep(side, WHITE));
      }
      break;
    }
    case 2: {
      const bun = new SphereGeometry(0.085, 10, 8);
      bun.translate(0, cy + 0.2, -0.1);
      parts.push(prep(bun, WHITE));
      const wrap = new TorusGeometry(0.06, 0.015, 5, 12);
      wrap.rotateX(1.1);
      wrap.translate(0, cy + 0.17, -0.07);
      parts.push(prep(wrap, WHITE));
      break;
    }
    case 3: {
      const tail = new CapsuleGeometry(0.05, 0.2, 4, 8);
      tail.rotateX(0.35);
      tail.translate(0, cy - 0.06, -0.22);
      parts.push(prep(tail, WHITE));
      const tie = new SphereGeometry(0.04, 8, 6);
      tie.translate(0, cy + 0.07, -0.18);
      parts.push(prep(tie, WHITE));
      break;
    }
    case 4: {
      for (const sx of [-1, 1]) {
        for (let k = 0; k < 4; k++) {
          const b = new SphereGeometry(0.038 - k * 0.003, 7, 5);
          b.translate(sx * 0.15, cy - 0.06 - k * 0.065, -0.03 + k * 0.012);
          parts.push(prep(b, WHITE));
        }
      }
      break;
    }
    case 6: {
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const curl = new SphereGeometry(0.058, 7, 5);
        const y = cy + 0.07 + Math.sin(i * 2.3) * 0.05;
        curl.translate(Math.cos(a) * 0.17, y, Math.sin(a) * 0.16 - 0.02);
        parts.push(prep(curl, WHITE));
      }
      const top = new SphereGeometry(0.12, 9, 7);
      top.translate(0, cy + 0.16, -0.02);
      parts.push(prep(top, WHITE));
      break;
    }
    default:
      break;
  }
  return merge(parts);
}

export function beardGeometry(): BufferGeometry {
  const r = BODY.headR;
  const cy = BODY.headY;
  const beard = new SphereGeometry(0.13, 12, 8, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55);
  beard.scale(1.05, 1.1, 0.8);
  beard.translate(0, cy - 0.04, r * 0.3);
  const stache = new CapsuleGeometry(0.018, 0.07, 3, 6);
  stache.rotateZ(Math.PI / 2);
  stache.translate(0, cy - 0.045, r * 0.9);
  return merge([prep(beard, WHITE), prep(stache, WHITE)]);
}

// ---------------------------------------------------------------------------
// Headwear (index matches Appearance.headwear; 7 = leader's crown)
// ---------------------------------------------------------------------------

export function headwearGeometry(kind: number): BufferGeometry {
  const r = BODY.headR;
  const cy = BODY.headY;
  switch (kind) {
    case 1: {
      // Hood (tinted clothing colour), open at the face.
      const hood = new SphereGeometry(r * 1.2, 16, 12, Math.PI * 0.72, Math.PI * 1.56, 0, Math.PI * 0.72);
      hood.translate(0, cy + 0.01, -0.01);
      const drape = new ConeGeometry(0.2, 0.18, 14, 1, true);
      drape.translate(0, cy - 0.17, -0.02);
      const peak = new ConeGeometry(0.06, 0.12, 8);
      place(peak, 0, cy + 0.2, -0.13, -0.9, 0, 0);
      return merge([prep(hood, WHITE), prep(drape, WHITE), prep(peak, WHITE)]);
    }
    case 2: {
      const band = new TorusGeometry(r * 1.03, 0.022, 5, 20);
      band.rotateX(Math.PI / 2 - 0.35);
      band.translate(0, cy + 0.07, -0.01);
      return prep(band, WHITE);
    }
    case 3: {
      // Knitted cap with a turned-up brim.
      const cap = new SphereGeometry(r * 1.1, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.46);
      cap.rotateX(-0.25);
      cap.translate(0, cy + 0.03, -0.01);
      const brim = new TorusGeometry(r * 1.02, 0.03, 5, 18);
      brim.rotateX(Math.PI / 2 - 0.25);
      brim.translate(0, cy + 0.05, 0.0);
      const pom = new SphereGeometry(0.04, 7, 6);
      pom.translate(0, cy + 0.25, -0.06);
      return merge([prep(cap, WHITE), prep(brim, (p) => tmp.set(WHITE).multiplyScalar(0.85 + Math.sin(p.x * 80) * 0.05)), prep(pom, WHITE)]);
    }
    case 4: {
      // Headband with a feather.
      const band = new TorusGeometry(r * 1.03, 0.02, 5, 20);
      band.rotateX(Math.PI / 2 - 0.3);
      band.translate(0, cy + 0.07, -0.01);
      const feather = new ConeGeometry(0.035, 0.28, 4);
      feather.scale(1, 1, 0.3);
      place(feather, 0.12, cy + 0.2, -0.1, -0.35, 0, -0.35);
      return merge([prep(band, WHITE), prep(feather, (p) => tmp.set(p.y > cy + 0.28 ? 0x1a1a1a : 0xf4f0e8))]);
    }
    case 5: {
      // Straw hat.
      const brim = new CylinderGeometry(r * 1.9, r * 1.95, 0.02, 20);
      brim.translate(0, cy + 0.09, 0);
      const crown = new CylinderGeometry(r * 0.8, r * 1.0, 0.13, 16);
      crown.translate(0, cy + 0.16, 0);
      const ribbon = new CylinderGeometry(r * 1.01, r * 1.01, 0.03, 16);
      ribbon.translate(0, cy + 0.12, 0);
      return merge([prep(brim, (p) => tmp.set(0xe2c77a).multiplyScalar(0.92 + Math.sin(Math.atan2(p.z, p.x) * 24) * 0.06)), prep(crown, 0xd8ba68), prep(ribbon, 0xb04a36)]);
    }
    case 6: {
      // Circlet with a pale gem.
      const ring = new TorusGeometry(r * 1.02, 0.013, 5, 22);
      ring.rotateX(Math.PI / 2 - 0.3);
      ring.translate(0, cy + 0.08, -0.01);
      const gem = new OctahedronGeometry(0.025, 0);
      gem.translate(0, cy + 0.12, r * 0.95);
      return merge([prep(ring, 0xe8d08a), prep(gem, 0xa8e8ff)]);
    }
    case 7: {
      // Leader's crown.
      const parts: BufferGeometry[] = [];
      const ring = new CylinderGeometry(r * 0.98, r * 1.02, 0.07, 18, 1, true);
      ring.translate(0, cy + 0.13, 0);
      parts.push(prep(ring, 0xe8c050));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const spike = new ConeGeometry(0.03, 0.08, 4);
        spike.translate(Math.cos(a) * r * 0.98, cy + 0.2, Math.sin(a) * r * 0.98);
        parts.push(prep(spike, 0xf0cc5a));
      }
      const gem = new OctahedronGeometry(0.03, 0);
      gem.translate(0, cy + 0.14, r * 1.02);
      parts.push(prep(gem, 0xd8283e));
      return merge(parts);
    }
    default:
      return new BufferGeometry();
  }
}

// ---------------------------------------------------------------------------
// Accessories and the leader's mantle
// ---------------------------------------------------------------------------

/** 1 satchel, 2 scarf (tinted accent), 3 bead necklace. Origin at the pelvis. */
export function accessoryGeometry(kind: number): BufferGeometry {
  switch (kind) {
    case 1: {
      const strap = new TorusGeometry(0.24, 0.012, 4, 20, Math.PI * 1.1);
      place(strap, 0, 0.2, 0, 0, Math.PI / 2, 0.75);
      const bag = new BoxGeometry(0.13, 0.12, 0.06);
      bag.translate(-0.2, -0.02, 0.05);
      const flap = new BoxGeometry(0.135, 0.05, 0.065);
      flap.translate(-0.2, 0.03, 0.055);
      return merge([prep(strap, 0x6a4a2e), prep(bag, 0x8a6240), prep(flap, 0x6a4a2e)]);
    }
    case 2: {
      const scarf = new TorusGeometry(0.115, 0.04, 6, 16);
      scarf.rotateX(Math.PI / 2);
      scarf.translate(0, 0.42, 0);
      const tail = new BoxGeometry(0.06, 0.16, 0.03);
      place(tail, 0.06, 0.34, 0.12, 0.2, 0, 0.2);
      return merge([prep(scarf, WHITE), prep(tail, WHITE)]);
    }
    case 3: {
      const parts: BufferGeometry[] = [];
      const cols = [0xd9a441, 0x3f8f86, 0xb84a3a, 0xf1e3c2];
      for (let i = 0; i < 9; i++) {
        const a = -0.9 + (i / 8) * 1.8;
        const bead = new SphereGeometry(0.016, 5, 4);
        bead.translate(Math.sin(a) * 0.12, 0.4 - Math.cos(a) * 0.05, Math.cos(a) * 0.15);
        parts.push(prep(bead, cols[i % cols.length]!));
      }
      return merge(parts);
    }
    default:
      return new BufferGeometry();
  }
}

/** Leader's mantle, draped from the shoulders down the back (tinted banner colour). */
export function mantleGeometry(): BufferGeometry {
  const cape = new CylinderGeometry(0.2, 0.3, 0.62, 14, 1, true, Math.PI * 0.62, Math.PI * 0.76);
  cape.translate(0, 0.14, -0.03);
  const clasp = new TorusGeometry(0.13, 0.03, 5, 16);
  clasp.rotateX(Math.PI / 2);
  clasp.translate(0, 0.43, 0);
  return merge([prep(cape, (p) => tmp.set(WHITE).multiplyScalar(p.y < -0.12 ? 0.82 : 1)), prep(clasp, 0xe8c050)]);
}

// ---------------------------------------------------------------------------
// Tools (origin at the grip, hanging along -y like the forearm)
// ---------------------------------------------------------------------------

export function axeGeometry(): BufferGeometry {
  const handle = new CylinderGeometry(0.018, 0.022, 0.6, 6);
  handle.translate(0, -0.2, 0);
  const blade = new BoxGeometry(0.03, 0.13, 0.17);
  blade.translate(0, -0.46, 0.075);
  const edge = new BoxGeometry(0.032, 0.14, 0.03);
  edge.translate(0, -0.46, 0.16);
  return merge([prep(handle, 0x8a5a33), prep(blade, 0x8f969e, true), prep(edge, 0xd8dde2, true)]);
}

export function hammerGeometry(): BufferGeometry {
  const handle = new CylinderGeometry(0.016, 0.02, 0.36, 6);
  handle.translate(0, -0.12, 0);
  const head = new BoxGeometry(0.065, 0.075, 0.16);
  head.translate(0, -0.3, 0.02);
  return merge([prep(handle, 0x8a5a33), prep(head, 0x6b6f75, true)]);
}

export function pickGeometry(): BufferGeometry {
  const handle = new CylinderGeometry(0.018, 0.022, 0.6, 6);
  handle.translate(0, -0.2, 0);
  const head = new CylinderGeometry(0.018, 0.012, 0.34, 5);
  head.rotateX(Math.PI / 2);
  head.translate(0, -0.47, 0.05);
  return merge([prep(handle, 0x8a5a33), prep(head, 0x7a7f86, true)]);
}

/** Woven basket held in the left hand. */
export function basketGeometry(): BufferGeometry {
  const body = new CylinderGeometry(0.1, 0.075, 0.1, 10, 1, true);
  body.translate(0, -0.2, 0.02);
  const bottom = new CylinderGeometry(0.075, 0.075, 0.01, 10);
  bottom.translate(0, -0.25, 0.02);
  const handle = new TorusGeometry(0.08, 0.008, 4, 12, Math.PI);
  handle.translate(0, -0.15, 0.02);
  const fill: BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const b = new SphereGeometry(0.03, 6, 5);
    b.translate(Math.cos(i * 1.3) * 0.05, -0.155, 0.02 + Math.sin(i * 1.3) * 0.05);
    fill.push(prep(b, i % 2 ? 0xd9283e : 0xe88a2a));
  }
  return merge([prep(body, (p) => tmp.set(0xc9a060).multiplyScalar(0.85 + Math.sin(p.y * 120) * 0.08)), prep(bottom, 0xa8844a), prep(handle, 0xa8844a), ...fill]);
}

/** Walking staff for travellers. */
export function staffGeometry(): BufferGeometry {
  const pole = new CylinderGeometry(0.016, 0.02, 1.25, 6);
  pole.translate(0, -0.3, 0);
  const knob = new SphereGeometry(0.035, 7, 5);
  knob.translate(0, 0.32, 0);
  return merge([prep(pole, 0x7a5232), prep(knob, 0x5a3b24)]);
}

// ---------------------------------------------------------------------------
// Loads (origin at the pelvis)
// ---------------------------------------------------------------------------

/** Logs balanced on the right shoulder. */
export function logBundleGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const cols = [0x8a5c36, 0x7a5030, 0x946640];
  for (let i = 0; i < 3; i++) {
    const log = new CylinderGeometry(0.05, 0.05, 0.62, 7);
    log.rotateX(Math.PI / 2);
    log.translate(-0.2 + (i === 2 ? 0.045 : i * 0.06 - 0.03), 0.5 + (i === 2 ? 0.07 : 0), -0.02);
    parts.push(prep(log, cols[i]!, true));
  }
  return merge(parts);
}

/** A block of stone hugged against the chest. */
export function stoneLoadGeometry(): BufferGeometry {
  const g = new BoxGeometry(0.22, 0.16, 0.16);
  g.translate(0, 0.14, 0.22);
  return prep(g, (p) => tmp.set(0x9a958c).offsetHSL(0, 0, (Math.sin(p.x * 40) + Math.cos(p.z * 50)) * 0.03), true);
}

export function crystalLoadGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const c = new OctahedronGeometry(0.06, 0);
    c.scale(1, 1.8, 1);
    c.rotateZ((i - 1) * 0.4);
    c.translate((i - 1) * 0.05, 0.18, 0.22);
    parts.push(prep(c, 0xc0b0ff, true));
  }
  return merge(parts);
}

/** Bundle of gifts or supplies carried on the back. */
export function packGeometry(): BufferGeometry {
  const bag = new SphereGeometry(0.15, 9, 7);
  bag.scale(1, 1.15, 0.7);
  bag.translate(0, 0.25, -0.2);
  const roll = new CylinderGeometry(0.05, 0.05, 0.32, 8);
  roll.rotateZ(Math.PI / 2);
  roll.translate(0, 0.42, -0.2);
  return merge([prep(bag, 0xb89468), prep(roll, 0x8a4a3a)]);
}
