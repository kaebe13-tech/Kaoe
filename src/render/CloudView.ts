import { Color, Group, IcosahedronGeometry, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Vector3 } from 'three';
import { Rng } from '../core/rng';

interface Cloud {
  x: number;
  y: number;
  z: number;
  speed: number;
  puffs: Array<{ dx: number; dy: number; dz: number; s: number }>;
}

/** Soft stylized cumulus puffs drifting slowly across the sky. */
export class CloudView {
  readonly group = new Group();
  private readonly mesh: InstancedMesh;
  private readonly clouds: Cloud[] = [];
  private readonly material: MeshLambertMaterial;
  private readonly range = 420;

  constructor(seed: number) {
    const rng = new Rng(seed ^ 0xc10d);
    let puffCount = 0;
    for (let i = 0; i < 22; i++) {
      const puffs: Cloud['puffs'] = [];
      const n = rng.int(4, 8);
      const len = rng.range(10, 22);
      for (let k = 0; k < n; k++) {
        const t = k / (n - 1) - 0.5;
        puffs.push({
          dx: t * len + rng.range(-2, 2),
          dy: (0.5 - Math.abs(t)) * rng.range(2, 5),
          dz: rng.range(-3, 3),
          s: rng.range(3.2, 6.5) * (1 - Math.abs(t) * 0.6),
        });
      }
      puffCount += n;
      this.clouds.push({
        x: rng.range(-this.range, this.range),
        y: rng.range(62, 95),
        z: rng.range(-this.range, this.range),
        speed: rng.range(0.6, 1.2),
        puffs,
      });
    }
    this.material = new MeshLambertMaterial({ color: 0xffffff, emissive: 0x9aa4b4, emissiveIntensity: 0.55, flatShading: true, transparent: true, opacity: 0.94 });
    const geo = new IcosahedronGeometry(1, 1);
    geo.scale(1, 0.62, 1);
    this.mesh = new InstancedMesh(geo, this.material, puffCount);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.name = 'clouds';
    this.group.add(this.mesh);
  }

  update(dt: number, tint: Color, darkness: number, overcast: number): void {
    const m = new Matrix4();
    const q = new Quaternion();
    const p = new Vector3();
    const s = new Vector3();
    let i = 0;
    for (const c of this.clouds) {
      c.x += c.speed * dt * 1.4;
      if (c.x > this.range) c.x -= this.range * 2;
      for (const pf of c.puffs) {
        p.set(c.x + pf.dx, c.y + pf.dy, c.z + pf.dz);
        s.setScalar(pf.s * (1 + overcast * 0.35));
        m.compose(p, q, s);
        this.mesh.setMatrixAt(i++, m);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.material.emissive.copy(tint).multiplyScalar(0.55 * (1 - darkness * 0.8));
    this.material.color.setRGB(1, 1, 1).lerp(new Color(0x5a6470), overcast * 0.8);
  }
}
