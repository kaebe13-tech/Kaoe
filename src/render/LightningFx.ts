import { AdditiveBlending, BufferAttribute, BufferGeometry, Camera, Group, Mesh, MeshBasicMaterial, PointLight, Vector3 } from 'three';

interface Bolt {
  core: Mesh;
  glow: Mesh;
  age: number;
  light: PointLight;
}

/** Jagged, branching bolts with a blinding flash and a brief light at the impact. */
export class LightningFx {
  readonly group = new Group();
  private readonly bolts: Bolt[] = [];
  private readonly coreMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: AdditiveBlending, depthWrite: false });
  private readonly glowMat = new MeshBasicMaterial({ color: 0x9fc4ff, transparent: true, opacity: 0.45, blending: AdditiveBlending, depthWrite: false });

  strike(target: Vector3, camera: Camera): void {
    const pts = boltPoints(target);
    const core = new Mesh(ribbon(pts, 0.28, camera), this.coreMat.clone());
    const glow = new Mesh(ribbon(pts, 2.2, camera), this.glowMat.clone());
    core.frustumCulled = glow.frustumCulled = false;
    core.renderOrder = glow.renderOrder = 20;
    const light = new PointLight(0xdfe8ff, 900, 90, 1.6);
    light.position.set(target.x, target.y + 8, target.z);
    this.group.add(core, glow, light);
    this.bolts.push({ core, glow, age: 0, light });
  }

  update(dt: number): void {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i]!;
      b.age += dt;
      const t = b.age;
      // Flicker: on, off, on, then fade.
      const on = t < 0.07 || (t > 0.11 && t < 0.2) || (t > 0.24 && t < 0.5);
      const fade = t < 0.24 ? 1 : Math.max(0, 1 - (t - 0.24) / 0.26);
      (b.core.material as MeshBasicMaterial).opacity = on ? fade : 0;
      (b.glow.material as MeshBasicMaterial).opacity = on ? 0.45 * fade : 0;
      b.light.intensity = on ? 900 * fade : 0;
      if (t > 0.55) {
        this.group.remove(b.core, b.glow, b.light);
        b.core.geometry.dispose();
        b.glow.geometry.dispose();
        (b.core.material as MeshBasicMaterial).dispose();
        (b.glow.material as MeshBasicMaterial).dispose();
        b.light.dispose();
        this.bolts.splice(i, 1);
      }
    }
  }
}

function boltPoints(target: Vector3): Vector3[][] {
  const main: Vector3[] = [];
  const top = new Vector3(target.x + (Math.random() - 0.5) * 18, target.y + 95, target.z + (Math.random() - 0.5) * 18);
  const n = 22;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = top.clone().lerp(target, t);
    const j = (1 - t) * 3.2 + 0.4;
    if (i > 0 && i < n) p.add(new Vector3((Math.random() - 0.5) * j, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * j));
    main.push(p);
  }
  const all = [main];
  for (let b = 0; b < 3; b++) {
    const start = 3 + Math.floor(Math.random() * 12);
    const from = main[start]!.clone();
    const branch = [from];
    const dir = new Vector3((Math.random() - 0.5) * 2, -1.6, (Math.random() - 0.5) * 2).normalize();
    const len = 4 + Math.random() * 6;
    for (let k = 1; k <= 6; k++) {
      const p = from.clone().addScaledVector(dir, (len * k) / 6).add(new Vector3((Math.random() - 0.5) * 1.2, 0, (Math.random() - 0.5) * 1.2));
      branch.push(p);
    }
    all.push(branch);
  }
  return all;
}

/** Camera-facing strip along each polyline. */
function ribbon(lines: Vector3[][], width: number, camera: Camera): BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const camPos = camera.position;
  let base = 0;
  lines.forEach((pts, li) => {
    const w = li === 0 ? width : width * 0.55;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const next = pts[Math.min(i + 1, pts.length - 1)]!;
      const prev = pts[Math.max(i - 1, 0)]!;
      const dir = next.clone().sub(prev).normalize();
      const toCam = camPos.clone().sub(p).normalize();
      const side = dir.cross(toCam).normalize().multiplyScalar(w * 0.5 * (1 - (i / pts.length) * (li === 0 ? 0.3 : 0.8)));
      pos.push(p.x + side.x, p.y + side.y, p.z + side.z, p.x - side.x, p.y - side.y, p.z - side.z);
      if (i < pts.length - 1) {
        const a = base + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    base += pts.length * 2;
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  return g;
}
