import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshLambertMaterial,
  RedFormat,
  type IUniform,
  type WebGLProgramParametersWithUniforms,
  DataUtils,
} from 'three';
import { Simplex2 } from '../core/noise';
import { clamp01, lerp, smoothstep } from '../core/math';
import type { Terrain } from '../world/Terrain';
import { WORLD_HALF, WORLD_SIZE } from '../world/config';
import { PAL } from './palette';

/** Shared uniforms for terrain-aware shaders (terrain, water, grass). */
export interface TerrainUniforms {
  uHeightTex: IUniform<DataTexture>;
  uWearTex: IUniform<DataTexture>;
  uWorldSize: IUniform<number>;
  uWorldHalf: IUniform<number>;
  uTime: IUniform<number>;
  uWet: IUniform<number>;
}

export function makeHeightTexture(terrain: Terrain): DataTexture {
  const n = terrain.res * terrain.res;
  const half = new Uint16Array(n);
  for (let i = 0; i < n; i++) half[i] = DataUtils.toHalfFloat(terrain.heights[i]!);
  const tex = new DataTexture(half, terrain.res, terrain.res, RedFormat, HalfFloatType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function makeWearTexture(size: number): DataTexture {
  const tex = new DataTexture(new Float32Array(size * size), size, size, RedFormat, FloatType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export class TerrainView {
  readonly mesh: Mesh;
  readonly uniforms: TerrainUniforms;

  constructor(terrain: Terrain, heightTex: DataTexture, wearTex: DataTexture) {
    this.uniforms = {
      uHeightTex: { value: heightTex },
      uWearTex: { value: wearTex },
      uWorldSize: { value: WORLD_SIZE },
      uWorldHalf: { value: WORLD_HALF },
      uTime: { value: 0 },
      uWet: { value: 0 },
    };
    const geo = buildTerrainGeometry(terrain);
    const mat = new MeshLambertMaterial({ vertexColors: true });
    const u = this.uniforms;
    mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vWorldP;
uniform sampler2D uWearTex;
uniform float uWorldSize;
uniform float uWorldHalf;
uniform float uWet;
float tHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(tHash(i), tHash(i+vec2(1.0,0.0)), u.x), mix(tHash(i+vec2(0.0,1.0)), tHash(i+vec2(1.0,1.0)), u.x), u.y);
}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
{
  vec2 wuv = (vWorldP.xz + uWorldHalf) / uWorldSize;
  float wear = texture2D(uWearTex, wuv).r;
  float above = smoothstep(0.35, 0.9, vWorldP.y);
  float path = smoothstep(0.08, 0.7, wear) * above;
  vec3 dirt = vec3(${hexToVec(PAL.dirt)});
  float grain = tNoise(vWorldP.xz * 2.3) * 0.6 + tNoise(vWorldP.xz * 7.1) * 0.4;
  diffuseColor.rgb = mix(diffuseColor.rgb, dirt * (0.9 + grain * 0.2), path * 0.8);
  // Painterly breakup so large areas don't look like flat vertex colour.
  float n = tNoise(vWorldP.xz * 0.45) * 0.5 + tNoise(vWorldP.xz * 1.7) * 0.35 + grain * 0.15;
  diffuseColor.rgb *= 0.93 + n * 0.14;
  diffuseColor.rgb *= mix(1.0, 0.74, uWet * above);
}`,
        );
    };
    mat.customProgramCacheKey = () => 'terrain-v1';
    this.mesh = new Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'terrain';
  }
}

function hexToVec(hex: number): string {
  const c = new Color(hex);
  return `${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)}`;
}

function buildTerrainGeometry(terrain: Terrain): BufferGeometry {
  const res = terrain.res;
  const cell = terrain.cell;
  const count = res * res;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const n1 = new Simplex2(1234);
  const n2 = new Simplex2(5678);

  const C = {
    sandDry: new Color(PAL.sandDry),
    sandWet: new Color(PAL.sandWet),
    sandUnder: new Color(PAL.sandUnder),
    seabed: new Color(PAL.seabed),
    grassLight: new Color(PAL.grassLight),
    grassMid: new Color(PAL.grassMid),
    grassDark: new Color(PAL.grassDark),
    forest: new Color(PAL.forestFloor),
    meadow: new Color(PAL.meadow),
    rock: new Color(PAL.rock),
    rockDark: new Color(PAL.rockDark),
    rockLight: new Color(PAL.rockLight),
    mud: new Color(PAL.mud),
  };
  const grass = new Color();
  const sand = new Color();
  const rock = new Color();
  const out = new Color();

  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const i = iz * res + ix;
      const x = ix * cell - WORLD_HALF;
      const z = iz * cell - WORLD_HALF;
      const h = terrain.heights[i]!;
      positions[i * 3] = x;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = z;

      const hl = terrain.sample(ix - 1, iz);
      const hr = terrain.sample(ix + 1, iz);
      const hd = terrain.sample(ix, iz - 1);
      const hu = terrain.sample(ix, iz + 1);
      let nx = hl - hr;
      let ny = 2 * cell;
      let nz = hd - hu;
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl;
      ny /= nl;
      nz /= nl;
      normals[i * 3] = nx;
      normals[i * 3 + 1] = ny;
      normals[i * 3 + 2] = nz;

      const slope = Math.sqrt(Math.max(0, 1 - ny * ny)) / ny;
      const m = terrain.moisture[i]!;
      const big = n1.fbm(x * 0.035, z * 0.035, 3);
      const small = n2.noise(x * 0.25, z * 0.25);

      // Grass: lush where moist, sun-bleached meadow where dry.
      grass.copy(C.grassLight).lerp(C.grassMid, smoothstep(0.25, 0.7, m + big * 0.18));
      grass.lerp(C.forest, smoothstep(0.52, 0.72, m) * 0.9);
      grass.lerp(C.meadow, smoothstep(0.42, 0.12, m) * (0.35 + 0.35 * (big * 0.5 + 0.5)));
      grass.offsetHSL(0, 0, small * 0.025);

      // Sand: wet near the waterline, dry up the beach, seabed below.
      if (h < 0) {
        sand.copy(C.sandUnder).lerp(C.seabed, smoothstep(0.5, 5, -h));
      } else {
        sand.copy(C.sandWet).lerp(C.sandDry, smoothstep(0.08, 0.55, h));
      }
      const sandT = 1 - smoothstep(0.9, 1.7, h + small * 0.25 + big * 0.2);

      rock.copy(C.rockDark).lerp(C.rock, clamp01(small * 0.5 + 0.5)).lerp(C.rockLight, smoothstep(11, 17, h) * 0.6);
      // Steep-but-grassy slopes get a darker, earthier green instead of grey smears.
      grass.lerp(C.forest, smoothstep(0.45, 0.8, slope) * 0.45);
      const rockT = clamp01(smoothstep(0.78, 1.1, slope + big * 0.08) + smoothstep(14, 18, h + big * 2));

      out.copy(grass).lerp(sand, sandT).lerp(rock, rockT);

      // Muddy, darker banks around ponds.
      for (const p of terrain.ponds) {
        const d = Math.hypot(x - p.x, z - p.z);
        if (d < p.radius * 2) {
          const bank = (1 - smoothstep(p.level + 0.05, p.level + 0.55, h)) * (1 - smoothstep(p.radius * 1.2, p.radius * 1.9, d));
          out.lerp(C.mud, bank * 0.75);
        }
      }
      colors[i * 3] = out.r;
      colors[i * 3 + 1] = out.g;
      colors[i * 3 + 2] = out.b;
    }
  }

  const quads = (res - 1) * (res - 1);
  const index = new Uint32Array(quads * 6);
  let k = 0;
  for (let iz = 0; iz < res - 1; iz++) {
    for (let ix = 0; ix < res - 1; ix++) {
      const a = iz * res + ix;
      const b = a + 1;
      const c = a + res;
      const d = c + 1;
      // Alternate the split diagonal along the steepest direction for smoother silhouettes.
      const h00 = terrain.heights[a]!;
      const h11 = terrain.heights[d]!;
      const h10 = terrain.heights[b]!;
      const h01 = terrain.heights[c]!;
      if (Math.abs(h00 - h11) < Math.abs(h10 - h01)) {
        index[k++] = a; index[k++] = c; index[k++] = d;
        index[k++] = a; index[k++] = d; index[k++] = b;
      } else {
        index[k++] = a; index[k++] = c; index[k++] = b;
        index[k++] = b; index[k++] = c; index[k++] = d;
      }
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('normal', new BufferAttribute(normals, 3));
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  geo.setIndex(new BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  void lerp;
  return geo;
}
