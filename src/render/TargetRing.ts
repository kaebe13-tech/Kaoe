import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshBasicMaterial } from 'three';
import type { Terrain } from '../world/Terrain';

const SEG = 96;

/**
 * The circle under the cursor while a god power is chosen: shows where it will land and how far
 * it reaches, draped over the ground.
 */
export class TargetRing {
  readonly group = new Group();
  private readonly ring: Mesh;
  private readonly dot: Mesh;
  private readonly pos: Float32Array;
  private readonly dotPos: Float32Array;
  private readonly mat: MeshBasicMaterial;
  private readonly dotMat: MeshBasicMaterial;
  private t = 0;

  constructor() {
    this.pos = new Float32Array((SEG + 1) * 2 * 3);
    const idx: number[] = [];
    for (let i = 0; i < SEG; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.pos, 3));
    g.setIndex(idx);
    this.mat = new MeshBasicMaterial({ color: 0xffe38a, transparent: true, opacity: 0.85, blending: AdditiveBlending, depthTest: false, depthWrite: false, fog: false });
    this.ring = new Mesh(g, this.mat);
    this.ring.renderOrder = 20;
    this.ring.frustumCulled = false;
    this.dotPos = new Float32Array((16 + 1) * 3);
    const di: number[] = [];
    for (let i = 1; i <= 16; i++) di.push(0, i, i === 16 ? 1 : i + 1);
    const dg = new BufferGeometry();
    dg.setAttribute('position', new BufferAttribute(this.dotPos, 3));
    dg.setIndex(di);
    this.dotMat = new MeshBasicMaterial({ color: 0xffe38a, transparent: true, opacity: 0.6, blending: AdditiveBlending, depthTest: false, depthWrite: false, fog: false });
    this.dot = new Mesh(dg, this.dotMat);
    this.dot.renderOrder = 20;
    this.dot.frustumCulled = false;
    this.group.add(this.ring, this.dot);
    this.group.visible = false;
  }

  hide(): void {
    this.group.visible = false;
  }

  /** Show the ring at a point with a radius (world units) in a colour. */
  show(terrain: Terrain, x: number, z: number, radius: number, color: string, camDist: number, dt: number): void {
    this.group.visible = true;
    this.t += dt;
    const c = new Color(color);
    this.mat.color.copy(c);
    this.dotMat.color.copy(c);
    const r = Math.max(radius, 0.8);
    const w = Math.max(0.12, camDist * 0.0045) * (1 + Math.sin(this.t * 5) * 0.12);
    const lift = 0.25 + camDist * 0.002;
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2 + this.t * 0.25;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (let k = 0; k < 2; k++) {
        const rr = k === 0 ? r - w : r + w;
        const px = x + ca * rr;
        const pz = z + sa * rr;
        const o = (i * 2 + k) * 3;
        this.pos[o] = px;
        this.pos[o + 1] = Math.max(terrain.heightAt(px, pz), 0) + lift;
        this.pos[o + 2] = pz;
      }
    }
    this.ring.geometry.getAttribute('position').needsUpdate = true;
    const dr = Math.max(0.25, camDist * 0.006);
    this.dotPos[0] = x;
    this.dotPos[1] = Math.max(terrain.heightAt(x, z), 0) + lift;
    this.dotPos[2] = z;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const px = x + Math.cos(a) * dr;
      const pz = z + Math.sin(a) * dr;
      this.dotPos[(i + 1) * 3] = px;
      this.dotPos[(i + 1) * 3 + 1] = Math.max(terrain.heightAt(px, pz), 0) + lift;
      this.dotPos[(i + 1) * 3 + 2] = pz;
    }
    this.dot.geometry.getAttribute('position').needsUpdate = true;
    this.mat.opacity = radius < 1 ? 0.5 : 0.85;
  }
}
