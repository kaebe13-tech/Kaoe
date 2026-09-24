import {
  AdditiveBlending,
  type Blending,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';

export interface ParticleSpec {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size: number;
  /** Size multiplier at end of life. */
  grow?: number;
  r: number;
  g: number;
  b: number;
  a?: number;
  gravity?: number;
  drag?: number;
  /** Horizontal wobble amplitude (leaves, embers). */
  wobble?: number;
}

const vert = /* glsl */ `
attribute vec3 aPos;
attribute float aSize;
attribute vec4 aColor;
varying vec4 vColor;
varying vec2 vUv;
void main() {
  vColor = aColor;
  vUv = uv;
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  mv.xy += position.xy * aSize;
  gl_Position = projectionMatrix * mv;
}
`;

const frag = /* glsl */ `
varying vec4 vColor;
varying vec2 vUv;
uniform float uSoft;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = 1.0 - smoothstep(uSoft, 1.0, d);
  if (a <= 0.01) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
}
`;

/**
 * CPU-simulated billboard particles in a single draw call. Cheap enough for the few
 * hundred live particles the game ever needs.
 */
export class ParticleSystem {
  readonly mesh: Mesh;
  private readonly max: number;
  private count = 0;
  private readonly px: Float32Array;
  private readonly vel: Float32Array;
  private readonly lifeArr: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly grow: Float32Array;
  private readonly col: Float32Array;
  private readonly phys: Float32Array; // gravity, drag, wobble, seed
  private readonly aPos: InstancedBufferAttribute;
  private readonly aSize: InstancedBufferAttribute;
  private readonly aColor: InstancedBufferAttribute;
  private readonly geo: InstancedBufferGeometry;

  constructor(max: number, blending: Blending = NormalBlending, soft = 0.35) {
    this.max = max;
    this.px = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.lifeArr = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.col = new Float32Array(max * 4);
    this.phys = new Float32Array(max * 4);
    const base = new PlaneGeometry(1, 1);
    this.geo = new InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    this.geo.setAttribute('uv', base.getAttribute('uv'));
    this.aPos = new InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(DynamicDrawUsage);
    this.aSize = new InstancedBufferAttribute(new Float32Array(max), 1).setUsage(DynamicDrawUsage);
    this.aColor = new InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(DynamicDrawUsage);
    this.geo.setAttribute('aPos', this.aPos);
    this.geo.setAttribute('aSize', this.aSize);
    this.geo.setAttribute('aColor', this.aColor);
    this.geo.instanceCount = 0;
    const mat = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uSoft: { value: soft } },
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.mesh = new Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  static additive(max: number): ParticleSystem {
    return new ParticleSystem(max, AdditiveBlending, 0.0);
  }

  spawn(p: ParticleSpec): void {
    let i: number;
    if (this.count < this.max) i = this.count++;
    else i = Math.floor(Math.random() * this.max); // recycle a random one when saturated
    this.px[i * 3] = p.x;
    this.px[i * 3 + 1] = p.y;
    this.px[i * 3 + 2] = p.z;
    this.vel[i * 3] = p.vx;
    this.vel[i * 3 + 1] = p.vy;
    this.vel[i * 3 + 2] = p.vz;
    this.lifeArr[i] = p.life;
    this.maxLife[i] = p.life;
    this.size0[i] = p.size;
    this.grow[i] = p.grow ?? 1;
    this.col[i * 4] = p.r;
    this.col[i * 4 + 1] = p.g;
    this.col[i * 4 + 2] = p.b;
    this.col[i * 4 + 3] = p.a ?? 1;
    this.phys[i * 4] = p.gravity ?? 0;
    this.phys[i * 4 + 1] = p.drag ?? 0;
    this.phys[i * 4 + 2] = p.wobble ?? 0;
    this.phys[i * 4 + 3] = Math.random() * 100;
  }

  update(dt: number, time: number): void {
    let n = this.count;
    const pos = this.aPos.array as Float32Array;
    const size = this.aSize.array as Float32Array;
    const color = this.aColor.array as Float32Array;
    for (let i = 0; i < n; i++) {
      this.lifeArr[i]! -= dt;
      if (this.lifeArr[i]! <= 0) {
        // swap-remove
        n--;
        this.copy(n, i);
        i--;
        continue;
      }
      const g = this.phys[i * 4]!;
      const drag = this.phys[i * 4 + 1]!;
      const wob = this.phys[i * 4 + 2]!;
      const seed = this.phys[i * 4 + 3]!;
      this.vel[i * 3 + 1]! -= g * dt;
      const k = Math.max(0, 1 - drag * dt);
      this.vel[i * 3]! *= k;
      this.vel[i * 3 + 1]! *= k;
      this.vel[i * 3 + 2]! *= k;
      this.px[i * 3]! += (this.vel[i * 3]! + (wob ? Math.sin(time * 3 + seed) * wob : 0)) * dt;
      this.px[i * 3 + 1]! += this.vel[i * 3 + 1]! * dt;
      this.px[i * 3 + 2]! += (this.vel[i * 3 + 2]! + (wob ? Math.cos(time * 2.3 + seed) * wob : 0)) * dt;
    }
    this.count = n;
    for (let i = 0; i < n; i++) {
      const t = 1 - this.lifeArr[i]! / this.maxLife[i]!;
      pos[i * 3] = this.px[i * 3]!;
      pos[i * 3 + 1] = this.px[i * 3 + 1]!;
      pos[i * 3 + 2] = this.px[i * 3 + 2]!;
      size[i] = this.size0[i]! * (1 + (this.grow[i]! - 1) * t);
      const fadeIn = Math.min(1, t * 8);
      const fadeOut = 1 - t * t;
      color[i * 4] = this.col[i * 4]!;
      color[i * 4 + 1] = this.col[i * 4 + 1]!;
      color[i * 4 + 2] = this.col[i * 4 + 2]!;
      color[i * 4 + 3] = this.col[i * 4 + 3]! * fadeIn * fadeOut;
    }
    this.geo.instanceCount = n;
    this.aPos.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aColor.needsUpdate = true;
  }

  private copy(from: number, to: number): void {
    for (let k = 0; k < 3; k++) {
      this.px[to * 3 + k] = this.px[from * 3 + k]!;
      this.vel[to * 3 + k] = this.vel[from * 3 + k]!;
    }
    for (let k = 0; k < 4; k++) {
      this.col[to * 4 + k] = this.col[from * 4 + k]!;
      this.phys[to * 4 + k] = this.phys[from * 4 + k]!;
    }
    this.lifeArr[to] = this.lifeArr[from]!;
    this.maxLife[to] = this.maxLife[from]!;
    this.size0[to] = this.size0[from]!;
    this.grow[to] = this.grow[from]!;
  }

  get live(): number {
    return this.count;
  }

  clear(): void {
    this.count = 0;
    this.geo.instanceCount = 0;
  }
}
