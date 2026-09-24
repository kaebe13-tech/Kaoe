import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OctahedronGeometry,
  ShaderMaterial,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three';
import { Rng } from '../core/rng';
import type { Terrain } from '../world/Terrain';
import type { Landmark } from '../world/biomes';
import { merge, prep } from './geometry';
import { elderTree, gradient, lumpy, place } from './flora';
import type { LightPool, LightSource } from './LightPool';

interface Animated {
  mesh: Mesh | Group;
  base: Vector3;
  phase: number;
  bob: number;
  spin: number;
}

/**
 * Rare wonders scattered across the world. Each is a hand-arranged composition of simple
 * shapes with a strong silhouette, so it reads from far away and rewards a closer look.
 */
export class LandmarkView {
  readonly group = new Group();
  private readonly stone = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private readonly glow = new MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.7, blending: AdditiveBlending, depthWrite: false });
  private readonly crystal = new MeshLambertMaterial({ vertexColors: true, emissive: 0x5a4fc0, emissiveIntensity: 0.6, flatShading: true });
  private readonly lava = new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; varying vec2 vP;
      vec2 h2(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
      float cells(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); float d1 = 8.0; float d2 = 8.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 g = vec2(float(x), float(y)); vec2 o = h2(i + g); o = 0.5 + 0.45 * sin(uTime * 0.25 + 6.2831 * o);
          float d = length(g + o - f); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
        return d2 - d1; }
      void main(){
        float c = cells(vP * 0.45);
        float crack = 1.0 - smoothstep(0.02, 0.16, c);
        float pulse = 0.8 + 0.2 * sin(uTime * 1.3 + vP.x * 0.3);
        vec3 crust = vec3(0.16, 0.07, 0.05);
        vec3 hot = mix(vec3(1.0, 0.32, 0.05), vec3(1.0, 0.75, 0.25), crack * crack);
        gl_FragColor = vec4(mix(crust, hot * pulse, crack), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  private readonly animated: Animated[] = [];
  private readonly glows: MeshBasicMaterial[] = [];
  private readonly lights: Array<LightSource & { base: number }> = [];

  constructor(
    private readonly terrain: Terrain,
    private readonly pool: LightPool,
  ) {
    for (const l of terrain.landmarks) {
      const g = this.build(l);
      if (!g) continue;
      const y = l.kind === 'volcano' ? 0 : this.groundY(l.x, l.z, 3);
      g.position.set(l.x, y, l.z);
      if (l.kind !== 'volcano') g.rotation.y = l.rot;
      g.name = `landmark-${l.kind}`;
      g.updateMatrixWorld(true);
      for (const src of (g.userData.lights as Array<LightSource & { base: number }>) ?? []) {
        src.position.applyMatrix4(g.matrixWorld);
        this.pool.add(src);
      }
      g.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh && m.material !== this.glow && !(m.material instanceof MeshBasicMaterial)) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      this.group.add(g);
    }
  }

  private groundY(x: number, z: number, r: number): number {
    let y = this.terrain.heightAt(x, z);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      y = Math.min(y, this.terrain.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r));
    }
    return y - 0.05;
  }

  private build(l: Landmark): Group | null {
    const rng = new Rng(l.id * 131 + 7);
    const g = new Group();
    const stoneGeo = (parts: BufferGeometry[]) => new Mesh(merge(parts), this.stone);
    switch (l.kind) {
      case 'greatTree': {
        const tree = new Mesh(elderTree(900 + l.id), new MeshLambertMaterial({ vertexColors: true }));
        tree.scale.setScalar(2.3);
        g.add(tree);
        // Lanterns of light hanging in the canopy.
        for (let i = 0; i < 14; i++) {
          const a = rng.range(0, Math.PI * 2);
          const r = rng.range(3, 8);
          const orb = new Mesh(new SphereGeometry(0.22, 8, 6), this.glowMat(0xc8ffb0, 0.85));
          orb.position.set(Math.cos(a) * r, rng.range(12, 20), Math.sin(a) * r);
          g.add(orb);
          this.animated.push({ mesh: orb, base: orb.position.clone(), phase: rng.range(0, 6), bob: 0.4, spin: 0 });
        }
        this.light(g, 0xb8ffb0, 30, 0, 14, 0);
        return g;
      }
      case 'stoneCircle': {
        const parts: BufferGeometry[] = [];
        const n = 9;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const h = rng.range(2.6, 3.6);
          const b = lumpy(new BoxGeometry(0.9, h, 0.55, 1, 3, 1), 0.08, rng.int(0, 1e6));
          place(b, Math.cos(a) * 6, h / 2 - 0.2, Math.sin(a) * 6, rng.range(-0.06, 0.06), -a, rng.range(-0.08, 0.08));
          parts.push(prep(b, gradient(0x6f7266, 0xb8b8a8, 0, h, 0.05, rng), true));
          // Lintels across every other pair.
          if (i % 3 === 0) {
            const a2 = ((i + 1) / n) * Math.PI * 2;
            const mx = (Math.cos(a) + Math.cos(a2)) * 3;
            const mz = (Math.sin(a) + Math.sin(a2)) * 3;
            const lin = new BoxGeometry(2.9, 0.5, 0.6);
            place(lin, mx, 3.2, mz, 0, -(a + a2) / 2 + Math.PI / 2, 0);
            parts.push(prep(lin, 0x9a9a8c, true));
          }
        }
        const altar = lumpy(new BoxGeometry(1.8, 0.7, 1.1), 0.06, 5);
        place(altar, 0, 0.3, 0);
        parts.push(prep(altar, 0x8a8a7c, true));
        g.add(stoneGeo(parts));
        const ring = new Mesh(new RingGeometry(5.2, 5.6, 48), this.glowMat(0xbfe0ff, 0.0));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.12;
        g.add(ring);
        return g;
      }
      case 'ruinedTower': {
        const parts: BufferGeometry[] = [];
        const rings = 14;
        for (let i = 0; i < rings; i++) {
          const y = i * 0.9;
          const segs = 12;
          for (let k = 0; k < segs; k++) {
            // The top is broken off jaggedly on one side.
            const a = (k / segs) * Math.PI * 2;
            const broken = i > 8 && (Math.sin(a * 1.5 + 1) + 1) * 3 < i - 8;
            if (broken) continue;
            if (i >= 4 && i <= 5 && k === 3) continue; // window
            const b = new BoxGeometry(1.25, 0.86, 0.7);
            place(b, Math.cos(a) * 2.2, y + 0.43, Math.sin(a) * 2.2, 0, -a + Math.PI / 2 + (i % 2) * 0.26, 0);
            parts.push(prep(b, gradient(0x7a766c, 0xaaa597, 0, 12, 0.08, rng), true));
          }
        }
        for (let i = 0; i < 16; i++) {
          const b = lumpy(new IcosahedronGeometry(rng.range(0.3, 0.6), 0), 0.2, i);
          const a = rng.range(0, Math.PI * 2);
          place(b, Math.cos(a) * rng.range(2.8, 5), 0.2, Math.sin(a) * rng.range(2.8, 5));
          parts.push(prep(b, 0x8a857c, true));
        }
        g.add(stoneGeo(parts));
        return g;
      }
      case 'temple': {
        const parts: BufferGeometry[] = [];
        for (let s = 0; s < 3; s++) {
          const b = new BoxGeometry(12 - s * 2.4, 0.5, 9 - s * 2);
          place(b, 0, 0.25 + s * 0.5, 0);
          parts.push(prep(b, gradient(0x6a6e5e, 0x9ca08c, 0, 1.5, 0.05, rng), true));
        }
        const cols: Array<[number, number, number]> = [];
        for (let i = 0; i < 6; i++) cols.push([-4.2 + i * 1.7, 0, -3.2], [-4.2 + i * 1.7, 0, 3.2]);
        cols.forEach(([x, , z], i) => {
          const broken = i % 4 === 1 || i === 7;
          const h = broken ? rng.range(1.2, 2.8) : 4.6;
          parts.push(prep(place(new CylinderGeometry(0.34, 0.4, h, 8), x, 1.25 + h / 2, z), gradient(0x8a8e7a, 0xc0c2ae, 1, 6), true));
          if (!broken) parts.push(prep(place(new BoxGeometry(1, 0.35, 1), x, 1.25 + h + 0.17, z), 0xa8aa98, true));
        });
        // A fallen column across the steps.
        parts.push(prep(place(new CylinderGeometry(0.34, 0.38, 4.2, 8), 5.5, 0.5, 1.2, 0, 0.4, Math.PI / 2), 0x9a9c88, true));
        parts.push(prep(place(new BoxGeometry(1.6, 1, 1), 0, 2, 0), 0x7a7c6c, true));
        // Moss.
        for (let i = 0; i < 20; i++) {
          const m = lumpy(new IcosahedronGeometry(rng.range(0.3, 0.7), 0), 0.3, i);
          place(m, rng.range(-5.5, 5.5), rng.range(0.4, 1.3), rng.range(-4, 4), 0, 0, 0, 1, 0.35, 1);
          parts.push(prep(m, 0x4f7a3a, true));
        }
        g.add(stoneGeo(parts));
        const rune = new Mesh(new RingGeometry(0.9, 1.25, 6), this.glowMat(0x8fffd8, 0.6));
        rune.rotation.x = -Math.PI / 2;
        rune.position.y = 2.52;
        g.add(rune);
        this.animated.push({ mesh: rune, base: rune.position.clone(), phase: 0, bob: 0, spin: 0.2 });
        return g;
      }
      case 'floatingRocks': {
        for (let i = 0; i < 7; i++) {
          const parts: BufferGeometry[] = [];
          const s = i === 0 ? 2.6 : rng.range(0.9, 1.8);
          const top = lumpy(new IcosahedronGeometry(s, 1), 0.2, i + 3);
          place(top, 0, 0, 0, 0, 0, 0, 1.2, 0.55, 1.2);
          parts.push(prep(top, gradient(0x6f6a64, 0x78a85a, -0.2, s * 0.45), true));
          const cone = lumpy(new ConeGeometry(s * 1.05, s * 1.8, 7), 0.15, i);
          place(cone, 0, -s * 1.1, 0, Math.PI);
          parts.push(prep(cone, gradient(0x4a4650, 0x7a7670, -s * 2, 0), true));
          // A tuft of grass or a sapling on the bigger ones.
          if (s > 1.2) {
            const tuft = lumpy(new IcosahedronGeometry(s * 0.35, 0), 0.2, i + 9);
            place(tuft, s * 0.2, s * 0.45, 0, 0, 0, 0, 1, 0.8, 1);
            parts.push(prep(tuft, 0x5a9a44, true));
          }
          const rock = new Mesh(merge(parts), this.stone);
          const shards: BufferGeometry[] = [];
          for (let k = 0; k < 3; k++) {
            const c = new OctahedronGeometry(0.16 * s, 0);
            c.scale(1, 2.5, 1);
            place(c, rng.range(-0.4, 0.4) * s, -s * 1.7, rng.range(-0.4, 0.4) * s, Math.PI);
            shards.push(prep(c, 0xc8b8ff, true));
          }
          rock.add(new Mesh(merge(shards), this.crystal));
          const a = (i / 7) * Math.PI * 2;
          const r = i === 0 ? 0 : rng.range(4, 8);
          rock.position.set(Math.cos(a) * r, i === 0 ? 9 : rng.range(5, 13), Math.sin(a) * r);
          g.add(rock);
          this.animated.push({ mesh: rock, base: rock.position.clone(), phase: rng.range(0, 6), bob: 0.6 + rng.next() * 0.5, spin: rng.range(-0.08, 0.08) });
        }
        const ring = new Mesh(new RingGeometry(3, 3.6, 40), this.glowMat(0xb8a8ff, 0.4));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.15;
        g.add(ring);
        this.light(g, 0xb0a0ff, 26, 0, 6, 0);
        return g;
      }
      case 'crystalSpire': {
        const parts: BufferGeometry[] = [];
        const main = new OctahedronGeometry(1.4, 0);
        main.scale(1, 5.5, 1);
        place(main, 0, 7, 0, 0.06, 0, 0.05);
        parts.push(prep(main, gradient(0x7a6fd0, 0xe8f6ff, 0, 14), true));
        for (let i = 0; i < 9; i++) {
          const a = rng.range(0, Math.PI * 2);
          const h = rng.range(1.5, 4.5);
          const c = new OctahedronGeometry(0.5, 0);
          c.scale(1, h, 1);
          place(c, Math.cos(a) * rng.range(1.2, 2.6), h * 0.4, Math.sin(a) * rng.range(1.2, 2.6), Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
          parts.push(prep(c, gradient(0x8a7fd8, 0xd4f4ff, 0, h), true));
        }
        g.add(new Mesh(merge(parts), this.crystal));
        this.light(g, 0xa89aff, 34, 0, 8, 0);
        return g;
      }
      case 'titanBones': {
        const bone = new MeshLambertMaterial({ color: 0xd8cfb8, flatShading: true });
        // Spine.
        const spine = new CatmullRomCurve3([new Vector3(-9, 0.2, 0), new Vector3(-3, 1.4, 0.5), new Vector3(3, 1.8, -0.3), new Vector3(9, 0.6, 0)]);
        g.add(new Mesh(new TubeGeometry(spine, 30, 0.55, 6, false), bone));
        // Ribs: arching curves on both sides.
        for (let i = 0; i < 7; i++) {
          const x = -6 + i * 2;
          const h = 7 - Math.abs(i - 3) * 0.9;
          for (const side of [1, -1]) {
            if (i === 5 && side === -1) continue; // one broken rib
            const c = new CatmullRomCurve3([new Vector3(x, 1.5, 0.3 * side), new Vector3(x + 0.3, h * 0.8, 3 * side), new Vector3(x + 0.6, h * 0.5, 5.2 * side), new Vector3(x + 0.8, 0, 6 * side)]);
            g.add(new Mesh(new TubeGeometry(c, 16, 0.28, 5, false), bone));
          }
        }
        // Skull half-sunk in ash.
        const skull = new Mesh(new SphereGeometry(2.6, 10, 8), bone);
        skull.scale.set(1.4, 0.9, 1);
        skull.position.set(11.5, 0.8, 0.5);
        g.add(skull);
        const socket = new Mesh(new SphereGeometry(0.6, 8, 6), new MeshBasicMaterial({ color: 0x1a1414 }));
        socket.position.set(13.8, 1.4, 1.3);
        g.add(socket);
        const socket2 = socket.clone();
        socket2.position.z = -0.5;
        g.add(socket2);
        return g;
      }
      case 'spring': {
        const parts: BufferGeometry[] = [];
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2;
          const b = lumpy(new BoxGeometry(0.8, 0.5, 0.5), 0.1, i);
          place(b, Math.cos(a) * 4.2, 0.2, Math.sin(a) * 4.2, 0, -a, 0);
          parts.push(prep(b, 0xe4e6ee, true));
        }
        for (const s of [1, -1]) {
          const arch = new TorusGeometry(1.6, 0.18, 6, 16, Math.PI);
          place(arch, s * 4.6, 0, 0, 0, Math.PI / 2, 0);
          parts.push(prep(arch, 0xdcdeea, true));
        }
        g.add(stoneGeo(parts));
        this.light(g, 0x9ff0ff, 18, 0, 1.5, 0);
        return g;
      }
      case 'volcano': {
        const crater = new Mesh(new CircleGeometry(9.5, 28), this.lava);
        crater.rotation.x = -Math.PI / 2;
        crater.position.y = this.terrain.heightAt(l.x, l.z) + 0.5;
        g.add(crater);
        const glow = new Mesh(new RingGeometry(9.2, 13, 28), this.glowMat(0xff6a2a, 0.18));
        glow.rotation.x = -Math.PI / 2;
        glow.position.y = crater.position.y + 0.6;
        g.add(glow);
        this.light(g, 0xff6a2a, 60, 0, crater.position.y + 6, 0);
        return g;
      }
      case 'statue': {
        const parts: BufferGeometry[] = [];
        parts.push(prep(place(new BoxGeometry(4, 1.2, 4), 0, 0.6, 0), 0x8a857a, true));
        const robe = lumpy(new ConeGeometry(1.8, 7, 8), 0.05, 3);
        place(robe, 0, 4.7, 0);
        parts.push(prep(robe, gradient(0x7a766c, 0xa8a497, 1, 8), true));
        parts.push(prep(place(new SphereGeometry(1.05, 10, 8), 0, 9, 0.1), 0xa8a497, true));
        // Hood.
        parts.push(prep(place(new SphereGeometry(1.25, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), 0, 9.1, -0.1), 0x8a867a, true));
        // Staff arm.
        parts.push(prep(place(new CylinderGeometry(0.28, 0.35, 3, 6), 1.3, 6.2, 0.6, 0.5, 0, -0.3), 0x9a968a, true));
        parts.push(prep(place(new CylinderGeometry(0.16, 0.16, 9, 6), 2.1, 5.5, 1.2), 0x6f6a5f, true));
        // Weathering: moss and lichen.
        for (let i = 0; i < 10; i++) {
          const m = lumpy(new IcosahedronGeometry(rng.range(0.25, 0.5), 0), 0.3, i);
          place(m, rng.range(-1.5, 1.5), rng.range(1.3, 6), rng.range(-1.5, 1.5), 0, 0, 0, 1, 0.4, 1);
          parts.push(prep(m, 0x5f7f3f, true));
        }
        g.add(stoneGeo(parts));
        return g;
      }
    }
    return null;
  }

  /** A light source attached to a landmark group (placed once the group is positioned). */
  private light(g: Group, color: number, distance: number, x: number, y: number, z: number): void {
    const src = { position: new Vector3(x, y, z), color: new Color(color), intensity: 0, distance, base: 1 };
    g.userData.lights = [...((g.userData.lights as typeof src[]) ?? []), src];
    this.lights.push(src);
  }

  private glowMat(color: number, opacity: number): MeshBasicMaterial {
    const m = new MeshBasicMaterial({ color, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
    this.glows.push(m);
    return m;
  }

  animate(time: number, darkness: number): void {
    for (const a of this.animated) {
      a.mesh.position.y = a.base.y + Math.sin(time * 0.6 + a.phase) * a.bob;
      if (a.spin) a.mesh.rotation.y += a.spin * 0.016;
    }
    for (const m of this.glows) {
      const base = (m.userData.base as number | undefined) ?? m.opacity;
      m.userData.base = base;
      m.opacity = Math.max(base * 0.6, base + darkness * 0.4) * (0.85 + Math.sin(time * 1.7) * 0.15);
    }
    this.crystal.emissiveIntensity = 0.4 + darkness * 1.1 + Math.sin(time * 1.1) * 0.1;
    for (const l of this.lights) l.intensity = darkness * 12 + 1;
    this.lava.uniforms.uTime!.value = time;
  }
}

export { Color };
