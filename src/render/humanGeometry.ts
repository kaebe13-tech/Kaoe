import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  LatheGeometry,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import { merge, prep } from './geometry';

/** Body dimensions shared by geometry and the pose rig. */
export const BODY = {
  hipY: 0.44,
  legLen: 0.4,
  hipX: 0.085,
  shoulderY: 0.35, // above pelvis
  shoulderX: 0.185,
  neckY: 0.41, // above pelvis
  headR: 0.17,
  armLen: 0.37,
};

const WHITE = 0xffffff;

/** Tunic: a softly flared lathe shape; origin at the pelvis. */
export function torsoGeometry(): BufferGeometry {
  const pts = [
    new Vector2(0.0, -0.1),
    new Vector2(0.19, -0.09),
    new Vector2(0.205, -0.02),
    new Vector2(0.18, 0.12),
    new Vector2(0.16, 0.26),
    new Vector2(0.15, 0.34),
    new Vector2(0.11, 0.4),
    new Vector2(0.0, 0.42),
  ];
  const g = new LatheGeometry(pts, 14);
  g.scale(1, 1, 0.78);
  // Belt: slightly darker band, via vertex colour.
  return prep(g, (p) => new Color(WHITE).multiplyScalar(p.y > -0.03 && p.y < 0.02 ? 0.72 : 1));
}

/** Head with eyes and nose baked in via vertex colours; origin at the neck. */
export function headGeometry(): BufferGeometry {
  const r = BODY.headR;
  const head = new SphereGeometry(r, 16, 12);
  head.translate(0, r * 0.95, 0);
  const parts = [prep(head, WHITE)];
  for (const sx of [-1, 1]) {
    const eye = new SphereGeometry(0.026, 8, 6);
    eye.scale(1, 1.25, 0.6);
    eye.translate(sx * 0.062, r * 1.0, r * 0.93);
    parts.push(prep(eye, new Color(0.02, 0.02, 0.03).getHex()));
    const cheek = new SphereGeometry(0.03, 8, 6);
    cheek.scale(1, 0.6, 0.4);
    cheek.translate(sx * 0.1, r * 0.72, r * 0.86);
    parts.push(prep(cheek, new Color(1.0, 0.72, 0.68).getHex()));
  }
  const nose = new SphereGeometry(0.024, 8, 6);
  nose.translate(0, r * 0.82, r * 1.0);
  parts.push(prep(nose, new Color(0.92, 0.82, 0.8).getHex()));
  return merge(parts);
}

/** Five hair styles, origin at the neck like the head. */
export function hairGeometry(style: number): BufferGeometry {
  const r = BODY.headR * 1.08;
  const cy = BODY.headR * 0.95;
  const cap = new SphereGeometry(r, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.52);
  cap.rotateX(-0.35);
  cap.translate(0, cy + 0.01, -0.012);
  const parts: BufferGeometry[] = [prep(cap, WHITE)];
  switch (style) {
    case 1: {
      // Long hair down the back.
      const back = new CapsuleGeometry(0.13, 0.16, 6, 12);
      back.scale(1.15, 1, 0.55);
      back.translate(0, cy - 0.12, -0.1);
      parts.push(prep(back, WHITE));
      break;
    }
    case 2: {
      const bun = new SphereGeometry(0.075, 10, 8);
      bun.translate(0, cy + 0.16, -0.1);
      parts.push(prep(bun, WHITE));
      break;
    }
    case 3: {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const spike = new ConeGeometry(0.045, 0.12, 5);
        spike.rotateX(-0.6 + Math.sin(a) * 0.3);
        spike.rotateZ(Math.cos(a) * 0.5);
        spike.translate(Math.cos(a) * 0.08, cy + 0.16, Math.sin(a) * 0.06 - 0.03);
        parts.push(prep(spike, WHITE));
      }
      break;
    }
    case 4: {
      const tail = new CapsuleGeometry(0.05, 0.16, 4, 8);
      tail.rotateX(0.4);
      tail.translate(0, cy - 0.02, -0.19);
      parts.push(prep(tail, WHITE));
      const tie = new SphereGeometry(0.045, 8, 6);
      tie.translate(0, cy + 0.07, -0.16);
      parts.push(prep(tie, WHITE));
      break;
    }
    default:
      break;
  }
  return merge(parts);
}

/** Arm hanging down from the shoulder pivot, with a hand. */
export function armGeometry(): BufferGeometry {
  const arm = new CapsuleGeometry(0.05, BODY.armLen - 0.1, 4, 8);
  arm.translate(0, -(BODY.armLen - 0.1) / 2 - 0.02, 0);
  const hand = new SphereGeometry(0.058, 8, 6);
  hand.translate(0, -BODY.armLen + 0.01, 0);
  // Short sleeve near the shoulder, tinted separately via vertex colours (kept white = skin tint).
  return merge([prep(arm, WHITE), prep(hand, WHITE)]);
}

/** Leg hanging from the hip pivot, with a foot. */
export function legGeometry(): BufferGeometry {
  const leg = new CapsuleGeometry(0.066, BODY.legLen - 0.12, 4, 8);
  leg.translate(0, -(BODY.legLen - 0.12) / 2 - 0.02, 0);
  const foot = new SphereGeometry(0.07, 8, 6);
  foot.scale(0.9, 0.55, 1.35);
  foot.translate(0, -BODY.legLen + 0.03, 0.035);
  return merge([prep(leg, WHITE), prep(foot, new Color(0.45, 0.33, 0.25).getHex())]);
}

/** Axe: origin at the grip, extending along -y (like the arm), blade forward. */
export function axeGeometry(): BufferGeometry {
  const handle = new CylinderGeometry(0.018, 0.022, 0.58, 6);
  handle.translate(0, -0.2, 0);
  const blade = new BoxGeometry(0.03, 0.12, 0.16);
  blade.translate(0, -0.45, 0.07);
  return merge([prep(handle, 0x8a5a33), prep(blade, 0x9aa3ad, true)]);
}

export function hammerGeometry(): BufferGeometry {
  const handle = new CylinderGeometry(0.016, 0.02, 0.36, 6);
  handle.translate(0, -0.12, 0);
  const head = new BoxGeometry(0.06, 0.07, 0.15);
  head.translate(0, -0.29, 0.02);
  return merge([prep(handle, 0x8a5a33), prep(head, 0x6b6f75, true)]);
}

/** Bundle of logs carried on the back; origin at the pelvis. */
export function logBundleGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const cols = [0x8a5c36, 0x7a5030, 0x946640];
  for (let i = 0; i < 3; i++) {
    const log = new CylinderGeometry(0.055, 0.055, 0.5, 7);
    log.rotateZ(Math.PI / 2);
    log.translate((i - 1) * 0.02, 0.28 + i * 0.09 - (i === 2 ? 0.045 : 0), -0.2 - (i === 2 ? 0.0 : 0) + (i === 1 ? -0.045 : 0));
    parts.push(prep(log, cols[i]!, true));
  }
  const strap = new BoxGeometry(0.03, 0.34, 0.03);
  strap.translate(0.08, 0.28, -0.14);
  parts.push(prep(strap, 0x5a3b24));
  return merge(parts);
}

/** Little pouch of berries at the hip. */
export function pouchGeometry(): BufferGeometry {
  const bag = new SphereGeometry(0.075, 8, 6);
  bag.scale(1, 0.9, 0.8);
  bag.translate(-0.19, 0.02, 0.05);
  const parts = [prep(bag, 0xc9a26b)];
  for (let i = 0; i < 3; i++) {
    const b = new SphereGeometry(0.03, 6, 5);
    b.translate(-0.19 + (i - 1) * 0.03, 0.08, 0.05 + (i % 2) * 0.02);
    parts.push(prep(b, 0xd9283e));
  }
  return merge(parts);
}

/** A berry/fruit held in the hand while eating; origin at the grip. */
export function handFoodGeometry(): BufferGeometry {
  const f = new SphereGeometry(0.055, 8, 6);
  f.translate(0, -BODY.armLen - 0.02, 0.04);
  return prep(f, 0xd9283e);
}

export const _v = new Vector3();
