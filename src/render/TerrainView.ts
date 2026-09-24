import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DataUtils,
  Group,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshLambertMaterial,
  NearestFilter,
  RedFormat,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
  type IUniform,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { Simplex2 } from '../core/noise';
import { clamp01, smoothstep } from '../core/math';
import { NO_WATER, type Terrain } from '../world/Terrain';
import { MAP_N, WORLD_HALF, WORLD_SIZE } from '../world/config';
import { Biome, BIOMES, type BiomeId } from '../world/biomes';
import { PAL } from './palette';

/** Shared uniforms for terrain-aware shaders (terrain, water, grass). */
export interface TerrainUniforms {
  uHeightTex: IUniform<DataTexture>;
  uWearTex: IUniform<DataTexture>;
  uWorldSize: IUniform<number>;
  uWorldHalf: IUniform<number>;
  uTime: IUniform<number>;
  uWet: IUniform<number>;
  uTerritory: IUniform<DataTexture>;
  /** 0..1 how strongly civilization borders are drawn (fades in when zoomed out). */
  uBorders: IUniform<number>;
  /** Civ id + 1 of the highlighted civilization (0 = none), and its colour. */
  uHighlight: IUniform<number>;
  uHighlightColor: IUniform<Color>;
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
  const tex = new DataTexture(new Uint8Array(size * size), size, size, RedFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Territory map: civ colour in RGB, civ id + 1 in alpha (0 = unclaimed). */
export function makeTerritoryTexture(): DataTexture {
  const tex = new DataTexture(new Uint8Array(MAP_N * MAP_N * 4), MAP_N, MAP_N, RGBAFormat, UnsignedByteType);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

const CHUNKS = 8;
const LOD_STRIDES = [1, 2, 4];

interface Chunk {
  center: Vector3;
  radius: number;
  lods: Mesh[];
  current: number;
  gx: number;
  gz: number;
}

/**
 * The ground: a heightfield split into chunks with three levels of detail (and skirts to hide
 * seams between them), painted per biome with soft transitions, worn paths, wet ground after
 * rain, and civilization borders that fade in as the camera pulls back.
 */
export class TerrainView {
  readonly mesh: Group;
  readonly uniforms: TerrainUniforms;
  private readonly chunks: Chunk[] = [];
  readonly material: MeshLambertMaterial;
  private readonly colors: Float32Array;
  private readonly quads: number;

  constructor(
    private readonly terrain: Terrain,
    heightTex: DataTexture,
    wearTex: DataTexture,
    territoryTex: DataTexture,
  ) {
    this.uniforms = {
      uHeightTex: { value: heightTex },
      uWearTex: { value: wearTex },
      uWorldSize: { value: WORLD_SIZE },
      uWorldHalf: { value: WORLD_HALF },
      uTime: { value: 0 },
      uWet: { value: 0 },
      uTerritory: { value: territoryTex },
      uBorders: { value: 0 },
      uHighlight: { value: 0 },
      uHighlightColor: { value: new Color(1, 1, 1) },
    };
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
uniform sampler2D uTerritory;
uniform float uWorldSize;
uniform float uWorldHalf;
uniform float uWet;
uniform float uBorders;
uniform float uHighlight;
uniform vec3 uHighlightColor;
float tHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(tHash(i), tHash(i+vec2(1.0,0.0)), u.x), mix(tHash(i+vec2(0.0,1.0)), tHash(i+vec2(1.0,1.0)), u.x), u.y);
}
vec4 terr(vec2 xz) { return texture2D(uTerritory, (xz + uWorldHalf) / uWorldSize); }`,
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
  // Civilization borders: a soft tint over the land and a painted line along the edge.
  if (uBorders > 0.001) {
    vec2 wob = vec2(tNoise(vWorldP.xz * 0.08), tNoise(vWorldP.zx * 0.08 + 17.0)) * 6.0 - 3.0;
    vec2 p = vWorldP.xz + wob;
    vec4 t0 = terr(p);
    float edge = 0.0;
    float d = 3.0;
    edge = max(edge, step(0.002, abs(terr(p + vec2(d, 0.0)).a - t0.a)));
    edge = max(edge, step(0.002, abs(terr(p - vec2(d, 0.0)).a - t0.a)));
    edge = max(edge, step(0.002, abs(terr(p + vec2(0.0, d)).a - t0.a)));
    edge = max(edge, step(0.002, abs(terr(p - vec2(0.0, d)).a - t0.a)));
    float owned = step(0.002, t0.a);
    float hl = step(0.5, uHighlight) * (1.0 - step(0.5, abs(t0.a * 255.0 - uHighlight)));
    vec3 tint = t0.rgb;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.65 + tint * 0.55, owned * uBorders * (0.16 + hl * 0.22) * above);
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(tint, vec3(1.0), 0.25), edge * owned * uBorders * 0.85 * above);
  }
}`,
        );
    };
    mat.customProgramCacheKey = () => 'terrain-v2';
    this.material = mat;

    const colors = computeColors(terrain);
    this.colors = colors;
    this.mesh = new Group();
    this.mesh.name = 'terrain';
    const res = terrain.res;
    const quads = (res - 1) / CHUNKS;
    this.quads = quads;
    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        const lods: Mesh[] = [];
        for (let l = 0; l < LOD_STRIDES.length; l++) {
          const geo = buildChunk(terrain, colors, cx * quads, cz * quads, quads, LOD_STRIDES[l]!);
          const m = new Mesh(geo, mat);
          m.receiveShadow = true;
          m.castShadow = false;
          m.visible = l === 0;
          m.name = `terrain-${cx}-${cz}-L${l}`;
          lods.push(m);
          this.mesh.add(m);
        }
        const bs = lods[0]!.geometry.boundingSphere!;
        this.chunks.push({ center: bs.center.clone(), radius: bs.radius, lods, current: 0, gx: cx, gz: cz });
      }
    }
  }

  /** The land changed inside a world rectangle: repaint it and rebuild the chunks it touches. */
  rebuildRegion(x0: number, z0: number, x1: number, z1: number): void {
    const t = this.terrain;
    const rect = {
      ix0: Math.max(0, Math.floor(t.toGrid(x0)) - 6),
      iz0: Math.max(0, Math.floor(t.toGrid(z0)) - 6),
      ix1: Math.min(t.res - 1, Math.ceil(t.toGrid(x1)) + 6),
      iz1: Math.min(t.res - 1, Math.ceil(t.toGrid(z1)) + 6),
    };
    computeColors(t, this.colors, rect);
    for (const c of this.chunks) {
      const cx0 = c.gx * this.quads;
      const cz0 = c.gz * this.quads;
      if (cx0 > rect.ix1 || cx0 + this.quads < rect.ix0 || cz0 > rect.iz1 || cz0 + this.quads < rect.iz0) continue;
      c.lods.forEach((m, l) => {
        m.geometry.dispose();
        m.geometry = buildChunk(t, this.colors, cx0, cz0, this.quads, LOD_STRIDES[l]!);
      });
      const bs = c.lods[0]!.geometry.boundingSphere!;
      c.center.copy(bs.center);
      c.radius = bs.radius;
    }
    const tex = this.uniforms.uHeightTex.value;
    const data = tex.image.data as Uint16Array;
    for (let iz = rect.iz0; iz <= rect.iz1; iz++) for (let ix = rect.ix0; ix <= rect.ix1; ix++) data[iz * t.res + ix] = DataUtils.toHalfFloat(t.heights[iz * t.res + ix]!);
    tex.needsUpdate = true;
  }

  /** Pick a level of detail per chunk from the camera position. */
  updateLod(camera: Vector3): void {
    for (const c of this.chunks) {
      const d = Math.max(0, camera.distanceTo(c.center) - c.radius * 0.5);
      const want = d < 150 ? 0 : d < 320 ? 1 : 2;
      if (want === c.current) continue;
      c.lods[c.current]!.visible = false;
      c.lods[want]!.visible = true;
      c.current = want;
    }
  }

  get triangles(): number {
    let n = 0;
    for (const c of this.chunks) n += (c.lods[c.current]!.geometry.index?.count ?? 0) / 3;
    return n;
  }
}

function hexToVec(hex: number): string {
  const c = new Color(hex);
  return `${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)}`;
}

/** Per-sample colours for the heightfield (or a rectangle of it), with soft blending between biomes. */
function computeColors(terrain: Terrain, target?: Float32Array, rect?: { ix0: number; iz0: number; ix1: number; iz1: number }): Float32Array {
  const res = terrain.res;
  const cell = terrain.cell;
  const colors = target ?? new Float32Array(res * res * 3);
  const ix0 = rect?.ix0 ?? 0;
  const iz0 = rect?.iz0 ?? 0;
  const ix1 = rect?.ix1 ?? res - 1;
  const iz1 = rect?.iz1 ?? res - 1;
  const n1 = new Simplex2(1234);
  const n2 = new Simplex2(5678);
  const pal = new Map<number, { g0: Color; g1: Color; forest: Color; r0: Color; r1: Color }>();
  for (const k of Object.keys(BIOMES)) {
    const b = BIOMES[Number(k) as BiomeId];
    pal.set(Number(k), { g0: new Color(b.grass[0]), g1: new Color(b.grass[1]), forest: new Color(b.forest), r0: new Color(b.rock[0]), r1: new Color(b.rock[1]) });
  }
  const C = {
    sandDry: new Color(PAL.sandDry),
    sandWet: new Color(PAL.sandWet),
    sandUnder: new Color(PAL.sandUnder),
    seabed: new Color(PAL.seabed),
    mud: new Color(PAL.mud),
    snow: new Color(0xf2f4f7),
    ash: new Color(0x4a4040),
    ember: new Color(0x6b3b2a),
    meadow: new Color(PAL.meadow),
    moss: new Color(0x5d7f3a),
    crystal: new Color(0x9fd6c8),
  };
  const grass = new Color();
  const sand = new Color();
  const rock = new Color();
  const out = new Color();
  const tmp = new Color();
  const acc = new Color();
  // Blend biome palettes over a small neighbourhood for soft borders.
  const offs = [
    [0, 0],
    [5, 0],
    [-5, 0],
    [0, 5],
    [0, -5],
    [4, 4],
    [-4, -4],
  ];
  const blend = { g0: new Color(), g1: new Color(), forest: new Color(), r0: new Color(), r1: new Color() };
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const i = iz * res + ix;
      const x = ix * cell - WORLD_HALF;
      const z = iz * cell - WORLD_HALF;
      const h = terrain.heights[i]!;
      blend.g0.setRGB(0, 0, 0);
      blend.g1.setRGB(0, 0, 0);
      blend.forest.setRGB(0, 0, 0);
      blend.r0.setRGB(0, 0, 0);
      blend.r1.setRGB(0, 0, 0);
      let ash = 0;
      let cry = 0;
      let high = 0;
      let elder = 0;
      for (const [dx, dz] of offs) {
        const b = terrain.biomeAt(x + dx!, z + dz!);
        const p = pal.get(b === Biome.Ocean ? Biome.Coast : b)!;
        blend.g0.add(p.g0);
        blend.g1.add(p.g1);
        blend.forest.add(p.forest);
        blend.r0.add(p.r0);
        blend.r1.add(p.r1);
        if (b === Biome.Ashen) ash++;
        if (b === Biome.CrystalWilds) cry++;
        if (b === Biome.Highlands) high++;
        if (b === Biome.Elderwood) elder++;
      }
      const k = 1 / offs.length;
      blend.g0.multiplyScalar(k);
      blend.g1.multiplyScalar(k);
      blend.forest.multiplyScalar(k);
      blend.r0.multiplyScalar(k);
      blend.r1.multiplyScalar(k);
      ash *= k;
      cry *= k;
      high *= k;
      elder *= k;

      const hl = terrain.sample(ix - 1, iz);
      const hr = terrain.sample(ix + 1, iz);
      const hd = terrain.sample(ix, iz - 1);
      const hu = terrain.sample(ix, iz + 1);
      const nx = hl - hr;
      const ny = 2 * cell;
      const nz = hd - hu;
      const nl = Math.hypot(nx, ny, nz);
      const nyn = ny / nl;
      const slope = Math.sqrt(Math.max(0, 1 - nyn * nyn)) / nyn;
      const m = terrain.moisture[i]!;
      const big = n1.fbm(x * 0.03, z * 0.03, 3);
      const small = n2.noise(x * 0.25, z * 0.25);

      // Grass: lush where moist, sun-bleached where dry; forest floor under the old trees.
      grass.copy(blend.g0).lerp(blend.g1, smoothstep(0.25, 0.75, m + big * 0.18));
      grass.lerp(blend.forest, smoothstep(0.55, 0.78, m) * 0.85);
      grass.lerp(C.meadow, smoothstep(0.42, 0.12, m) * (0.25 + 0.3 * (big * 0.5 + 0.5)) * (1 - ash) * (1 - cry));
      grass.lerp(C.moss, elder * smoothstep(0.2, 0.7, big * 0.5 + 0.5) * 0.35);
      grass.offsetHSL(0, 0, small * 0.025);

      // Sand: wet near the waterline, dry up the beach, seabed below. Black sand on the ash coast.
      if (h < 0) {
        sand.copy(C.sandUnder).lerp(C.seabed, smoothstep(0.5, 5, -h));
      } else {
        sand.copy(C.sandWet).lerp(C.sandDry, smoothstep(0.08, 0.55, h));
      }
      if (ash > 0) sand.lerp(tmp.setRGB(0.28, 0.25, 0.24), ash * 0.75);
      const sandT = 1 - smoothstep(0.9, 1.7, h + small * 0.25 + big * 0.2);

      // Rock: strata bands and a warm/cool shift so cliffs read as stone, not flat grey.
      const strata = Math.sin(h * 1.1 + big * 2.2) * 0.5 + 0.5;
      rock.copy(blend.r0).lerp(blend.r1, clamp01(small * 0.5 + 0.5) * 0.6 + smoothstep(14, 30, h) * 0.3);
      rock.offsetHSL(big * 0.02, 0.02 + big * 0.03, (strata - 0.5) * 0.16 - smoothstep(0.9, 1.4, slope) * 0.08);
      grass.lerp(blend.forest, smoothstep(0.45, 0.8, slope) * 0.45);
      const highRock = high > 0 ? smoothstep(22, 32, h + big * 5) : smoothstep(26, 34, h + big * 3);
      const rockT = clamp01(smoothstep(0.75, 1.1, slope + big * 0.08) + highRock * (0.6 + high * 0.4) + ash * smoothstep(14, 22, h) + cry * smoothstep(0.6, 0.9, slope) * 0.5);
      out.copy(grass).lerp(sand, sandT).lerp(rock, rockT);

      // Snow caps on the high peaks, lying on the flatter faces.
      const snow = smoothstep(33, 39, h + big * 3) * (1 - smoothstep(0.9, 1.5, slope)) * (1 - ash);
      out.lerp(C.snow, snow);
      // Ash: dark cinder fields near the volcano, faintly warm in the cracks.
      if (ash > 0) {
        // Basalt flanks with pale ash streaks; scorched red-brown near the summit.
        out.lerp(C.ash, ash * smoothstep(0.1, 0.8, big * 0.5 + 0.5 + (h - 10) * 0.03) * 0.7);
        out.lerp(tmp.setRGB(0.55, 0.52, 0.5), ash * smoothstep(0.55, 0.8, n2.noise(x * 0.05, z * 0.2) * 0.5 + 0.5) * smoothstep(12, 26, h) * 0.45);
        out.lerp(C.ember, ash * smoothstep(26, 34, h) * 0.35);
      }
      if (cry > 0) out.lerp(C.crystal, cry * smoothstep(0.55, 0.9, n2.noise(x * 0.07, z * 0.07) * 0.5 + 0.5) * 0.25);

      // Muddy, darker banks along lakes and rivers.
      const wl = terrain.waterLevel[i]!;
      if (wl > NO_WATER || terrain.riverMask[i]) {
        const bank = 1 - smoothstep((wl > NO_WATER ? wl : h) + 0.05, (wl > NO_WATER ? wl : h) + 0.6, h);
        out.lerp(C.mud, bank * 0.7);
      } else if (h > 0.5) {
        // Check a little around for water edges (river banks are narrow).
        const near = terrain.waterLevelAt(x + 2, z) > NO_WATER || terrain.waterLevelAt(x - 2, z) > NO_WATER || terrain.waterLevelAt(x, z + 2) > NO_WATER || terrain.waterLevelAt(x, z - 2) > NO_WATER;
        if (near) out.lerp(acc.copy(C.mud).lerp(grass, 0.4), 0.45);
      }
      colors[i * 3] = out.r;
      colors[i * 3 + 1] = out.g;
      colors[i * 3 + 2] = out.b;
    }
  }
  return colors;
}

/** One chunk of the heightfield at a given vertex stride, with skirts on all four edges. */
function buildChunk(terrain: Terrain, colors: Float32Array, x0: number, z0: number, quads: number, stride: number): BufferGeometry {
  const res = terrain.res;
  const cell = terrain.cell;
  const n = quads / stride + 1;
  const vCount = n * n + n * 4;
  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const idx: number[] = [];
  const put = (v: number, ix: number, iz: number, drop: number) => {
    const i = iz * res + ix;
    positions[v * 3] = ix * cell - WORLD_HALF;
    positions[v * 3 + 1] = terrain.heights[i]! - drop;
    positions[v * 3 + 2] = iz * cell - WORLD_HALF;
    const hl = terrain.sample(ix - stride, iz);
    const hr = terrain.sample(ix + stride, iz);
    const hd = terrain.sample(ix, iz - stride);
    const hu = terrain.sample(ix, iz + stride);
    let nx = hl - hr;
    let ny = 2 * cell * stride;
    let nz = hd - hu;
    const nl = Math.hypot(nx, ny, nz);
    nx /= nl;
    ny /= nl;
    nz /= nl;
    normals[v * 3] = nx;
    normals[v * 3 + 1] = ny;
    normals[v * 3 + 2] = nz;
    col[v * 3] = colors[i * 3]!;
    col[v * 3 + 1] = colors[i * 3 + 1]!;
    col[v * 3 + 2] = colors[i * 3 + 2]!;
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) put(j * n + i, x0 + i * stride, z0 + j * stride, 0);
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      const h00 = positions[a * 3 + 1]!;
      const h11 = positions[d * 3 + 1]!;
      const h10 = positions[b * 3 + 1]!;
      const h01 = positions[c * 3 + 1]!;
      if (Math.abs(h00 - h11) < Math.abs(h10 - h01)) idx.push(a, c, d, a, d, b);
      else idx.push(a, c, b, b, c, d);
    }
  }
  // Skirts: a strip hanging down from each edge hides cracks against coarser neighbours.
  const drop = 2.5 * stride;
  const edges: Array<Array<number>> = [
    Array.from({ length: n }, (_, i) => i),
    Array.from({ length: n }, (_, i) => (n - 1) * n + i),
    Array.from({ length: n }, (_, j) => j * n),
    Array.from({ length: n }, (_, j) => j * n + n - 1),
  ];
  let v = n * n;
  edges.forEach((edge, e) => {
    const start = v;
    for (const top of edge) {
      const ix = x0 + (top % n) * stride;
      const iz = z0 + Math.floor(top / n) * stride;
      put(v++, ix, iz, drop);
    }
    for (let k = 0; k < n - 1; k++) {
      const t0 = edge[k]!;
      const t1 = edge[k + 1]!;
      const b0 = start + k;
      const b1 = start + k + 1;
      if (e === 0 || e === 3) idx.push(t0, t1, b0, t1, b1, b0);
      else idx.push(t0, b0, t1, t1, b0, b1);
    }
  });
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('normal', new BufferAttribute(normals, 3));
  geo.setAttribute('color', new BufferAttribute(col, 3));
  geo.setIndex(new BufferAttribute(vCount > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}
