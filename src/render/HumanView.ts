import { BufferGeometry, Color, DynamicDrawUsage, Euler, Group, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Vector3 } from 'three';
import { lerpAngle, smoothstep } from '../core/math';
import { hash01 } from '../core/rng';
import type { Agent } from '../agents/Agent';
import type { Terrain } from '../world/Terrain';
import {
  BODY,
  accessoryGeometry,
  axeGeometry,
  basketGeometry,
  beardGeometry,
  bootGeometry,
  crystalLoadGeometry,
  forearmGeometry,
  garmentGeometry,
  garmentTrimGeometry,
  hairGeometry,
  hammerGeometry,
  headGeometry,
  headwearGeometry,
  logBundleGeometry,
  mantleGeometry,
  packGeometry,
  pickGeometry,
  robeSkirtGeometry,
  shinGeometry,
  staffGeometry,
  stoneLoadGeometry,
  thighGeometry,
  upperArmGeometry,
} from './humanGeometry';
import { blendPose, computePose, copyPose, newPose, type Carry, type Pose } from './poses';

interface RenderState {
  pose: Pose;
  from: Pose;
  target: Pose;
  blend: number;
  anim: string;
  seed: number;
  pos: Vector3;
  heading: number;
  visible: boolean;
  /** Stride phase driven by distance actually covered on screen (no foot sliding). */
  phase: number;
  lastX: number;
  lastZ: number;
}

const BLEND_TIME = 0.28;
const _root = new Matrix4();
const _pelvis = new Matrix4();
const _m = new Matrix4();
const _m2 = new Matrix4();
const _t = new Matrix4();
const _armR = new Matrix4();
const _handR = new Matrix4();
const _handL = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _s = new Vector3(1, 1, 1);
const _c = new Color();
const GREY = new Color(0x9a9a9a);
const WHITE = 0xffffff;

type Part = { mesh: InstancedMesh; per: number };

/**
 * Draws every villager with instanced parts regardless of population: a two-segment rig
 * (thighs, shins, boots, sleeves, forearms) with garment, face, hair, headwear, accessory and
 * tool variants, posed per frame from the agent's state.
 */
export class HumanView {
  readonly group = new Group();
  private readonly states = new Map<number, RenderState>();
  private cap = 0;
  private readonly parts = new Map<string, Part>();
  private readonly geos = new Map<string, BufferGeometry>();
  private readonly mat = new MeshLambertMaterial({ vertexColors: true });
  /** Which civs' leader to crown: civId -> leader id. */
  leaders = new Map<number, number>();
  bannerOf: (civId: number) => number = () => 0xd9a441;

  constructor(private readonly terrain: Terrain) {
    const g = this.geos;
    g.set('thigh', thighGeometry());
    g.set('shin', shinGeometry());
    g.set('boot', bootGeometry());
    g.set('upper', upperArmGeometry());
    g.set('fore', forearmGeometry());
    g.set('skirt', robeSkirtGeometry());
    g.set('beard', beardGeometry());
    g.set('mantle', mantleGeometry());
    for (let i = 0; i < 4; i++) {
      g.set(`garment${i}`, garmentGeometry(i));
      g.set(`trim${i}`, garmentTrimGeometry(i));
      g.set(`head${i}`, headGeometry(i));
    }
    for (let i = 0; i < 7; i++) g.set(`hair${i}`, hairGeometry(i));
    for (let i = 1; i <= 7; i++) g.set(`hat${i}`, headwearGeometry(i));
    for (let i = 1; i <= 3; i++) g.set(`acc${i}`, accessoryGeometry(i));
    g.set('axe', axeGeometry());
    g.set('hammer', hammerGeometry());
    g.set('pick', pickGeometry());
    g.set('basket', basketGeometry());
    g.set('staff', staffGeometry());
    g.set('logs', logBundleGeometry());
    g.set('stone', stoneLoadGeometry());
    g.set('crystal', crystalLoadGeometry());
    g.set('pack', packGeometry());
    this.allocate(48);
  }

  private static readonly PER: Record<string, number> = { thigh: 2, shin: 2, boot: 2, upper: 2, fore: 2 };

  private allocate(cap: number): void {
    for (const p of this.parts.values()) {
      this.group.remove(p.mesh);
      p.mesh.dispose();
    }
    this.parts.clear();
    this.cap = cap;
    for (const [name, geo] of this.geos) {
      const per = HumanView.PER[name] ?? 1;
      const m = new InstancedMesh(geo, this.mat, cap * per);
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.castShadow = !['acc3', 'hat6', 'beard'].includes(name);
      m.receiveShadow = false;
      m.frustumCulled = false;
      m.name = `h-${name}`;
      m.count = 0;
      this.group.add(m);
      this.parts.set(name, { mesh: m, per });
    }
  }

  positionOf(id: number): Vector3 | null {
    const s = this.states.get(id);
    return s && s.visible ? s.pos : null;
  }

  isVisible(id: number): boolean {
    return this.states.get(id)?.visible ?? false;
  }

  /** Per-frame cursors into each part's instance list. */
  private readonly cursor = new Map<string, number>();

  private put(name: string, m: Matrix4, hex: number, dead: boolean): void {
    const p = this.parts.get(name)!;
    const i = this.cursor.get(name) ?? 0;
    this.cursor.set(name, i + 1);
    p.mesh.setMatrixAt(i, m);
    _c.setHex(hex);
    if (dead) _c.lerp(GREY, 0.55).multiplyScalar(0.8);
    p.mesh.setColorAt(i, _c);
  }

  update(agents: readonly Agent[], alpha: number, dt: number, paused: boolean): void {
    if (agents.length > this.cap) this.allocate(Math.max(agents.length, this.cap * 2));
    this.cursor.clear();
    for (const a of agents) {
      let st = this.states.get(a.id);
      if (!st) {
        st = { pose: newPose(), from: newPose(), target: newPose(), blend: 1, anim: a.anim, seed: hash01(a.id, 77), pos: new Vector3(a.x, 0, a.z), heading: a.heading, visible: true, phase: hash01(a.id, 5) * 6, lastX: a.x, lastZ: a.z };
        this.states.set(a.id, st);
      }
      const hidden = a.inside !== null || a.buried || a.anim === 'hidden';
      st.visible = !hidden;
      if (hidden) continue;
      const x = a.prevX + (a.x - a.prevX) * alpha;
      const z = a.prevZ + (a.z - a.prevZ) * alpha;
      const jump = Math.hypot(x - st.pos.x, z - st.pos.z) > 3;
      const ground = this.terrain.heightAt(x, z);
      const water = this.terrain.waterLevelAt(x, z);
      const wading = water > ground + 0.1;
      st.pos.set(x, ground, z);
      st.heading = jump ? a.heading : lerpAngle(a.prevHeading, a.heading, alpha);
      // Advance the stride by distance covered: feet stay planted at any speed.
      const moved = jump ? 0 : Math.hypot(x - st.lastX, z - st.lastZ);
      st.lastX = x;
      st.lastZ = z;
      const scale = this.scaleOf(a);
      const run = a.speed > 2.9;
      const halfStride = (run ? 0.62 : 0.46) * scale;
      st.phase += (moved / halfStride) * Math.PI;
      if (st.anim !== a.anim) {
        copyPose(st.from, st.pose);
        st.anim = a.anim;
        st.blend = 0;
      }
      if (!paused) st.blend = Math.min(1, st.blend + dt / BLEND_TIME);
      const inv = a.inventory;
      const carry: Carry = inv.wood > 0 ? 'logs' : inv.stone > 0 ? 'stone' : inv.crystal > 0 ? 'crystal' : a.brain.active?.goal === 'envoy' ? 'pack' : inv.berries + inv.fruit + inv.mushrooms > 2 ? 'basket' : 'none';
      computePose({ anim: a.anim, t: a.animTime, phase: st.phase, speed: a.speed, seed: st.seed, carry, wading, old: a.age > 52 }, st.target);
      blendPose(st.pose, st.from, st.target, smoothstep(0, 1, st.blend));
      this.writeAgent(a, st, scale, carry);
    }
    for (const [name, p] of this.parts) {
      p.mesh.count = this.cursor.get(name) ?? 0;
      p.mesh.instanceMatrix.needsUpdate = true;
      if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    }
  }

  private scaleOf(a: Agent): number {
    const grown = Math.min(1, a.age / 15);
    return a.look.height * (0.5 + grown * 0.5) * 1.12;
  }

  private writeAgent(a: Agent, st: RenderState, scale: number, carry: Carry): void {
    const p = st.pose;
    const L = a.look;
    const grown = Math.min(1, a.age / 15);
    const headBoost = 1 + (1 - grown) * 0.35;
    const dead = !a.alive;
    const old = a.age > 52;
    const hairCol = old ? _c.setHex(L.hair).lerp(GREY, 0.6).getHex() : L.hair;

    _q.setFromEuler(_e.set(0, st.heading, 0));
    _root.compose(st.pos, _q, _s.set(scale * L.build, scale, scale * L.build));
    if (p.lie > 0.001) {
      _t.makeTranslation(0, 0.16 * p.lie, 0.42 * p.lie);
      _root.multiply(_t);
      _q.setFromEuler(_e.set((-Math.PI / 2) * p.lie, 0, p.lieRoll * p.lie));
      _root.multiply(_t.makeRotationFromQuaternion(_q));
      _root.multiply(_t.makeTranslation(0, -0.4 * p.lie, 0));
    }
    _s.set(1, 1, 1);
    const hipY = p.hipY + p.bob;
    _pelvis.copy(_root).multiply(_t.makeTranslation(0, hipY, 0));
    _q.setFromEuler(_e.set(p.torsoPitch, p.torsoYaw, p.torsoRoll, 'YXZ'));
    _pelvis.multiply(_t.makeRotationFromQuaternion(_q));

    const g = Math.min(3, L.garment);
    this.put(`garment${g}`, _pelvis, L.shirt, dead);
    this.put(`trim${g}`, _pelvis, L.trim, dead);
    if (L.accessory > 0) this.put(`acc${L.accessory}`, _pelvis, L.accessory === 2 ? L.trim : WHITE, dead);
    const leader = this.leaders.get(a.civId) === a.id && a.alive;
    if (leader) this.put('mantle', _pelvis, this.bannerOf(a.civId), dead);

    // Head.
    _m.copy(_pelvis).multiply(_t.makeTranslation(0, BODY.neckY, 0));
    _q.setFromEuler(_e.set(p.headPitch, p.headYaw, p.headRoll, 'YXZ'));
    _m.multiply(_t.makeRotationFromQuaternion(_q));
    if (headBoost > 1.001) _m.multiply(_t.makeScale(headBoost, headBoost, headBoost));
    this.put(`head${L.face % 4}`, _m, L.skin, dead);
    const hat = leader ? 7 : L.headwear;
    if (hat !== 1) this.put(`hair${L.hairStyle % 7}`, _m, hairCol, dead);
    if (L.beard && grown >= 1) this.put('beard', _m, hairCol, dead);
    if (hat > 0 && grown >= 0.6) this.put(`hat${hat}`, _m, hat === 1 ? L.shirt : hat === 2 || hat === 3 || hat === 4 ? L.trim : WHITE, dead);

    // Arms: shoulder -> elbow -> hand. Left is +x (character faces +z).
    const arm = (side: 1 | -1, pitch: number, roll: number, bend: number, handOut: Matrix4) => {
      _m.copy(_pelvis).multiply(_t.makeTranslation(side * BODY.shoulderX, BODY.shoulderY, 0));
      _q.setFromEuler(_e.set(pitch, 0, side * roll, 'ZXY'));
      _m.multiply(_t.makeRotationFromQuaternion(_q));
      this.put('upper', _m, L.shirt, dead);
      _m2.copy(_m).multiply(_t.makeTranslation(0, -BODY.upperArm, 0));
      _m2.multiply(_t.makeRotationX(-bend));
      this.put('fore', _m2, L.skin, dead);
      handOut.copy(_m2).multiply(_t.makeTranslation(0, -BODY.forearm - 0.02, 0.01));
    };
    arm(1, p.armLPitch, p.armLRoll, p.armLBend, _handL);
    arm(-1, p.armRPitch, p.armRRoll, p.armRBend, _handR);
    _armR.copy(_handR);

    // Legs: hip -> knee -> ankle, from the root (not affected by torso lean).
    const leg = (side: 1 | -1, pitch: number, bend: number, foot: number) => {
      _m.copy(_root).multiply(_t.makeTranslation(side * (BODY.hipX + p.legSpread * 0.5), hipY, 0));
      _q.setFromEuler(_e.set(pitch, 0, side * p.legSpread));
      _m.multiply(_t.makeRotationFromQuaternion(_q));
      this.put('thigh', _m, L.pants, dead);
      _m2.copy(_m).multiply(_t.makeTranslation(0, -BODY.thigh, 0)).multiply(_t.makeRotationX(bend));
      this.put('shin', _m2, L.pants, dead);
      _m2.multiply(_t.makeTranslation(0, -BODY.shin, 0)).multiply(_t.makeRotationX(-pitch - bend + foot));
      this.put('boot', _m2, 0x5a4030, dead);
    };
    leg(1, p.legLPitch, p.legLBend, p.footL);
    leg(-1, p.legRPitch, p.legRBend, p.footR);
    if (g === 1) {
      // The robe skirt follows the legs.
      _m.copy(_root).multiply(_t.makeTranslation(0, hipY, 0));
      _m.multiply(_t.makeRotationX(((p.legLPitch + p.legRPitch) / 2) * 0.75));
      this.put('skirt', _m, L.shirt, dead);
    }

    // Tools and loads.
    const grip = (hand: Matrix4) => _m.copy(hand).multiply(_t.makeRotationX(-0.25));
    const anim = a.anim;
    if (anim === 'chop') this.put('axe', grip(_armR), WHITE, dead);
    else if (anim === 'mine') this.put('pick', grip(_armR), WHITE, dead);
    else if (anim === 'build') this.put('hammer', grip(_armR), WHITE, dead);
    else if ((anim === 'walk' || anim === 'look') && a.brain.active?.key.startsWith('expedition') && carry !== 'logs') this.put('staff', _m.copy(_armR).multiply(_t.makeRotationX(0.1)), WHITE, dead);
    if (a.alive && (carry === 'basket' || anim === 'gather')) this.put('basket', _handL, WHITE, dead);
    if (a.alive && carry === 'logs') this.put('logs', _pelvis, WHITE, dead);
    else if (a.alive && carry === 'stone') this.put('stone', _pelvis, WHITE, dead);
    else if (a.alive && carry === 'crystal') this.put('crystal', _pelvis, WHITE, dead);
    else if (a.alive && carry === 'pack') this.put('pack', _pelvis, WHITE, dead);
  }
}
