import {
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { lerpAngle, smoothstep } from '../core/math';
import { hash01 } from '../core/rng';
import type { Agent } from '../agents/Agent';
import type { Terrain } from '../world/Terrain';
import { BODY, armGeometry, axeGeometry, hairGeometry, hammerGeometry, handFoodGeometry, headGeometry, legGeometry, logBundleGeometry, pouchGeometry, torsoGeometry } from './humanGeometry';
import { blendPose, computePose, copyPose, newPose, type Pose } from './poses';

interface RenderState {
  pose: Pose;
  from: Pose;
  target: Pose;
  blend: number;
  anim: string;
  seed: number;
  /** Smoothed world position used for rendering (also exposed for labels/picking). */
  pos: Vector3;
  heading: number;
  visible: boolean;
}

const BLEND_TIME = 0.28;
const ZERO = new Matrix4().makeScale(0, 0, 0);
const _root = new Matrix4();
const _pelvis = new Matrix4();
const _m = new Matrix4();
const _t = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _v = new Vector3();
const _s = new Vector3(1, 1, 1);
const _c = new Color();
const GREY = new Color(0x9a9a9a);

/**
 * Draws every human with ~12 instanced meshes regardless of population: a tiny procedural
 * rig (pelvis, torso, head, arms, legs + props) posed per frame from the agent's state.
 */
export class HumanView {
  readonly group = new Group();
  private readonly states = new Map<number, RenderState>();
  private cap = 0;
  private torso!: InstancedMesh;
  private head!: InstancedMesh;
  private hair: InstancedMesh[] = [];
  private arms!: InstancedMesh;
  private legs!: InstancedMesh;
  private axe!: InstancedMesh;
  private hammer!: InstancedMesh;
  private logs!: InstancedMesh;
  private pouch!: InstancedMesh;
  private food!: InstancedMesh;
  private readonly geos: Record<string, BufferGeometry>;
  private readonly mat = new MeshLambertMaterial({ vertexColors: true });

  constructor(private readonly terrain: Terrain) {
    this.geos = {
      torso: torsoGeometry(),
      head: headGeometry(),
      arm: armGeometry(),
      leg: legGeometry(),
      axe: axeGeometry(),
      hammer: hammerGeometry(),
      logs: logBundleGeometry(),
      pouch: pouchGeometry(),
      food: handFoodGeometry(),
    };
    for (let i = 0; i < 5; i++) this.geos[`hair${i}`] = hairGeometry(i);
    this.allocate(32);
  }

  private allocate(cap: number): void {
    for (const m of this.meshes()) {
      this.group.remove(m);
      m.dispose();
    }
    this.cap = cap;
    const mk = (geo: BufferGeometry, n: number, name: string, shadow = true) => {
      const m = new InstancedMesh(geo, this.mat, n);
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.castShadow = shadow;
      m.receiveShadow = false;
      m.frustumCulled = false;
      m.name = name;
      for (let i = 0; i < n; i++) m.setMatrixAt(i, ZERO);
      this.group.add(m);
      return m;
    };
    this.torso = mk(this.geos.torso!, cap, 'h-torso');
    this.head = mk(this.geos.head!, cap, 'h-head');
    this.hair = [0, 1, 2, 3, 4].map((i) => mk(this.geos[`hair${i}`]!, cap, `h-hair${i}`));
    this.arms = mk(this.geos.arm!, cap * 2, 'h-arms');
    this.legs = mk(this.geos.leg!, cap * 2, 'h-legs');
    this.axe = mk(this.geos.axe!, cap, 'h-axe');
    this.hammer = mk(this.geos.hammer!, cap, 'h-hammer');
    this.logs = mk(this.geos.logs!, cap, 'h-logs');
    this.pouch = mk(this.geos.pouch!, cap, 'h-pouch', false);
    this.food = mk(this.geos.food!, cap, 'h-food', false);
    // Colours are (re)assigned in update().
  }

  private meshes(): InstancedMesh[] {
    if (!this.torso) return [];
    return [this.torso, this.head, ...this.hair, this.arms, this.legs, this.axe, this.hammer, this.logs, this.pouch, this.food];
  }

  /** Smoothed render position of an agent (for labels, picking, camera follow). */
  positionOf(id: number): Vector3 | null {
    const s = this.states.get(id);
    return s && s.visible ? s.pos : null;
  }

  isVisible(id: number): boolean {
    return this.states.get(id)?.visible ?? false;
  }

  /**
   * @param alpha interpolation factor between the previous and current simulation step
   * @param dt real frame time (for pose blending)
   */
  update(agents: readonly Agent[], alpha: number, dt: number, paused: boolean): void {
    if (agents.length > this.cap) this.allocate(Math.max(agents.length, this.cap * 2));
    const n = agents.length;
    for (let i = 0; i < n; i++) {
      const a = agents[i]!;
      let st = this.states.get(a.id);
      if (!st) {
        st = {
          pose: newPose(),
          from: newPose(),
          target: newPose(),
          blend: 1,
          anim: a.anim,
          seed: hash01(a.id, 77),
          pos: new Vector3(a.x, 0, a.z),
          heading: a.heading,
          visible: true,
        };
        this.states.set(a.id, st);
      }
      const hidden = a.inside !== null || a.buried || a.anim === 'hidden';
      st.visible = !hidden;
      if (hidden) {
        this.hide(i);
        continue;
      }
      // Interpolate between simulation steps for smooth motion at any speed.
      const x = a.prevX + (a.x - a.prevX) * alpha;
      const z = a.prevZ + (a.z - a.prevZ) * alpha;
      const jump = Math.hypot(x - st.pos.x, z - st.pos.z) > 3;
      st.pos.set(x, this.terrain.heightAt(x, z), z);
      st.heading = jump ? a.heading : lerpAngle(a.prevHeading, a.heading, alpha);

      if (st.anim !== a.anim) {
        copyPose(st.from, st.pose);
        st.anim = a.anim;
        st.blend = 0;
      }
      if (!paused) st.blend = Math.min(1, st.blend + dt / BLEND_TIME);
      computePose(
        {
          anim: a.anim,
          t: a.animTime,
          phase: a.walkPhase,
          speed: a.speed,
          seed: st.seed,
          carryingWood: a.inventory.wood > 0,
        },
        st.target,
      );
      blendPose(st.pose, st.from, st.target, smoothstep(0, 1, st.blend));
      this.writeAgent(i, a, st);
    }
    for (let i = n; i < this.cap; i++) this.hide(i);
    for (const m of this.meshes()) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  private hide(i: number): void {
    this.torso.setMatrixAt(i, ZERO);
    this.head.setMatrixAt(i, ZERO);
    for (const h of this.hair) h.setMatrixAt(i, ZERO);
    this.arms.setMatrixAt(i * 2, ZERO);
    this.arms.setMatrixAt(i * 2 + 1, ZERO);
    this.legs.setMatrixAt(i * 2, ZERO);
    this.legs.setMatrixAt(i * 2 + 1, ZERO);
    this.axe.setMatrixAt(i, ZERO);
    this.hammer.setMatrixAt(i, ZERO);
    this.logs.setMatrixAt(i, ZERO);
    this.pouch.setMatrixAt(i, ZERO);
    this.food.setMatrixAt(i, ZERO);
  }

  private writeAgent(i: number, a: Agent, st: RenderState): void {
    const p = st.pose;
    const L = a.look;
    const scale = L.height * (a.age < 14 ? 0.6 + a.age * 0.028 : 1);
    const dead = !a.alive;

    // Root: feet on the ground, facing the heading; optionally lying down.
    _q.setFromEuler(_e.set(0, st.heading, 0));
    _root.compose(st.pos, _q, _s.set(scale * L.build, scale, scale * L.build));
    if (p.lie > 0.001) {
      _t.makeTranslation(0, 0.14 * p.lie, 0.38 * p.lie);
      _root.multiply(_t);
      _q.setFromEuler(_e.set(-Math.PI / 2 * p.lie, 0, p.lieRoll * p.lie));
      _t.makeRotationFromQuaternion(_q);
      _root.multiply(_t);
      _t.makeTranslation(0, -0.35 * p.lie, 0);
      _root.multiply(_t);
    }
    _s.set(1, 1, 1);

    // Pelvis frame (torso, head and arms hang off this).
    const hipY = p.hipY + p.bob;
    _pelvis.copy(_root);
    _t.makeTranslation(0, hipY, 0);
    _pelvis.multiply(_t);
    _q.setFromEuler(_e.set(p.torsoPitch, p.torsoYaw, p.torsoRoll, 'YXZ'));
    _t.makeRotationFromQuaternion(_q);
    _pelvis.multiply(_t);

    this.torso.setMatrixAt(i, _pelvis);
    this.tint(this.torso, i, L.shirt, dead);

    // Head.
    _m.copy(_pelvis);
    _t.makeTranslation(0, BODY.neckY, 0);
    _m.multiply(_t);
    _q.setFromEuler(_e.set(p.headPitch, p.headYaw, 0, 'YXZ'));
    _t.makeRotationFromQuaternion(_q);
    _m.multiply(_t);
    this.head.setMatrixAt(i, _m);
    this.tint(this.head, i, L.skin, dead);
    for (let h = 0; h < this.hair.length; h++) {
      if (h === L.hairStyle) {
        this.hair[h]!.setMatrixAt(i, _m);
        this.tint(this.hair[h]!, i, L.hair, dead);
      } else this.hair[h]!.setMatrixAt(i, ZERO);
    }

    // Arms: pivot at the shoulders. Left is +x (character faces +z).
    const armMat = (side: 1 | -1, pitch: number, roll: number, out: Matrix4) => {
      out.copy(_pelvis);
      _t.makeTranslation(side * BODY.shoulderX, BODY.shoulderY, 0);
      out.multiply(_t);
      _q.setFromEuler(_e.set(pitch, 0, side * roll, 'ZXY'));
      _t.makeRotationFromQuaternion(_q);
      out.multiply(_t);
      return out;
    };
    armMat(1, p.armLPitch, p.armLRoll, _m);
    this.arms.setMatrixAt(i * 2, _m);
    this.tint(this.arms, i * 2, L.skin, dead);
    const armR = armMat(-1, p.armRPitch, p.armRRoll, new Matrix4());
    this.arms.setMatrixAt(i * 2 + 1, armR);
    this.tint(this.arms, i * 2 + 1, L.skin, dead);

    // Legs hang from the hips (not affected by torso lean).
    const legMat = (side: 1 | -1, pitch: number) => {
      _m.copy(_root);
      _t.makeTranslation(side * (BODY.hipX + p.legSpread * 0.5), hipY, 0);
      _m.multiply(_t);
      _q.setFromEuler(_e.set(pitch, 0, side * p.legSpread));
      _t.makeRotationFromQuaternion(_q);
      _m.multiply(_t);
      return _m;
    };
    this.legs.setMatrixAt(i * 2, legMat(1, p.legLPitch));
    this.tint(this.legs, i * 2, L.pants, dead);
    this.legs.setMatrixAt(i * 2 + 1, legMat(-1, p.legRPitch));
    this.tint(this.legs, i * 2 + 1, L.pants, dead);

    // Props.
    const handGrip = (out: Matrix4) => {
      out.copy(armR);
      _t.makeTranslation(0, -BODY.armLen + 0.03, 0.01);
      out.multiply(_t);
      _q.setFromEuler(_e.set(-0.25, 0, 0));
      _t.makeRotationFromQuaternion(_q);
      out.multiply(_t);
      return out;
    };
    this.axe.setMatrixAt(i, a.anim === 'chop' ? handGrip(_m) : ZERO);
    this.hammer.setMatrixAt(i, a.anim === 'build' ? handGrip(_m) : ZERO);
    const eating = a.anim === 'eat';
    if (eating) {
      _m.copy(armR);
      this.food.setMatrixAt(i, _m);
    } else this.food.setMatrixAt(i, ZERO);
    const wood = a.inventory.wood;
    if (wood > 0 && a.alive) {
      const k = wood >= 5 ? 1 : wood >= 3 ? 0.85 : 0.7;
      _m.copy(_pelvis);
      _t.makeScale(k, k, k);
      _m.multiply(_t);
      this.logs.setMatrixAt(i, _m);
    } else this.logs.setMatrixAt(i, ZERO);
    const food = a.inventory.berries + a.inventory.fruit;
    this.pouch.setMatrixAt(i, food > 0 && a.alive ? _pelvis : ZERO);
    void _v;
  }

  private tint(mesh: InstancedMesh, i: number, hex: number, dead: boolean): void {
    _c.setHex(hex);
    if (dead) _c.lerp(GREY, 0.55).multiplyScalar(0.8);
    mesh.setColorAt(i, _c);
  }
}
