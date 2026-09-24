import {
  CircleGeometry,
  Color,
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type IUniform,
} from 'three';
import { BufferAttribute, BufferGeometry } from 'three';
import type { Terrain } from '../world/Terrain';
import type { TerrainUniforms } from './TerrainView';
import { PAL } from './palette';

const vert = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec3 vWorld;
#ifdef RIVER
attribute vec3 aFlow; // x: distance along, y: across (-1..1), z: water level
varying vec3 vFlow;
#endif
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  #ifdef RIVER
  vFlow = aFlow;
  #endif
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const frag = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uHeightTex;
uniform float uWorldSize;
uniform float uWorldHalf;
uniform float uTime;
uniform float uLevel;
uniform float uCalm;
uniform float uRain;
uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uPond; // x, z, radius (radius 0 = ocean)
uniform float uMagic;
varying vec3 vWorld;
#ifdef RIVER
varying vec3 vFlow;
#endif

float wHash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float wNoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(wHash(i), wHash(i+vec2(1.0,0.0)), u.x), mix(wHash(i+vec2(0.0,1.0)), wHash(i+vec2(1.0,1.0)), u.x), u.y);
}

float terrainH(vec2 xz) {
  vec2 uv = (xz + uWorldHalf) / uWorldSize;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -12.0;
  return texture2D(uHeightTex, uv).r;
}

// Wave slope (dh/dx, dh/dz) from scrolling noise layers plus a soft swell.
// Attenuated with distance so the far ocean doesn't alias into stripes.
vec2 noiseGrad(vec2 p) {
  float e = 0.15;
  float c = wNoise(p);
  return vec2(wNoise(p + vec2(e, 0.0)) - c, wNoise(p + vec2(0.0, e)) - c) / e;
}
vec2 waveSlope(vec2 p, float t, float fade) {
  float amp = mix(1.0, 0.4, uCalm);
  vec2 s = vec2(0.0);
  s += noiseGrad(p * 0.35 + vec2(t * 0.12, t * 0.05)) * 0.22;
  s += noiseGrad(p * 0.9 - vec2(t * 0.08, -t * 0.16)) * 0.12;
  s += noiseGrad(p * 2.1 + vec2(-t * 0.25, t * 0.2)) * 0.06 * fade;
  vec2 d1 = normalize(vec2(1.0, 0.35));
  s += d1 * cos(dot(d1, p) * 0.45 + t * 1.0) * 0.05;
  vec2 rp = p * 5.0;
  float r = wNoise(rp + t * 4.0) - wNoise(rp * 1.3 - t * 3.0);
  s += vec2(r, -r) * 0.3 * uRain * fade;
  return s * amp * mix(0.35, 1.0, fade);
}

void main() {
  float h = terrainH(vWorld.xz);
  float level = uLevel;
  #ifdef RIVER
  level = vFlow.z;
  #endif
  float depth = level - h;
  vec3 toCam = cameraPosition - vWorld;
  float camDist = length(toCam);
  vec3 V = toCam / camDist;
  float fade = 1.0 - smoothstep(40.0, 320.0, camDist);
  #ifdef RIVER
  // Ripples carried downstream.
  vec2 fp = vec2(vFlow.x * 0.55 - uTime * 1.3, vFlow.y * 2.2);
  vec2 sl = noiseGrad(fp) * 0.16 + noiseGrad(fp * 2.3 + vec2(-uTime * 0.7, 3.1)) * 0.07 * fade;
  #else
  vec2 sl = waveSlope(vWorld.xz, uTime, fade);
  #endif
  vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));

  vec3 base = mix(uShallow, uMid, smoothstep(0.2, 2.8, depth));
  base = mix(base, uDeep, smoothstep(2.8, 10.0, depth));

  float diff = max(dot(N, uSunDir), 0.0);
  vec3 lit = base * (uAmbient + uSunColor * (0.35 + 0.4 * diff));

  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  vec3 R = reflect(-V, N);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, clamp(R.y * 1.6, 0.0, 1.0));
  vec3 col = mix(lit, sky, clamp(fres * 0.75 + 0.06, 0.0, 0.85));

  float spec = pow(max(dot(R, uSunDir), 0.0), 220.0);
  col += uSunColor * spec * 1.8;

  // Stylized shore foam: a lapping edge plus bands that roll in toward the beach.
  float n1 = wNoise(vWorld.xz * 0.9 + vec2(uTime * 0.15, -uTime * 0.1));
  float n2 = wNoise(vWorld.xz * 2.7 - vec2(uTime * 0.2, uTime * 0.05));
  float edgeW = mix(0.18 + n1 * 0.22, 0.035 + n1 * 0.03, uCalm);
  float edge = (1.0 - smoothstep(0.0, edgeW, depth)) * mix(1.0, 0.35, uCalm);
  float band = sin(depth * 5.5 - uTime * 1.6 + n1 * 4.0);
  float lines = smoothstep(0.82, 0.97, band) * (1.0 - smoothstep(0.25, 1.3, depth)) * step(0.35, n2) * (1.0 - uCalm);
  float foam = clamp(max(edge, lines * 0.85), 0.0, 1.0);
  #ifdef RIVER
  // Streaks of foam drifting with the current, thicker near the banks.
  float streak = smoothstep(0.62, 0.95, wNoise(vec2(vFlow.x * 0.35 - uTime * 1.6, vFlow.y * 3.0)));
  foam = max(foam, streak * (0.25 + 0.55 * smoothstep(0.55, 1.0, abs(vFlow.y))) * fade);
  #endif
  vec3 foamCol = uFoam * (uAmbient * 0.9 + uSunColor * 0.55);
  col = mix(col, foamCol, foam);

  float alpha = mix(0.38, 0.94, smoothstep(0.0, 2.6, depth));
  alpha = max(alpha, foam * 0.95);
  alpha *= smoothstep(-0.02, 0.06, depth);
  if (uPond.z > 0.0) alpha *= 1.0 - smoothstep(uPond.z * 1.25, uPond.z * 1.5, length(vWorld.xz - uPond.xy));
  #ifdef RIVER
  alpha *= 1.0 - smoothstep(0.85, 1.0, abs(vFlow.y)) * (1.0 - smoothstep(0.0, 0.25, depth));
  #endif
  if (uMagic > 0.0) {
    // The Moonwell glows from within, brightest at night.
    float shimmer = 0.6 + 0.4 * sin(uTime * 2.0 + wNoise(vWorld.xz * 3.0) * 6.0);
    col = mix(col, vec3(0.55, 0.95, 1.0) * (0.7 + shimmer * 0.5), uMagic * 0.55);
    alpha = max(alpha, 0.75 * smoothstep(-0.02, 0.06, depth));
  }
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface WaterLook {
  skyHorizon: Color;
  skyZenith: Color;
  sunDir: Vector3;
  sunColor: Color;
  ambient: Color;
}

interface SharedWaterUniforms {
  uSkyHorizon: IUniform<Color>;
  uSkyZenith: IUniform<Color>;
  uSunDir: IUniform<Vector3>;
  uSunColor: IUniform<Color>;
  uAmbient: IUniform<Color>;
}

/** Ocean plane plus one calm disc per pond, sharing a depth-aware stylized water shader. */
export class WaterView {
  readonly group = new Group();
  private readonly shared: SharedWaterUniforms;

  constructor(terrain: Terrain, tu: TerrainUniforms) {
    const shared = {
      uHeightTex: tu.uHeightTex,
      uWorldSize: tu.uWorldSize,
      uWorldHalf: tu.uWorldHalf,
      uTime: tu.uTime,
      uRain: tu.uWet,
      uSkyHorizon: { value: new Color(0xbfe3f5) },
      uSkyZenith: { value: new Color(0x5aa9e6) },
      uSunDir: { value: new Vector3(0.3, 0.8, 0.2).normalize() },
      uSunColor: { value: new Color(0xffffff) },
      uAmbient: { value: new Color(0x8899aa) },
      uFoam: { value: new Color(PAL.foam) },
    };
    this.shared = shared;
    const make = (level: number, calm: number, shallow: number, mid: number, deep: number, pond = new Vector3(0, 0, 0), river = false, magic = 0): ShaderMaterial => {
      const uniforms: Record<string, IUniform> = UniformsUtils.merge([UniformsLib.fog]);
      Object.assign(uniforms, shared, {
        uLevel: { value: level },
        uCalm: { value: calm },
        uShallow: { value: new Color(shallow) },
        uMid: { value: new Color(mid) },
        uDeep: { value: new Color(deep) },
        uPond: { value: pond },
        uMagic: { value: magic },
      });
      return new ShaderMaterial({
        uniforms,
        vertexShader: vert,
        fragmentShader: frag,
        transparent: true,
        depthWrite: false,
        fog: true,
        defines: river ? { RIVER: 1 } : {},
      });
    };

    const oceanGeo = new PlaneGeometry(4000, 4000, 1, 1);
    oceanGeo.rotateX(-Math.PI / 2);
    const ocean = new Mesh(oceanGeo, make(0, 0, PAL.waterShallow, PAL.waterMid, PAL.waterDeep));
    ocean.name = 'ocean';
    ocean.renderOrder = 1;
    this.group.add(ocean);

    for (const p of terrain.ponds) {
      const g = new CircleGeometry(p.radius * 1.6, 48);
      g.rotateX(-Math.PI / 2);
      const mesh = new Mesh(g, make(p.level, 1, p.magic ? 0x8ff0e8 : PAL.pondShallow, p.magic ? 0x3fb8c0 : 0x3f9c9a, p.magic ? 0x2a6f9a : PAL.pondDeep, new Vector3(p.x, p.z, p.radius), false, p.magic ? 1 : 0));
      mesh.position.set(p.x, p.level, p.z);
      mesh.renderOrder = 1;
      mesh.name = `pond-${p.id}`;
      this.group.add(mesh);
    }

    // Rivers: a ribbon following each channel, sloping with its water level.
    const riverMat = make(0, 0.7, 0x6fd3c8, 0x3aa6b8, 0x2a6f8a, new Vector3(0, 0, 0), true);
    for (const r of terrain.rivers) {
      const pts = r.points;
      const pos: number[] = [];
      const flow: number[] = [];
      const idx: number[] = [];
      let s = 0;
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k]!;
        const a = pts[Math.max(0, k - 1)]!;
        const b = pts[Math.min(pts.length - 1, k + 1)]!;
        if (k > 0) s += Math.hypot(p.x - pts[k - 1]!.x, p.z - pts[k - 1]!.z);
        const tx = b.x - a.x;
        const tz = b.z - a.z;
        const tl = Math.hypot(tx, tz) || 1;
        const nx = -tz / tl;
        const nz = tx / tl;
        const half = p.width + 1.6;
        const y = Math.max(p.level, -0.05) + 0.02;
        pos.push(p.x - nx * half, y, p.z - nz * half, p.x + nx * half, y, p.z + nz * half);
        flow.push(s, -1, y, s, 1, y);
        if (k > 0) {
          const i = k * 2;
          idx.push(i - 2, i - 1, i, i - 1, i + 1, i);
        }
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute('aFlow', new BufferAttribute(new Float32Array(flow), 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const mesh = new Mesh(g, riverMat);
      mesh.renderOrder = 1;
      mesh.name = `river-${r.id}`;
      this.group.add(mesh);
    }
  }

  setLook(look: WaterLook): void {
    this.shared.uSkyHorizon.value.copy(look.skyHorizon);
    this.shared.uSkyZenith.value.copy(look.skyZenith);
    this.shared.uSunDir.value.copy(look.sunDir);
    this.shared.uSunColor.value.copy(look.sunColor);
    this.shared.uAmbient.value.copy(look.ambient);
  }
}
