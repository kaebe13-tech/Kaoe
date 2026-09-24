import { clamp01, lerp, smoothstep } from '../core/math';
import type { AnimState } from '../agents/Agent';

/** Joint angles for the procedural rig (radians). */
export interface Pose {
  hipY: number;
  bob: number;
  torsoPitch: number;
  torsoRoll: number;
  torsoYaw: number;
  headPitch: number;
  headYaw: number;
  armLPitch: number;
  armLRoll: number;
  armRPitch: number;
  armRRoll: number;
  legLPitch: number;
  legRPitch: number;
  legSpread: number;
  /** 0 standing .. 1 lying on the back. */
  lie: number;
  /** Roll onto the side while lying. */
  lieRoll: number;
}

export function newPose(): Pose {
  return {
    hipY: 0.44,
    bob: 0,
    torsoPitch: 0,
    torsoRoll: 0,
    torsoYaw: 0,
    headPitch: 0,
    headYaw: 0,
    armLPitch: 0,
    armLRoll: 0.08,
    armRPitch: 0,
    armRRoll: 0.08,
    legLPitch: 0,
    legRPitch: 0,
    legSpread: 0.04,
    lie: 0,
    lieRoll: 0,
  };
}

const KEYS = Object.keys(newPose()) as Array<keyof Pose>;

export function copyPose(out: Pose, src: Pose): Pose {
  for (const k of KEYS) out[k] = src[k];
  return out;
}

export function blendPose(out: Pose, a: Pose, b: Pose, t: number): Pose {
  for (const k of KEYS) out[k] = lerp(a[k], b[k], t);
  return out;
}

export interface PoseInput {
  anim: AnimState;
  /** Seconds since this animation started (simulation time). */
  t: number;
  /** Walk cycle phase (radians), advances with distance travelled. */
  phase: number;
  speed: number;
  /** Per-agent variation seed 0..1. */
  seed: number;
  carryingWood: boolean;
}

function bump(c: number): number {
  // 0 -> 1 -> 0 over the cycle with a held peak.
  return Math.pow(Math.sin(Math.PI * clamp01(c)), 0.6);
}

/** Target pose for an animation state at a point in time. */
export function computePose(p: PoseInput, out: Pose): Pose {
  const o = copyPose(out, BASE);
  const t = p.t;
  const breath = Math.sin(t * 2.1 + p.seed * 6) * 0.018;
  switch (p.anim) {
    case 'idle':
    case 'hidden': {
      o.torsoPitch = 0.03 + breath;
      o.armLPitch = 0.06 + Math.sin(t * 1.3 + p.seed) * 0.03;
      o.armRPitch = 0.06 + Math.sin(t * 1.1 + 2) * 0.03;
      o.headYaw = Math.sin(t * 0.37 + p.seed * 9) * 0.45 * smoothstep(0.2, 0.6, Math.sin(t * 0.21 + p.seed * 4) * 0.5 + 0.5);
      o.headPitch = 0.05 + Math.sin(t * 0.5) * 0.04;
      break;
    }
    case 'walk':
    case 'run': {
      const run = p.anim === 'run' || p.speed > 2.9;
      const s = Math.sin(p.phase);
      const legAmp = run ? 0.85 : 0.5 + Math.min(p.speed, 2.2) * 0.04;
      o.legLPitch = -s * legAmp;
      o.legRPitch = s * legAmp;
      const armAmp = run ? 0.75 : 0.42;
      o.armLPitch = s * armAmp - (run ? 0.45 : 0);
      o.armRPitch = -s * armAmp - (run ? 0.45 : 0);
      o.armLRoll = o.armRRoll = run ? 0.18 : 0.1;
      o.bob = Math.abs(Math.cos(p.phase)) * (run ? 0.07 : 0.035);
      o.torsoPitch = run ? 0.22 : 0.06;
      o.torsoYaw = s * (run ? 0.12 : 0.07);
      o.headPitch = run ? -0.1 : 0.02;
      if (p.carryingWood) {
        o.armRPitch = -2.5; // steadying the bundle on the shoulder
        o.armRRoll = -0.35;
        o.torsoPitch += 0.08;
      }
      break;
    }
    case 'gather': {
      o.hipY = 0.37;
      o.legLPitch = -0.35;
      o.legRPitch = -0.2;
      o.torsoPitch = 0.72;
      o.headPitch = 0.25;
      o.armLPitch = -1.15 + Math.sin(t * 5.2) * 0.35;
      o.armRPitch = -1.15 - Math.sin(t * 5.2) * 0.35;
      o.armLRoll = o.armRRoll = -0.05;
      break;
    }
    case 'chop': {
      const c = (t / 0.8667) % 1;
      let arm: number;
      let lean: number;
      if (c < 0.55) {
        const e = smoothstep(0, 1, c / 0.55);
        arm = lerp(-0.45, -2.75, e);
        lean = lerp(0.15, -0.12, e);
      } else if (c < 0.68) {
        const e = (c - 0.55) / 0.13;
        arm = lerp(-2.75, -0.5, e * e);
        lean = lerp(-0.12, 0.38, e);
      } else {
        const e = smoothstep(0, 1, (c - 0.68) / 0.32);
        arm = lerp(-0.5, -0.45, e);
        lean = lerp(0.38, 0.15, e);
      }
      o.armLPitch = o.armRPitch = arm;
      o.armLRoll = o.armRRoll = -0.28;
      o.torsoPitch = lean;
      o.torsoYaw = -0.25;
      o.legLPitch = -0.2;
      o.legRPitch = 0.2;
      o.legSpread = 0.12;
      o.headPitch = 0.1;
      break;
    }
    case 'build': {
      const h = Math.max(0, Math.sin(t * 10.13));
      o.hipY = 0.38;
      o.legLPitch = -0.35;
      o.legRPitch = 0.1;
      o.torsoPitch = 0.32;
      o.armRPitch = -1.25 - h * 0.85;
      o.armRRoll = -0.1;
      o.armLPitch = -0.85 + Math.sin(t * 1.3) * 0.05;
      o.armLRoll = -0.2;
      o.headPitch = 0.3;
      break;
    }
    case 'eat': {
      const c = (t / 1.35) % 1;
      o.armRPitch = -0.25 - 2.05 * bump(c * 1.25);
      o.armRRoll = -0.35;
      o.armLPitch = -0.35;
      o.armLRoll = -0.1;
      o.headPitch = -0.05 + Math.sin(t * 13) * 0.035 * smoothstep(0.5, 0.8, c);
      o.torsoPitch = 0.04 + breath;
      break;
    }
    case 'drink': {
      o.hipY = 0.27;
      o.legLPitch = -0.95;
      o.legRPitch = -0.6;
      o.legSpread = 0.1;
      o.torsoPitch = 0.95;
      o.headPitch = 0.25 - Math.max(0, Math.sin(t * 2.6)) * 0.4;
      o.armLPitch = o.armRPitch = -1.25 + Math.sin(t * 2.6) * 0.3;
      o.armLRoll = o.armRRoll = -0.15;
      break;
    }
    case 'catchRain': {
      o.armLPitch = o.armRPitch = -1.85 + Math.sin(t * 1.5) * 0.08;
      o.armLRoll = o.armRRoll = -0.22;
      o.headPitch = -0.55;
      o.torsoPitch = -0.08;
      break;
    }
    case 'sleep': {
      o.lie = 1;
      o.lieRoll = 0.3;
      o.legLPitch = -0.45;
      o.legRPitch = -0.3;
      o.armLPitch = -0.5;
      o.armRPitch = -0.35;
      o.torsoPitch = breath * 1.5;
      o.headPitch = 0.2;
      break;
    }
    case 'dead': {
      o.lie = 1;
      o.lieRoll = 0;
      o.armLRoll = o.armRRoll = 0.9;
      o.legSpread = 0.12;
      o.headYaw = 0.5;
      break;
    }
    case 'knocked': {
      o.lie = 1;
      o.lieRoll = -0.15;
      o.armLRoll = o.armRRoll = 1.1;
      o.armLPitch = Math.sin(t * 9) * 0.06;
      o.headYaw = Math.sin(t * 2) * 0.4;
      o.legSpread = 0.14;
      break;
    }
    case 'sit':
    case 'sitTalk': {
      o.hipY = 0.15;
      o.legLPitch = -1.42;
      o.legRPitch = -1.3;
      o.legSpread = 0.12;
      o.torsoPitch = -0.06 + breath;
      o.armLPitch = o.armRPitch = -0.6;
      o.armLRoll = o.armRRoll = 0.05;
      o.headPitch = 0.05;
      if (p.anim === 'sitTalk') {
        o.armRPitch = -1.0 + Math.sin(t * 4.2) * 0.45;
        o.armRRoll = 0.3;
        o.headPitch = Math.sin(t * 6) * 0.07;
        o.torsoYaw = Math.sin(t * 1.7) * 0.08;
      }
      break;
    }
    case 'talk': {
      o.armLPitch = -0.45 + Math.sin(t * 3.1) * 0.38;
      o.armRPitch = -0.35 + Math.sin(t * 2.3 + 1) * 0.42;
      o.armLRoll = o.armRRoll = 0.22;
      o.headPitch = Math.sin(t * 5.3) * 0.07;
      o.torsoYaw = Math.sin(t * 1.1) * 0.08;
      o.torsoPitch = 0.02 + breath;
      break;
    }
    case 'cower': {
      const tremble = Math.sin(t * 31) * 0.02;
      o.hipY = 0.26;
      o.legLPitch = -1.0;
      o.legRPitch = -0.85;
      o.legSpread = 0.1;
      o.torsoPitch = 0.6 + tremble;
      o.armLPitch = o.armRPitch = -2.55;
      o.armLRoll = o.armRRoll = -0.55;
      o.headPitch = 0.4;
      break;
    }
    case 'celebrate': {
      const j = Math.abs(Math.sin(t * 6.5));
      o.bob = j * 0.16;
      o.armLPitch = -2.85 + Math.sin(t * 9) * 0.25;
      o.armRPitch = -2.85 - Math.sin(t * 9) * 0.25;
      o.armLRoll = o.armRRoll = 0.4;
      o.legLPitch = -j * 0.3;
      o.legRPitch = -j * 0.3;
      o.headPitch = -0.25;
      break;
    }
    case 'play': {
      const j = Math.abs(Math.sin(t * 8.5 + p.seed * 3));
      o.bob = j * 0.2;
      o.armLPitch = -2.4 + Math.sin(t * 11) * 0.5;
      o.armRPitch = -1.2 - Math.sin(t * 11) * 0.6;
      o.armLRoll = o.armRRoll = 0.45;
      o.legLPitch = -j * 0.5;
      o.legRPitch = j * 0.2;
      o.headPitch = -0.2;
      o.torsoYaw = Math.sin(t * 5) * 0.2;
      break;
    }
    case 'stargaze': {
      o.hipY = 0.15;
      o.legLPitch = -1.42;
      o.legRPitch = -1.35;
      o.legSpread = 0.14;
      o.torsoPitch = -0.35 + breath;
      o.armLPitch = o.armRPitch = 0.75;
      o.armLRoll = o.armRRoll = 0.25;
      o.headPitch = -0.75;
      o.headYaw = Math.sin(t * 0.2 + p.seed * 4) * 0.3;
      break;
    }
    case 'tend': {
      o.hipY = 0.27;
      o.legLPitch = -1.05;
      o.legRPitch = -0.55;
      o.torsoPitch = 0.55;
      o.armLPitch = -1.1 + Math.sin(t * 4) * 0.15;
      o.armRPitch = -1.1 - Math.sin(t * 4) * 0.15;
      o.headPitch = 0.35;
      break;
    }
    case 'pray': {
      o.hipY = 0.27;
      o.legLPitch = o.legRPitch = -1.0;
      o.torsoPitch = -0.1;
      o.armLPitch = o.armRPitch = -2.6 + Math.sin(t * 2) * 0.1;
      o.armLRoll = o.armRRoll = 0.3;
      o.headPitch = -0.45;
      break;
    }
    case 'look': {
      o.armRPitch = -2.35;
      o.armRRoll = -0.75;
      o.armLPitch = 0.05;
      o.headYaw = Math.sin(t * 0.9 + p.seed * 3) * 0.65;
      o.headPitch = -0.08;
      o.torsoYaw = o.headYaw * 0.3;
      break;
    }
  }
  return o;
}

const BASE = newPose();
