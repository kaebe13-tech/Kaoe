import {
  Color,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
  Vector4,
} from 'three';
import { Rng } from '../core/rng';
import type { RainCloud } from '../sim/weather';

const MAX_DROPS = 9000;
const MAX_CLOUDS = 4;
const PUFFS_PER_CLOUD = 16;

const vert = /* glsl */ `
attribute vec3 aOffset;
uniform vec3 uCenter;
uniform float uBox;
uniform float uTime;
uniform vec4 uClouds[${MAX_CLOUDS}];
uniform vec2 uWind;
varying float vAlpha;
varying float vT;
void main() {
  float span = uBox * 2.0;
  float x = uCenter.x - uBox + mod(aOffset.x * span - (uCenter.x - uBox), span);
  float z = uCenter.z - uBox + mod(aOffset.z * span - (uCenter.z - uBox), span);
  float h = 34.0;
  float fall = 26.0 + aOffset.y * 8.0;
  float y = uCenter.y - 6.0 + mod(aOffset.y * 97.0 * h - uTime * fall, h);
  float inten = 0.0;
  for (int i = 0; i < ${MAX_CLOUDS}; i++) {
    vec4 c = uClouds[i];
    float d = length(vec2(x, z) - c.xy);
    inten = max(inten, c.w * (1.0 - smoothstep(c.z * 0.6, c.z, d)));
  }
  // Each drop has a threshold so density scales smoothly with intensity.
  float on = step(fract(aOffset.x * 7.13 + aOffset.z * 3.71), inten);
  vec3 p = vec3(x + uWind.x * (y - uCenter.y) * 0.15, y, z + uWind.y * (y - uCenter.y) * 0.15);
  vec3 toCam = normalize(cameraPosition - p);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec3 pos = p + right * position.x * 0.045 * on + vec3(0.0, 1.0, 0.0) * position.y * 0.9 * on;
  vAlpha = on * (0.25 + inten * 0.3);
  vT = position.y + 0.5;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const frag = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
varying float vT;
void main() {
  float a = vAlpha * smoothstep(0.0, 0.6, vT);
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

/** GPU-animated rain streaks, visible only under rain clouds, plus dark storm puffs. */
export class RainView {
  readonly group = new Group();
  private readonly mat: ShaderMaterial;
  private readonly puffs: InstancedMesh;
  private readonly puffMat: MeshLambertMaterial;
  private readonly puffOffsets: Array<{ x: number; y: number; z: number; s: number }> = [];

  constructor() {
    const base = new PlaneGeometry(1, 1);
    const geo = new InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    const rng = new Rng(77);
    const off = new Float32Array(MAX_DROPS * 3);
    for (let i = 0; i < off.length; i++) off[i] = rng.next();
    geo.setAttribute('aOffset', new InstancedBufferAttribute(off, 3));
    geo.instanceCount = MAX_DROPS;
    const clouds: Vector4[] = [];
    for (let i = 0; i < MAX_CLOUDS; i++) clouds.push(new Vector4(0, 0, 1, 0));
    this.mat = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uCenter: { value: new Vector3() },
        uBox: { value: 40 },
        uTime: { value: 0 },
        uClouds: { value: clouds },
        uWind: { value: new Vector3(0.3, 0.1) },
        uColor: { value: new Color(0xcfe3f5) },
      },
      transparent: true,
      depthWrite: false,
    });
    const mesh = new Mesh(geo, this.mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 8;
    this.group.add(mesh);

    this.puffMat = new MeshLambertMaterial({ color: 0x59626c, emissive: 0x20262c, flatShading: true, transparent: true, opacity: 0.92 });
    const pg = new IcosahedronGeometry(1, 1);
    pg.scale(1, 0.6, 1);
    this.puffs = new InstancedMesh(pg, this.puffMat, MAX_CLOUDS * PUFFS_PER_CLOUD);
    this.puffs.instanceMatrix.setUsage(DynamicDrawUsage);
    this.puffs.frustumCulled = false;
    this.group.add(this.puffs);
    for (let i = 0; i < PUFFS_PER_CLOUD; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(rng.next()) * 0.75;
      this.puffOffsets.push({ x: Math.cos(a) * r, y: rng.range(-0.1, 0.25), z: Math.sin(a) * r, s: rng.range(0.55, 1) });
    }
  }

  update(time: number, focus: Vector3, camDist: number, clouds: readonly RainCloud[], windX: number, windZ: number): void {
    const u = this.mat.uniforms;
    u.uTime!.value = time;
    u.uCenter!.value.copy(focus);
    u.uBox!.value = Math.min(90, 26 + camDist * 0.6);
    u.uWind!.value.set(windX * 0.4, windZ * 0.4, 0);
    const arr = u.uClouds!.value as Vector4[];
    for (let i = 0; i < MAX_CLOUDS; i++) {
      const c = clouds[i];
      if (c) arr[i]!.set(c.x, c.z, c.radius, c.intensity);
      else arr[i]!.set(0, 0, 1, 0);
    }
    const m = new Matrix4();
    const q = new Quaternion();
    const p = new Vector3();
    const s = new Vector3();
    for (let ci = 0; ci < MAX_CLOUDS; ci++) {
      const c = clouds[ci];
      for (let k = 0; k < PUFFS_PER_CLOUD; k++) {
        const idx = ci * PUFFS_PER_CLOUD + k;
        if (!c || c.intensity < 0.02) {
          m.makeScale(0, 0, 0);
        } else {
          const o = this.puffOffsets[k]!;
          const R = c.radius;
          p.set(c.x + o.x * R, 34 + o.y * 10 + Math.sin(time * 0.3 + k) * 0.4, c.z + o.z * R);
          s.setScalar(R * 0.34 * o.s * (0.4 + c.intensity * 0.6));
          m.compose(p, q, s);
        }
        this.puffs.setMatrixAt(idx, m);
      }
    }
    this.puffs.instanceMatrix.needsUpdate = true;
  }
}
