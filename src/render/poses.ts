import { clamp01, lerp, smoothstep } from '../core/math';
import type { AnimState } from '../agents/Agent';

/**
 * Joint angles for the procedural rig (radians). Limb pitch: negative swings forward/up.
 * Bends are flexion amounts (knees fold back, elbows fold forward).
 */
export interface Pose {
  hipY: number;
  bob: number;
  torsoPitch: number;
  torsoRoll: number;
  torsoYaw: number;
  headPitch: number;
  headYaw: number;
  headRoll: number;
  armLPitch: number;
  armLRoll: number;
  armLBend: number;
  armRPitch: number;
  armRRoll: number;
  armRBend: number;
  legLPitch: number;
  legRPitch: number;
  legLBend: number;
  legRBend: number;
  footL: number;
  footR: number;
  legSpread: number;
  /** 0 standing .. 1 lying down. */
  lie: number;
  /** Roll onto the side while lying. */
  lieRoll: number;
}

export function newPose(): Pose {
  return {
    hipY: 0.5,
    bob: 0,
    torsoPitch: 0,
    torsoRoll: 0,
    torsoYaw: 0,
    headPitch: 0,
    headYaw: 0,
    headRoll: 0,
    armLPitch: 0.05,
    armLRoll: 0.1,
    armLBend: 0.25,
    armRPitch: 0.05,
    armRRoll: 0.1,
    armRBend: 0.25,
    legLPitch: 0,
    legRPitch: 0,
    legLBend: 0.05,
    legRBend: 0.05,
    footL: 0,
    footR: 0,
    legSpread: 0.03,
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

export type Carry = 'none' | 'logs' | 'stone' | 'crystal' | 'pack' | 'basket';

export interface PoseInput {
  anim: AnimState;
  /** Seconds since this animation started (simulation time). */
  t: number;
  /** Stride phase (radians), advanced by distance actually covered on screen. */
  phase: number;
  speed: number;
  /** Per-agent variation seed 0..1. */
  seed: number;
  carry: Carry;
  wading: boolean;
  /** Elderly: a little stooped. */
  old: boolean;
}

function bump(c: number): number {
  return Math.pow(Math.sin(Math.PI * clamp01(c)), 0.6);
}

/** Knees down on the ground (kneel on one or both). */
function kneel(o: Pose, both: boolean): void {
  o.hipY = both ? 0.27 : 0.3;
  o.legLPitch = both ? -0.25 : -1.25;
  o.legLBend = both ? 1.75 : 1.3;
  o.legRPitch = both ? -0.25 : 0.05;
  o.legRBend = both ? 1.75 : 1.65;
  o.footL = both ? 0.9 : 0;
  o.footR = 0.9;
}

function crouch(o: Pose, depth: number): void {
  o.hipY = 0.5 - depth * 0.26;
  o.legLPitch = -1.2 * depth;
  o.legRPitch = -1.0 * depth;
  o.legLBend = 2.1 * depth;
  o.legRBend = 1.9 * depth;
  o.footL = 0.6 * depth;
  o.footR = 0.6 * depth;
  o.legSpread = 0.1;
}

function sitDown(o: Pose): void {
  o.hipY = 0.13;
  o.legLPitch = -1.45;
  o.legRPitch = -1.35;
  o.legLBend = 1.45;
  o.legRBend = 1.2;
  o.footL = 0.2;
  o.footR = 0.3;
  o.legSpread = 0.1;
}

/** Arms holding a load (overrides the arm channels only). */
function carryArms(o: Pose, carry: Carry, swing: number): void {
  switch (carry) {
    case 'logs':
      // Right hand steadies the logs on the shoulder.
      o.armRPitch = -2.6;
      o.armRRoll = -0.25;
      o.armRBend = 1.6;
      o.torsoRoll += 0.06;
      break;
    case 'stone':
    case 'crystal':
      // Both arms hug the load against the chest.
      o.armLPitch = o.armRPitch = -0.75 + swing * 0.05;
      o.armLBend = o.armRBend = 1.2;
      o.armLRoll = o.armRRoll = -0.2;
      o.torsoPitch -= 0.08;
      break;
    case 'pack':
      o.armLPitch = o.armRPitch = -0.35;
      o.armLBend = o.armRBend = 1.1;
      o.armLRoll = o.armRRoll = -0.05;
      o.torsoPitch += 0.12;
      break;
    case 'basket':
      o.armLPitch = -0.15;
      o.armLBend = 0.2;
      o.armLRoll = 0.18;
      break;
    default:
      break;
  }
}

/** Target pose for an animation state at a point in time. */
export function computePose(p: PoseInput, out: Pose): Pose {
  const o = copyPose(out, BASE);
  const t = p.t;
  const breath = Math.sin(t * 2.1 + p.seed * 6) * 0.018;
  const heavy = p.carry === 'stone' || p.carry === 'crystal' || p.carry === 'logs';
  switch (p.anim) {
    case 'idle':
    case 'hidden': {
      // Weight shifts slowly from foot to foot; the head looks about now and then.
      const shift = Math.sin(t * 0.55 + p.seed * 7);
      o.torsoPitch = 0.02 + breath;
      o.torsoRoll = shift * 0.035;
      o.legLBend = 0.05 + Math.max(0, shift) * 0.12;
      o.legRBend = 0.05 + Math.max(0, -shift) * 0.12;
      o.legSpread = 0.05;
      o.armLPitch = 0.04 + Math.sin(t * 1.3 + p.seed) * 0.03;
      o.armRPitch = 0.04 + Math.sin(t * 1.1 + 2) * 0.03;
      o.armLBend = o.armRBend = 0.3;
      o.headYaw = Math.sin(t * 0.37 + p.seed * 9) * 0.5 * smoothstep(0.2, 0.6, Math.sin(t * 0.21 + p.seed * 4) * 0.5 + 0.5);
      o.headPitch = 0.04 + Math.sin(t * 0.5) * 0.04;
      carryArms(o, p.carry, 0);
      break;
    }
    case 'walk':
    case 'run':
    case 'wade': {
      const run = p.anim === 'run' || p.speed > 2.9;
      const ph = p.phase;
      const s = Math.sin(ph);
      const c = Math.cos(ph);
      const amp = run ? 0.72 : 0.5;
      // Thighs swing; the knee folds while the leg travels forward (swing phase).
      o.legLPitch = -s * amp;
      o.legRPitch = s * amp;
      o.legLBend = 0.08 + Math.max(0, c) ** 1.5 * (run ? 1.35 : 0.75);
      o.legRBend = 0.08 + Math.max(0, -c) ** 1.5 * (run ? 1.35 : 0.75);
      // Heel strike toes up, push-off toes down.
      o.footL = -s * 0.25 - Math.max(0, c) * 0.2;
      o.footR = s * 0.25 - Math.max(0, -c) * 0.2;
      const armAmp = run ? 0.7 : 0.38;
      o.armLPitch = s * armAmp - (run ? 0.3 : 0.02);
      o.armRPitch = -s * armAmp - (run ? 0.3 : 0.02);
      o.armLBend = run ? 1.45 : 0.35 + Math.max(0, -s) * 0.3;
      o.armRBend = run ? 1.45 : 0.35 + Math.max(0, s) * 0.3;
      o.armLRoll = o.armRRoll = run ? 0.16 : 0.1;
      // Body rises over each planted foot; hips roll with the step.
      o.bob = Math.abs(c) * (run ? 0.06 : 0.03) - (run ? 0.02 : 0.005);
      o.torsoPitch = (run ? 0.2 : 0.05) + (heavy ? 0.08 : 0);
      o.torsoYaw = s * (run ? 0.1 : 0.06);
      o.torsoRoll = s * 0.03;
      o.headPitch = run ? -0.12 : 0.0;
      o.headYaw = -o.torsoYaw * 0.6;
      if (p.anim === 'wade' || p.wading) {
        // Arms raised clear of the water, careful short steps.
        o.armLPitch = -0.55 + s * 0.15;
        o.armRPitch = -0.55 - s * 0.15;
        o.armLBend = o.armRBend = 0.9;
        o.armLRoll = o.armRRoll = 0.35;
        o.torsoPitch += 0.08;
      }
      if (p.carry !== 'none') carryArms(o, p.carry, s);
      break;
    }
    case 'gather': {
      // Crouched, one hand picking, the other dropping into the basket.
      crouch(o, 0.75);
      const pick = (t * 1.6) % 1;
      o.torsoPitch = 0.55;
      o.headPitch = 0.3;
      o.armRPitch = -1.3 + Math.sin(pick * Math.PI * 2) * 0.35;
      o.armRBend = 0.5 + Math.max(0, Math.sin(pick * Math.PI * 2)) * 0.8;
      o.armLPitch = -0.7;
      o.armLBend = 0.9;
      o.armLRoll = o.armRRoll = -0.05;
      break;
    }
    case 'chop': {
      // Two-handed side swing: wind up, whip through, the blade meets the trunk at chest height.
      const c = (t / 0.8667) % 1;
      let arm: number;
      let lean: number;
      let twist: number;
      if (c < 0.55) {
        const e = smoothstep(0, 1, c / 0.55);
        arm = lerp(-1.35, -2.7, e);
        lean = lerp(0.15, -0.12, e);
        twist = lerp(-0.1, -0.55, e);
      } else if (c < 0.68) {
        const e = (c - 0.55) / 0.13;
        arm = lerp(-2.7, -1.45, e * e);
        lean = lerp(-0.12, 0.32, e);
        twist = lerp(-0.55, 0.25, e);
      } else {
        const e = smoothstep(0, 1, (c - 0.68) / 0.32);
        arm = lerp(-1.45, -1.35, e);
        lean = lerp(0.32, 0.15, e);
        twist = lerp(0.25, -0.1, e);
      }
      o.armLPitch = o.armRPitch = arm;
      o.armLRoll = o.armRRoll = -0.32;
      o.armLBend = o.armRBend = 0.35;
      o.torsoPitch = lean;
      o.torsoYaw = twist;
      o.legLPitch = -0.3;
      o.legRPitch = 0.25;
      o.legLBend = 0.3;
      o.legRBend = 0.15;
      o.legSpread = 0.12;
      o.hipY = 0.47;
      o.headPitch = 0.12;
      break;
    }
    case 'mine': {
      // Overhead pick swing down onto the rock.
      const c = (t / 1.0667) % 1;
      let arm: number;
      let lean: number;
      if (c < 0.5) {
        const e = smoothstep(0, 1, c / 0.5);
        arm = lerp(-0.9, -3.0, e);
        lean = lerp(0.35, -0.15, e);
      } else if (c < 0.62) {
        const e = (c - 0.5) / 0.12;
        arm = lerp(-3.0, -0.75, e * e);
        lean = lerp(-0.15, 0.6, e);
      } else {
        const e = smoothstep(0, 1, (c - 0.62) / 0.38);
        arm = lerp(-0.75, -0.9, e);
        lean = lerp(0.6, 0.35, e);
      }
      o.armLPitch = o.armRPitch = arm;
      o.armLRoll = o.armRRoll = -0.12;
      o.armLBend = o.armRBend = 0.25;
      o.torsoPitch = lean;
      o.legLPitch = -0.35;
      o.legRPitch = 0.3;
      o.legLBend = 0.45;
      o.legRBend = 0.2;
      o.legSpread = 0.14;
      o.hipY = 0.45;
      o.headPitch = 0.25;
      break;
    }
    case 'build': {
      // Down on one knee, hammering with the right hand while the left steadies the beam.
      kneel(o, false);
      const h = Math.max(0, Math.sin(t * 10.13));
      o.torsoPitch = 0.3;
      o.armRPitch = -1.35 - h * 0.6;
      o.armRBend = 0.6 + h * 0.9;
      o.armRRoll = -0.1;
      o.armLPitch = -1.1 + Math.sin(t * 1.3) * 0.05;
      o.armLBend = 0.6;
      o.armLRoll = -0.25;
      o.headPitch = 0.3;
      break;
    }
    case 'eat': {
      const c = (t / 1.35) % 1;
      const b = bump(c * 1.25);
      o.armRPitch = -0.5 - 0.9 * b;
      o.armRBend = 0.4 + 1.9 * b;
      o.armRRoll = -0.3;
      o.armLPitch = -0.45;
      o.armLBend = 1.1;
      o.armLRoll = -0.1;
      o.headPitch = -0.05 + Math.sin(t * 13) * 0.035 * smoothstep(0.5, 0.8, c);
      o.torsoPitch = 0.04 + breath;
      break;
    }
    case 'drink': {
      // Kneeling at the water, scooping with cupped hands.
      kneel(o, true);
      const c = (t / 2.4) % 1;
      const lift = bump(c);
      o.torsoPitch = 0.95 - lift * 0.55;
      o.headPitch = 0.3 - lift * 0.35;
      o.armLPitch = o.armRPitch = -1.05 - lift * 0.35;
      o.armLBend = o.armRBend = 0.4 + lift * 1.5;
      o.armLRoll = o.armRRoll = -0.3;
      break;
    }
    case 'catchRain': {
      o.armLPitch = o.armRPitch = -1.3 + Math.sin(t * 1.5) * 0.08;
      o.armLBend = o.armRBend = 1.1;
      o.armLRoll = o.armRRoll = -0.3;
      o.headPitch = -0.55;
      o.torsoPitch = -0.1;
      break;
    }
    case 'sleep': {
      // Curled up on one side.
      o.lie = 1;
      o.lieRoll = 1.2;
      o.legLPitch = -0.9;
      o.legRPitch = -0.7;
      o.legLBend = 1.3;
      o.legRBend = 1.1;
      o.armLPitch = -1.2;
      o.armRPitch = -0.9;
      o.armLBend = 1.6;
      o.armRBend = 1.4;
      o.torsoPitch = 0.25 + breath * 1.5;
      o.headPitch = 0.3;
      break;
    }
    case 'dead': {
      o.lie = 1;
      o.lieRoll = 0;
      o.armLRoll = o.armRRoll = 0.9;
      o.armLBend = o.armRBend = 0.2;
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
      o.legLBend = 0.4;
      break;
    }
    case 'sit':
    case 'sitTalk': {
      sitDown(o);
      o.torsoPitch = -0.02 + breath;
      o.armLPitch = o.armRPitch = -0.7;
      o.armLBend = o.armRBend = 0.9;
      o.armLRoll = o.armRRoll = -0.05;
      o.headPitch = 0.05;
      if (p.anim === 'sitTalk') {
        o.armRPitch = -1.0 + Math.sin(t * 4.2) * 0.3;
        o.armRBend = 1.2 + Math.sin(t * 5.1) * 0.4;
        o.armRRoll = 0.25;
        o.headPitch = Math.sin(t * 6) * 0.07;
        o.headRoll = Math.sin(t * 2.3) * 0.08;
        o.torsoYaw = Math.sin(t * 1.7) * 0.08;
      }
      break;
    }
    case 'talk': {
      o.armLPitch = -0.35 + Math.sin(t * 3.1) * 0.25;
      o.armRPitch = -0.45 + Math.sin(t * 2.3 + 1) * 0.3;
      o.armLBend = 1.0 + Math.sin(t * 4.3) * 0.35;
      o.armRBend = 1.2 + Math.sin(t * 3.7 + 1) * 0.4;
      o.armLRoll = o.armRRoll = 0.2;
      o.headPitch = Math.sin(t * 5.3) * 0.07;
      o.headRoll = Math.sin(t * 1.9) * 0.07;
      o.torsoYaw = Math.sin(t * 1.1) * 0.08;
      o.torsoPitch = 0.02 + breath;
      o.legLBend = 0.1;
      break;
    }
    case 'wave': {
      o.armRPitch = -2.8;
      o.armRRoll = -0.35;
      o.armRBend = 0.5 + Math.sin(t * 9) * 0.35;
      o.armLPitch = 0.05;
      o.headPitch = -0.1;
      o.headRoll = 0.1;
      break;
    }
    case 'threaten': {
      o.torsoPitch = 0.25;
      o.armLPitch = o.armRPitch = -1.1;
      o.armLRoll = o.armRRoll = 0.6;
      o.armLBend = o.armRBend = 0.6 + Math.sin(t * 6) * 0.15;
      o.legLPitch = -0.35;
      o.legRPitch = 0.3;
      o.legSpread = 0.14;
      o.headPitch = -0.05;
      break;
    }
    case 'cower': {
      const tremble = Math.sin(t * 31) * 0.02;
      crouch(o, 0.9);
      o.torsoPitch = 0.6 + tremble;
      o.armLPitch = o.armRPitch = -2.4;
      o.armLBend = o.armRBend = 1.9;
      o.armLRoll = o.armRRoll = -0.4;
      o.headPitch = 0.45;
      break;
    }
    case 'celebrate': {
      const j = Math.abs(Math.sin(t * 6.5));
      o.bob = j * 0.16;
      o.armLPitch = -2.85 + Math.sin(t * 9) * 0.25;
      o.armRPitch = -2.85 - Math.sin(t * 9) * 0.25;
      o.armLRoll = o.armRRoll = 0.4;
      o.armLBend = o.armRBend = 0.3;
      o.legLPitch = -j * 0.35;
      o.legRPitch = -j * 0.2;
      o.legLBend = o.legRBend = j * 0.7;
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
      o.legLBend = j * 1.1;
      o.headPitch = -0.2;
      o.torsoYaw = Math.sin(t * 5) * 0.2;
      break;
    }
    case 'stargaze': {
      sitDown(o);
      o.torsoPitch = -0.45 + breath;
      o.armLPitch = o.armRPitch = 0.9;
      o.armLBend = o.armRBend = 0.1;
      o.armLRoll = o.armRRoll = 0.25;
      o.headPitch = -0.7;
      o.headYaw = Math.sin(t * 0.2 + p.seed * 4) * 0.3;
      break;
    }
    case 'tend': {
      kneel(o, true);
      o.torsoPitch = 0.6;
      o.armLPitch = -1.0 + Math.sin(t * 4) * 0.15;
      o.armRPitch = -1.0 - Math.sin(t * 4) * 0.15;
      o.armLBend = o.armRBend = 0.6;
      o.headPitch = 0.35;
      break;
    }
    case 'pray': {
      // Kneeling, hands pressed together, head bowed.
      kneel(o, true);
      o.torsoPitch = 0.05;
      o.armLPitch = o.armRPitch = -0.55 + Math.sin(t * 2) * 0.04;
      o.armLBend = o.armRBend = 2.05;
      o.armLRoll = o.armRRoll = -0.55;
      o.headPitch = 0.5;
      break;
    }
    case 'look': {
      // Shading the eyes and scanning the horizon.
      o.armRPitch = -1.9;
      o.armRRoll = -0.45;
      o.armRBend = 1.9;
      o.armLPitch = 0.05;
      o.armLBend = 0.3;
      o.headYaw = Math.sin(t * 0.9 + p.seed * 3) * 0.65;
      o.headPitch = -0.12;
      o.torsoYaw = o.headYaw * 0.3;
      break;
    }
  }
  if (p.old && o.lie < 0.5) {
    o.torsoPitch += 0.12;
    o.headPitch -= 0.06;
  }
  return o;
}

const BASE = newPose();
