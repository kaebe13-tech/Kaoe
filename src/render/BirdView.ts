import { BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, Group, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Vector3, Euler } from 'three';
import { Rng } from '../core/rng';
import { ISLAND_RADIUS } from '../world/config';

interface Bird {
  cx: number;
  cz: number;
  r: number;
  y: number;
  speed: number;
  phase: number;
  flap: number;
}

/** A few gull flocks lazily circling the coast; wings flap and glide. */
export class BirdView {
  readonly group = new Group();
  private readonly mesh: InstancedMesh;
  private readonly birds: Bird[] = [];
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly e = new Euler();
  private readonly p = new Vector3();
  private readonly s = new Vector3(1, 1, 1);
  private readonly wing: InstancedMesh;

  constructor(seed: number) {
    const rng = new Rng(seed ^ 0xb1d5);
    const flocks = 4;
    for (let f = 0; f < flocks; f++) {
      const a = rng.range(0, Math.PI * 2);
      const d = ISLAND_RADIUS * rng.range(0.7, 1.15);
      const cx = Math.cos(a) * d;
      const cz = Math.sin(a) * d;
      const n = rng.int(3, 6);
      for (let i = 0; i < n; i++) {
        this.birds.push({ cx: cx + rng.range(-6, 6), cz: cz + rng.range(-6, 6), r: rng.range(10, 22), y: rng.range(14, 26), speed: rng.range(0.12, 0.22) * (rng.chance(0.5) ? 1 : -1), phase: rng.range(0, Math.PI * 2), flap: rng.range(0, 10) });
      }
    }
    // Body: small spindle; wings: a separate flat pair so they can flap.
    const body = new BufferGeometry();
    body.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0.35, -0.07, 0, -0.25, 0.07, 0, -0.25, 0, 0.06, -0.1]), 3));
    body.setIndex([0, 1, 3, 0, 3, 2, 1, 2, 3]);
    body.computeVertexNormals();
    const mat = new MeshLambertMaterial({ color: 0xf4f4ee, side: DoubleSide });
    this.mesh = new InstancedMesh(body, mat, this.birds.length);
    const wing = new BufferGeometry();
    wing.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0.12, 0.55, 0.02, -0.02, 0, 0, -0.12]), 3));
    wing.setIndex([0, 1, 2]);
    wing.computeVertexNormals();
    this.wing = new InstancedMesh(wing, mat, this.birds.length * 2);
    for (const im of [this.mesh, this.wing]) {
      im.instanceMatrix.setUsage(DynamicDrawUsage);
      im.frustumCulled = false;
      this.group.add(im);
    }
  }

  update(time: number, darkness: number): void {
    this.group.visible = darkness < 0.8;
    if (!this.group.visible) return;
    const wm = this.wm;
    this.birds.forEach((b, i) => {
      const t = time * b.speed + b.phase;
      const x = b.cx + Math.cos(t) * b.r;
      const z = b.cz + Math.sin(t) * b.r;
      const y = b.y + Math.sin(time * 0.4 + b.phase) * 1.5;
      // Heading tangent to the circle; bank into the turn.
      const heading = Math.atan2(-Math.sin(t) * Math.sign(b.speed), Math.cos(t) * Math.sign(b.speed));
      this.q.setFromEuler(this.e.set(0, heading, -0.35 * Math.sign(b.speed), 'YXZ'));
      this.p.set(x, y, z);
      this.m.compose(this.p, this.q, this.s.setScalar(1.3));
      this.mesh.setMatrixAt(i, this.m);
      // Flap in bursts, glide in between.
      const cycle = (time * 0.5 + b.flap) % 4;
      const flap = cycle < 1.6 ? Math.sin(time * 9 + b.flap) * 0.55 : 0.12;
      for (const side of [1, -1]) {
        this.wq.setFromEuler(this.e.set(0, 0, side * flap));
        wm.compose(this.zero, this.wq, this.ws.set(side, 1, 1));
        this.tmp.multiplyMatrices(this.m, wm);
        this.wing.setMatrixAt(i * 2 + (side === 1 ? 0 : 1), this.tmp);
      }
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.wing.instanceMatrix.needsUpdate = true;
  }

  private readonly wm = new Matrix4();
  private readonly wq = new Quaternion();
  private readonly ws = new Vector3();
  private readonly zero = new Vector3();
  private readonly tmp = new Matrix4();
}
