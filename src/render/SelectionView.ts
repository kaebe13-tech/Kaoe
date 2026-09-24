import { CircleGeometry, Color, DynamicDrawUsage, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Quaternion, RingGeometry, Vector3 } from 'three';
import type { Agent } from '../agents/Agent';
import type { Terrain } from '../world/Terrain';

const MAX_DOTS = 200;
const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _n = { x: 0, y: 1, z: 0 };
const UP = new Vector3(0, 1, 0);
const _nv = new Vector3();

/** Rings under the selected/hovered human and a flowing dotted trail to where they're headed. */
export class SelectionView {
  readonly group = new Group();
  private readonly sel: Mesh;
  private readonly hover: Mesh;
  private readonly target: Mesh;
  private readonly dots: InstancedMesh;

  constructor(private readonly terrain: Terrain) {
    const ringGeo = new RingGeometry(0.52, 0.68, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.sel = new Mesh(ringGeo, new MeshBasicMaterial({ color: 0xffd35c, transparent: true, opacity: 0.95, depthWrite: false }));
    this.hover = new Mesh(ringGeo, new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false }));
    const tg = new RingGeometry(0.28, 0.42, 4);
    tg.rotateX(-Math.PI / 2);
    this.target = new Mesh(tg, new MeshBasicMaterial({ color: 0xffd35c, transparent: true, opacity: 0.9, depthWrite: false }));
    const dotGeo = new CircleGeometry(0.075, 8);
    dotGeo.rotateX(-Math.PI / 2);
    this.dots = new InstancedMesh(dotGeo, new MeshBasicMaterial({ color: new Color(0xffe18a), transparent: true, opacity: 0.8, depthWrite: false }), MAX_DOTS);
    this.dots.instanceMatrix.setUsage(DynamicDrawUsage);
    this.dots.frustumCulled = false;
    for (const m of [this.sel, this.hover, this.target]) {
      m.renderOrder = 6;
      m.visible = false;
      this.group.add(m);
    }
    this.dots.renderOrder = 6;
    this.group.add(this.dots);
  }

  private placeOnGround(m: Mesh, x: number, z: number, lift: number, scale: number, spin = 0): void {
    this.terrain.normalAt(x, z, _n);
    _nv.set(_n.x, _n.y, _n.z);
    m.position.set(x, this.terrain.heightAt(x, z) + lift, z);
    m.quaternion.setFromUnitVectors(UP, _nv);
    if (spin) m.quaternion.multiply(_q.setFromAxisAngle(UP, spin));
    m.scale.setScalar(scale);
  }

  update(time: number, selected: Agent | null, selPos: Vector3 | null, hovered: Agent | null, hovPos: Vector3 | null): void {
    this.sel.visible = !!selected && !!selPos;
    if (selected && selPos) this.placeOnGround(this.sel, selPos.x, selPos.z, 0.07, 1 + Math.sin(time * 3) * 0.05, time * 0.6);
    this.hover.visible = !!hovered && !!hovPos && hovered !== selected;
    if (hovered && hovPos && hovered !== selected) this.placeOnGround(this.hover, hovPos.x, hovPos.z, 0.06, 0.95);

    // Dotted trail along the remaining route, then on to the goal's target.
    let n = 0;
    this.target.visible = false;
    if (selected && selPos && selected.alive) {
      const pts: Array<{ x: number; z: number }> = [{ x: selPos.x, z: selPos.z }];
      const nav = selected.nav;
      if (nav.status === 'moving') for (let i = nav.idx; i < nav.path.length; i++) pts.push(nav.path[i]!);
      const tgt = selected.brain.active?.target;
      if (tgt) {
        const last = pts[pts.length - 1]!;
        if (Math.hypot(tgt.x - last.x, tgt.z - last.z) > 0.8) pts.push({ x: tgt.x, z: tgt.z });
        this.target.visible = Math.hypot(tgt.x - selPos.x, tgt.z - selPos.z) > 1.2;
        if (this.target.visible) this.placeOnGround(this.target, tgt.x, tgt.z, 0.09, 1 + Math.sin(time * 4) * 0.12, time * 1.5);
      }
      const spacing = 0.8;
      let carry = spacing - ((time * 1.4) % spacing);
      for (let i = 0; i < pts.length - 1 && n < MAX_DOTS; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        let d = carry;
        while (d < len && n < MAX_DOTS) {
          const t = d / len;
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          const fadeIn = Math.min(1, (n + 1) / 4);
          _p.set(x, this.terrain.heightAt(x, z) + 0.09, z);
          _s.setScalar(fadeIn);
          _m.compose(_p, _q.identity(), _s);
          this.dots.setMatrixAt(n++, _m);
          d += spacing;
        }
        carry = d - len;
      }
    }
    this.dots.count = n;
    this.dots.instanceMatrix.needsUpdate = true;
  }
}
