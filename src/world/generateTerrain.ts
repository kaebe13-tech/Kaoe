import { Simplex2 } from '../core/noise';
import { Rng } from '../core/rng';
import { clamp01, lerp, smoothstep, TAU, type V2 } from '../core/math';
import { HEIGHT_RES, WORLD_HALF, WORLD_SIZE } from './config';
import { NO_WATER, Terrain, type Pond } from './Terrain';
import { Biome, type BiomeId, type Landmark, type LandmarkKind, type Region, type River } from './biomes';

export interface CivSite extends V2 {
  biome: BiomeId;
  region: number;
}

export interface TerrainGenResult {
  terrain: Terrain;
  /** Homeland of the first civilization (kept for older call sites). */
  start: V2;
  /** Highest peak. */
  mountain: V2;
  /** Homelands for civilizations, in order of preference. */
  sites: CivSite[];
}

// ---------------------------------------------------------------------------
// The world template. Geography is authored in "template space" so every world has
// readable landforms (a mountain spine, a central valley, an old forest, a volcano),
// then rotated/mirrored per seed and roughened with noise so no two worlds match.
// ---------------------------------------------------------------------------

interface Lobe {
  u: number;
  v: number;
  rx: number;
  ry: number;
}

const LOBES: Lobe[] = [
  { u: 0, v: 0, rx: 215, ry: 190 },
  { u: -120, v: 95, rx: 140, ry: 120 },
  { u: 150, v: 55, rx: 110, ry: 135 },
  { u: 20, v: -140, rx: 175, ry: 122 },
];
const ISLES = [
  { u: 185, v: 212, r: 30, sandbar: true },
  { u: -250, v: -150, r: 24, sandbar: false },
  { u: 58, v: 262, r: 19, sandbar: false },
];
const SPINE: Array<[number, number]> = [
  [-195, -78],
  [-115, -138],
  [-15, -162],
  [88, -150],
  [178, -96],
];
const GREEN = { u: 5, v: 55 };
const FOREST = { u: -165, v: 100 };
const CRYSTAL = { u: -40, v: -218, r: 44 };
const VOLCANO = { u: 192, v: 38 };
const ASHEN = { u: 168, v: 92 };

const RIVER_PATHS: Array<Array<[number, number]>> = [
  [
    [-8, -132],
    [8, -80],
    [-10, -20],
    [14, 40],
    [-6, 110],
    [30, 170],
    [42, 230],
  ],
  [
    [-150, -96],
    [-168, -40],
    [-150, 10],
    [-195, 60],
    [-230, 110],
    [-275, 128],
  ],
  [
    [98, -118],
    [112, -70],
    [150, -48],
    [205, -38],
    [262, -30],
  ],
];

const NAMES = {
  green: ['Greenheart Vale', 'the Greenheart', 'Meadowmere Vale'],
  forest: ['the Elderwood', 'the Oldgrove', 'Mossdeep Forest'],
  highlands: ['the Greyspine', 'the Stormcrest Heights', 'the Hollow Peaks'],
  crystal: ['the Crystal Wilds', 'the Shimmering Wilds', 'the Glass Moor'],
  ashen: ['the Ashen Reach', 'the Cinderlands', 'the Emberwaste'],
  isles: ['the Sunward Isles', 'the Gull Isles', 'the Far Isles'],
  rivers: [
    ['the Silverrun', 'the Brightwater', 'the Long River'],
    ['the Mosswater', 'the Shadeflow', 'the Fernbrook'],
    ['the Ashwater', 'the Cinderbrook', 'the Eastrun'],
  ],
};

class Xform {
  private readonly c: number;
  private readonly s: number;
  constructor(
    angle: number,
    private readonly mirror: boolean,
  ) {
    this.c = Math.cos(angle);
    this.s = Math.sin(angle);
  }

  toWorld(u: number, v: number): V2 {
    const uu = this.mirror ? -u : u;
    return { x: uu * this.c - v * this.s, z: uu * this.s + v * this.c };
  }

  toTemplate(x: number, z: number): { u: number; v: number } {
    const uu = x * this.c + z * this.s;
    const v = -x * this.s + z * this.c;
    return { u: this.mirror ? -uu : uu, v };
  }
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { d: number; t: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  let t = ((px - ax) * dx + (pz - az) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + dx * t - px;
  const z = az + dz * t - pz;
  return { d: Math.sqrt(x * x + z * z), t };
}

function polyDist(u: number, v: number, pts: Array<[number, number]>): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    best = Math.min(best, segDist(u, v, a[0], a[1], b[0], b[1]).d);
  }
  return best;
}

/** Catmull-Rom resample of a polyline every `step` units, with lateral meander noise. */
function resample(pts: V2[], step: number, meander: Simplex2, amp: number): V2[] {
  const out: V2[] = [];
  const P = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))]!;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    const len = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const n = Math.max(2, Math.ceil(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const z = 0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
      out.push({ x, z });
    }
  }
  out.push({ ...pts[pts.length - 1]! });
  // Lateral meander: displace along the local normal with smooth noise.
  const res: V2[] = [];
  let s = 0;
  for (let i = 0; i < out.length; i++) {
    const a = out[Math.max(0, i - 1)]!;
    const b = out[Math.min(out.length - 1, i + 1)]!;
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    if (i > 0) s += Math.hypot(out[i]!.x - out[i - 1]!.x, out[i]!.z - out[i - 1]!.z);
    const fade = Math.min(1, i / 8, (out.length - 1 - i) / 8);
    const m = meander.fbm(s * 0.012, 3.7, 2) * amp * fade;
    res.push({ x: out[i]!.x + (-tz / tl) * m, z: out[i]!.z + (tx / tl) * m });
  }
  return res;
}

export function generateTerrain(seed: number): TerrainGenResult {
  const rng = new Rng(seed ^ 0x5eed1234);
  const nHills = new Simplex2(seed ^ 0xa11ce);
  const nWarp = new Simplex2(seed ^ 0xb0b);
  const nMoist = new Simplex2(seed ^ 0xc0ffee);
  const nRidge = new Simplex2(seed ^ 0xd00d);
  const nCoast = new Simplex2(seed ^ 0xe1e1);
  const nDetail = new Simplex2(seed ^ 0xf00f);
  const nBiome = new Simplex2(seed ^ 0x1b10e);

  const xf = new Xform(rng.range(0, TAU), rng.chance(0.5));
  const res = HEIGHT_RES;
  const cell = WORLD_SIZE / (res - 1);
  const N = res * res;
  const heights = new Float32Array(N);
  const moisture = new Float32Array(N);
  const coastDist = new Float32Array(N);
  const biome = new Uint8Array(N);
  const waterLevel = new Float32Array(N).fill(NO_WATER);
  const riverMask = new Uint8Array(N);
  const spineDist = new Float32Array(N);

  // Jitter the authored features a little per seed.
  const jit = (p: { u: number; v: number }, a: number) => ({ u: p.u + rng.range(-a, a), v: p.v + rng.range(-a, a) });
  const green = jit(GREEN, 15);
  const forest = jit(FOREST, 15);
  const crystal = { ...jit(CRYSTAL, 8), r: CRYSTAL.r };
  const volcano = jit(VOLCANO, 10);
  const ashen = jit(ASHEN, 10);
  const spine = SPINE.map(([u, v]) => [u + rng.range(-10, 10), v + rng.range(-12, 12)] as [number, number]);

  // ---- 1. Base landforms --------------------------------------------------
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const x = ix * cell - WORLD_HALF;
      const z = iz * cell - WORLD_HALF;
      const i = iz * res + ix;
      const { u, v } = xf.toTemplate(x, z);
      // Domain warp: organic coastline with bays and headlands.
      const wu = u + 30 * nWarp.fbm(u * 0.006, v * 0.006, 3) + 7 * nWarp.noise(u * 0.03 + 9, v * 0.03);
      const wv = v + 30 * nWarp.fbm(u * 0.006 + 41.3, v * 0.006 - 17.9, 3) + 7 * nWarp.noise(u * 0.03, v * 0.03 - 5);
      let c = -Infinity;
      for (const L of LOBES) {
        const e = 1 - Math.hypot((wu - L.u) / L.rx, (wv - L.v) / L.ry);
        c = Math.max(c, e * Math.min(L.rx, L.ry));
      }
      for (const I of ISLES) {
        const e = (1 - Math.hypot(wu - I.u, wv - I.v) / I.r) * I.r;
        c = Math.max(c, e);
      }
      coastDist[i] = c;

      const ds = polyDist(u, v, spine);
      spineDist[i] = ds;
      const dGreen = Math.hypot(u - green.u, v - green.v);
      const dVol = Math.hypot(u - volcano.u, v - volcano.v);
      const dCry = Math.hypot(u - crystal.u, v - crystal.v) + nWarp.noise(u * 0.04, v * 0.04) * 8;

      // Rolling lowlands, flatter and greener toward the valley heart.
      const hills = nHills.fbm(u * 0.0065, v * 0.0065, 4) * 0.5 + 0.5;
      let land = 2.2 + hills * 8 + nHills.fbm(u * 0.025, v * 0.025, 2) * 1.1;
      const flat = 1 - smoothstep(50, 150, dGreen);
      land = lerp(land, 2.4 + hills * 3.2, flat * 0.75);

      // The mountain spine: ridged peaks with foothills and a few natural passes.
      const m = 1 - smoothstep(16, 115, ds);
      const ridge = nRidge.ridged(u * 0.0105, v * 0.0105, 5);
      const pass = smoothstep(0.35, 0.65, nRidge.noise(u * 0.004 + 3.3, v * 0.004));
      land += m * m * (12 + ridge * 34) * lerp(0.55, 1, pass) + m * 4;

      // The sleeping volcano and its ash field.
      if (dVol < 110) {
        const k = 1 - smoothstep(0, 95, dVol);
        const rim = 38 * Math.pow(1 - smoothstep(0, 95, 13), 1.9);
        let cone = dVol < 13 ? rim : 38 * Math.pow(k, 1.9);
        // Flat-floored crater (a lava lake) inside a jagged rim.
        if (dVol < 13) cone = rim - 5.5 * smoothstep(13, 9, dVol) + (dVol > 11 ? nDetail.noise(u * 0.3, v * 0.3) * 1.2 : 0);
        // Old lava channels down the flanks.
        const channel = Math.abs(nRidge.noise(Math.atan2(v - volcano.v, u - volcano.u) * 3, 0.5));
        cone -= smoothstep(0.08, 0.0, channel) * 1.4 * k * (dVol > 15 ? 1 : 0);
        land += cone + nDetail.noise(u * 0.08, v * 0.08) * 0.8 * k;
      }

      // Crystal plateau: raised table land with steep edges.
      if (dCry < crystal.r * 1.6) {
        const pm = 1 - smoothstep(crystal.r * 0.82, crystal.r * 1.12, dCry);
        const top = 15 + nHills.fbm(u * 0.03, v * 0.03, 2) * 1.6;
        land = lerp(land, Math.max(land, top), pm);
      }

      // Small-scale roughness, stronger on high ground.
      land += nDetail.fbm(u * 0.06, v * 0.06, 2) * (0.25 + m * 1.1);
      // Terraced rock on the highest slopes reads as strata.
      if (land > 14) {
        const step = 2.2;
        const tq = Math.floor(land / step) * step + smoothstep(0.3, 0.7, (land % step) / step) * step;
        land = lerp(land, tq, 0.35 * smoothstep(14, 22, land));
      }

      let h: number;
      const coastN = nCoast.fbm(u * 0.012, v * 0.012, 2) * 0.5 + 0.5;
      if (c < 0) {
        const off = -c;
        h = -2.2 * smoothstep(0, 10, off) - 11 * smoothstep(6, 34, off);
        h += nHills.noise(u * 0.04, v * 0.04) * 0.35 * clamp01(off / 10) * (1 - smoothstep(20, 34, off));
      } else {
        // Cliffs where the highlands or the ash field meet the sea.
        const cliff = smoothstep(0.6, 0.78, coastN + m * 0.4 + (dVol < 120 ? 0.2 : 0));
        const beachWidth = lerp(lerp(4, 11, coastN), 1.3, cliff);
        const beach = Math.min(c, beachWidth) * lerp(0.12, 0.55, cliff);
        const inland = smoothstep(beachWidth * 0.5, beachWidth + lerp(30, 7, cliff), c);
        h = beach + inland * land;
      }
      heights[i] = h;
      moisture[i] = nMoist.fbm(u * 0.012 + 7.7, v * 0.012 - 3.1, 3) * 0.5 + 0.5;

      // ---- Biome ----
      let b: BiomeId;
      const bn = nBiome.fbm(u * 0.01, v * 0.01, 2) * 28;
      const isIsle = ISLES.some((I) => Math.hypot(u - I.u, v - I.v) < I.r * 1.6);
      if (h < 0.05) b = Biome.Ocean;
      else if (dCry < crystal.r * 1.15 + bn * 0.3) b = Biome.CrystalWilds;
      else if (Math.hypot(u - ashen.u, v - ashen.v) + bn < 105 || dVol < 70) b = Biome.Ashen;
      else if (isIsle) b = Biome.Isles;
      else if (h > 16 || ds + bn < 42) b = Biome.Highlands;
      else if (c < 12 && h < 2.4) b = Biome.Coast;
      else {
        const df = Math.hypot(u - forest.u, v - forest.v) + bn;
        const dg = Math.hypot(u - green.u, v - green.v) - bn;
        b = df < 128 && df * 1.05 < dg ? Biome.Elderwood : Biome.Greenheart;
      }
      biome[i] = b;
    }
  }

  const idx = (x: number, z: number): number => {
    const ix = Math.round((x + WORLD_HALF) / cell);
    const iz = Math.round((z + WORLD_HALF) / cell);
    if (ix < 0 || iz < 0 || ix >= res || iz >= res) return -1;
    return iz * res + ix;
  };
  const sampleH = (x: number, z: number): number => {
    const i = idx(x, z);
    return i < 0 ? -10 : heights[i]!;
  };
  const sampleC = (x: number, z: number): number => {
    const i = idx(x, z);
    return i < 0 ? -99 : coastDist[i]!;
  };

  // ---- 2. Sandbar to the largest isle (a tidal causeway explorers can walk) ------
  for (const I of ISLES) {
    if (!I.sandbar) continue;
    const isle = xf.toWorld(I.u, I.v);
    // Walk toward the continent centre until we reach land.
    let shore: V2 | null = null;
    const dx = -isle.x;
    const dz = -isle.z;
    const dl = Math.hypot(dx, dz) || 1;
    for (let d = I.r * 0.6; d < 180; d += 1) {
      const x = isle.x + (dx / dl) * d;
      const z = isle.z + (dz / dl) * d;
      if (sampleC(x, z) > 6 && sampleH(x, z) > 1.2) {
        shore = { x, z };
        break;
      }
    }
    if (!shore) continue;
    const ax = isle.x;
    const az = isle.z;
    const bx = shore.x;
    const bz = shore.z;
    const len = Math.hypot(bx - ax, bz - az);
    const x0 = Math.min(ax, bx) - 10;
    const x1 = Math.max(ax, bx) + 10;
    const z0 = Math.min(az, bz) - 10;
    const z1 = Math.max(az, bz) + 10;
    for (let iz = Math.max(0, Math.floor((z0 + WORLD_HALF) / cell)); iz <= Math.min(res - 1, Math.ceil((z1 + WORLD_HALF) / cell)); iz++) {
      for (let ix = Math.max(0, Math.floor((x0 + WORLD_HALF) / cell)); ix <= Math.min(res - 1, Math.ceil((x1 + WORLD_HALF) / cell)); ix++) {
        const x = ix * cell - WORLD_HALF;
        const z = iz * cell - WORLD_HALF;
        const { d, t } = segDist(x, z, ax, az, bx, bz);
        const wob = nDetail.noise(t * len * 0.05, 1.3) * 2;
        const w = 4.5 + wob;
        if (d > w + 6) continue;
        const i = iz * res + ix;
        const bar = 0.42 + nDetail.noise(x * 0.2, z * 0.2) * 0.08 - smoothstep(w, w + 6, d) * 1.6;
        if (bar > heights[i]!) heights[i] = bar;
        if (d < w + 2 && biome[i] === Biome.Ocean) biome[i] = Biome.Coast;
      }
    }
  }

  // ---- 3. Rivers ------------------------------------------------------------
  const meander = new Simplex2(seed ^ 0x9a11);
  const rivers: River[] = [];
  const riverDist = new Float32Array(N).fill(Infinity);
  const riverS = new Float32Array(N);
  const riverOf = new Int8Array(N).fill(-1);
  RIVER_PATHS.forEach((path, ri) => {
    const pts = resample(
      path.map(([u, v]) => xf.toWorld(u + rng.range(-6, 6), v + rng.range(-6, 6))),
      2,
      meander,
      9,
    );
    // Extend into the sea so the mouth always opens onto open water.
    const last = pts[pts.length - 1]!;
    const prev = pts[pts.length - 4] ?? pts[0]!;
    const ex = last.x - prev.x;
    const ez = last.z - prev.z;
    const el = Math.hypot(ex, ez) || 1;
    for (let k = 1; k <= 30; k++) {
      const p = { x: last.x + (ex / el) * k * 2, z: last.z + (ez / el) * k * 2 };
      pts.push(p);
      if (sampleH(p.x, p.z) < -1.2) break;
    }
    // Water level: follows the land down, never rising (running minimum), reaching the sea at the mouth.
    const levels: number[] = [];
    let lv = sampleH(pts[0]!.x, pts[0]!.z) - 0.8;
    for (let k = 0; k < pts.length; k++) {
      const h = sampleH(pts[k]!.x, pts[k]!.z);
      lv = Math.min(lv - 0.006, h - 0.55);
      levels.push(lv);
    }
    // Smooth the profile while keeping it monotonic.
    for (let pass = 0; pass < 6; pass++) {
      for (let k = 1; k < levels.length - 1; k++) levels[k] = (levels[k - 1]! + levels[k]! * 2 + levels[k + 1]!) / 4;
      for (let k = 1; k < levels.length; k++) levels[k] = Math.min(levels[k]!, levels[k - 1]! - 0.004);
    }
    const n = pts.length;
    const river: River = {
      id: ri,
      name: NAMES.rivers[ri]![rng.int(0, 2)]!,
      points: pts.map((p, k) => ({ x: p.x, z: p.z, level: Math.max(levels[k]!, k > n - 6 ? -0.2 : 0.05), width: lerp(1.6, 4.4, Math.pow(k / (n - 1), 0.8)) })),
    };
    rivers.push(river);
    // Distance field to this river (banded rasterisation per segment).
    const band = 48;
    let s = 0;
    for (let k = 0; k < n - 1; k++) {
      const a = river.points[k]!;
      const b = river.points[k + 1]!;
      const segLen = Math.hypot(b.x - a.x, b.z - a.z);
      const ix0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - band + WORLD_HALF) / cell));
      const ix1 = Math.min(res - 1, Math.ceil((Math.max(a.x, b.x) + band + WORLD_HALF) / cell));
      const iz0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - band + WORLD_HALF) / cell));
      const iz1 = Math.min(res - 1, Math.ceil((Math.max(a.z, b.z) + band + WORLD_HALF) / cell));
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = ix * cell - WORLD_HALF;
          const z = iz * cell - WORLD_HALF;
          const r = segDist(x, z, a.x, a.z, b.x, b.z);
          const i = iz * res + ix;
          if (r.d < riverDist[i]!) {
            riverDist[i] = r.d;
            riverS[i] = k + r.t;
            riverOf[i] = ri;
          }
        }
      }
      s += segLen;
    }
    void s;
  });

  // Carve channels, banks and wide valleys.
  for (let i = 0; i < N; i++) {
    const ri = riverOf[i]!;
    if (ri < 0) continue;
    const river = rivers[ri]!;
    const d = riverDist[i]!;
    const k = riverS[i]!;
    const k0 = Math.floor(k);
    const p0 = river.points[Math.min(k0, river.points.length - 1)]!;
    const p1 = river.points[Math.min(k0 + 1, river.points.length - 1)]!;
    const f = k - k0;
    const L = lerp(p0.level, p1.level, f);
    const w = lerp(p0.width, p1.width, f);
    const h0 = heights[i]!;
    const valleyW = lerp(22, 44, clamp01((h0 - L) / 14));
    if (d > w + valleyW) continue;
    let h: number;
    if (d < w) {
      const t = d / w;
      const depth = 0.75 + w * 0.08;
      h = L - depth * (1 - t * t) - 0.06;
    } else {
      const e = d - w;
      const wall = L + 0.18 + e * 0.12 + Math.pow(e / valleyW, 2) * Math.max(0, h0 - L) * 1.1;
      h = Math.max(L + 0.14, Math.min(h0, wall));
      h = lerp(h, Math.max(h0, L + 0.14), smoothstep(valleyW * 0.7, valleyW, e));
    }
    // Never raise the sea floor at the mouth.
    heights[i] = h0 < 0 && L < 0.1 ? Math.min(h0, h) : h;
    if (d < w + 0.9 && L > -0.1) {
      waterLevel[i] = L;
      riverMask[i] = 1;
    }
    moisture[i] = clamp01(moisture[i]! + (1 - smoothstep(w, w + 26, d)) * 0.45);
  }

  // ---- 4. Lakes -----------------------------------------------------------
  const ponds: Pond[] = [];
  const lakeAnchors: Array<{ u: number; v: number; r: number; magic?: boolean }> = [
    { u: -45, v: 18, r: 14 },
    { u: 72, v: 112, r: 9 },
    { u: -92, v: -112, r: 10 },
    { u: -128, v: 150, r: 11 },
    { u: -62, v: -200, r: 7 },
    { u: 150, v: 124, r: 6 },
    { u: 98, v: -62, r: 10 },
    { u: 60, v: 30, r: 7 },
    { u: -210, v: 20, r: 8 },
  ];
  for (const la of lakeAnchors) {
    const c0 = xf.toWorld(la.u, la.v);
    let best: { x: number; z: number; score: number } | null = null;
    for (let k = 0; k < 60; k++) {
      const a = rng.range(0, TAU);
      const d = Math.sqrt(rng.next()) * 26;
      const x = c0.x + Math.cos(a) * d;
      const z = c0.z + Math.sin(a) * d;
      const h = sampleH(x, z);
      if (sampleC(x, z) < la.r + 16 || h < 1.6) continue;
      const i = idx(x, z);
      if (i >= 0 && riverDist[i]! < la.r * 1.6 + 14) continue;
      if (ponds.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius + la.r + 30)) continue;
      let maxDev = 0;
      for (let q = 0; q < 12; q++) {
        const aa = (q / 12) * TAU;
        maxDev = Math.max(maxDev, Math.abs(sampleH(x + Math.cos(aa) * la.r * 1.3, z + Math.sin(aa) * la.r * 1.3) - h));
      }
      const score = -maxDev * 2 - d * 0.05;
      if (maxDev < 4.5 && (!best || score > best.score)) best = { x, z, score };
    }
    if (!best) continue;
    const radius = la.r * rng.range(0.9, 1.1);
    ponds.push({ id: ponds.length, x: best.x, z: best.z, radius, level: sampleH(best.x, best.z) - 0.35 });
  }
  for (const p of ponds) carvePond(p, heights, res, cell, rng.int(0, 1_000_000));
  for (const p of ponds) {
    const outer = p.radius * 1.7;
    for (let iz = Math.max(0, Math.floor((p.z - outer + WORLD_HALF) / cell)); iz <= Math.min(res - 1, Math.ceil((p.z + outer + WORLD_HALF) / cell)); iz++) {
      for (let ix = Math.max(0, Math.floor((p.x - outer + WORLD_HALF) / cell)); ix <= Math.min(res - 1, Math.ceil((p.x + outer + WORLD_HALF) / cell)); ix++) {
        const i = iz * res + ix;
        const x = ix * cell - WORLD_HALF;
        const z = iz * cell - WORLD_HALF;
        const d = Math.hypot(x - p.x, z - p.z);
        if (d < p.radius * 1.6 && heights[i]! < p.level + 0.05) {
          waterLevel[i] = p.level;
          riverMask[i] = 0;
        }
        moisture[i] = clamp01(moisture[i]! + (1 - smoothstep(p.radius, p.radius * 3, d)) * 0.3);
      }
    }
  }

  // ---- 5. Moisture by biome -----------------------------------------------
  for (let i = 0; i < N; i++) {
    const b = biome[i]!;
    let m = moisture[i]!;
    if (b === Biome.Elderwood) m = m * 0.5 + 0.5;
    else if (b === Biome.Ashen) m *= 0.45;
    else if (b === Biome.Highlands) m = m * 0.8 + 0.05;
    else if (b === Biome.CrystalWilds) m = m * 0.6 + 0.25;
    moisture[i] = clamp01(m * smoothstep(-2, 12, coastDist[i]!) + (b === Biome.Elderwood ? 0.1 : 0));
  }

  const terrain = new Terrain(heights, moisture, ponds, biome, waterLevel, riverMask);
  terrain.rivers = rivers;

  // ---- 6. Regions (named places) ---------------------------------------------
  const regions: Region[] = [];
  const addRegion = (b: BiomeId, names: string[], u: number, v: number, radius: number) => {
    const p = xf.toWorld(u, v);
    regions.push({ id: regions.length, biome: b, name: names[rng.int(0, names.length - 1)]!, x: p.x, z: p.z, radius });
  };
  addRegion(Biome.Greenheart, NAMES.green, green.u, green.v, 130);
  addRegion(Biome.Elderwood, NAMES.forest, forest.u, forest.v, 110);
  addRegion(Biome.Highlands, NAMES.highlands, spine[2]![0], spine[2]![1] + 20, 170);
  addRegion(Biome.CrystalWilds, NAMES.crystal, crystal.u, crystal.v, 50);
  addRegion(Biome.Ashen, NAMES.ashen, ashen.u, ashen.v, 95);
  addRegion(Biome.Isles, NAMES.isles, ISLES[0]!.u, ISLES[0]!.v, 40);
  terrain.regions = regions;

  // ---- 7. Landmarks ----------------------------------------------------------
  const landmarks: Landmark[] = [];
  const flatSpot = (u: number, v: number, radius: number, search: number, opts: { high?: boolean; minH?: number } = {}): V2 | null => {
    const c0 = xf.toWorld(u, v);
    let best: V2 | null = null;
    let bestS = -Infinity;
    for (let k = 0; k < 120; k++) {
      const a = rng.range(0, TAU);
      const d = Math.sqrt(rng.next()) * search;
      const x = c0.x + Math.cos(a) * d;
      const z = c0.z + Math.sin(a) * d;
      const h = sampleH(x, z);
      if (h < (opts.minH ?? 1.6) || terrain.isWater(x, z)) continue;
      const i = idx(x, z);
      if (i >= 0 && riverDist[i]! < radius + 6) continue;
      if (ponds.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius * 1.6 + radius + 3)) continue;
      if (landmarks.some((l) => Math.hypot(l.x - x, l.z - z) < 40)) continue;
      let dev = 0;
      for (let q = 0; q < 8; q++) {
        const aa = (q / 8) * TAU;
        dev = Math.max(dev, Math.abs(sampleH(x + Math.cos(aa) * radius, z + Math.sin(aa) * radius) - h));
      }
      const s = -dev * 3 - d * 0.02 + (opts.high ? h * 0.3 : 0);
      if (dev < radius * 0.5 + 1 && s > bestS) {
        bestS = s;
        best = { x, z };
      }
    }
    return best;
  };
  const addLandmark = (kind: LandmarkKind, name: string, p: V2 | null, block: number, sight: number) => {
    if (!p) return;
    const region = terrain.regionAt(p.x, p.z);
    landmarks.push({ id: landmarks.length + 1, kind, name, x: p.x, z: p.z, rot: rng.range(0, TAU), block, sight, region: region?.id ?? 0 });
  };
  addLandmark('greatTree', 'the Great Tree', flatSpot(forest.u - 12, forest.v + 18, 5, 30), 2.4, 60);
  addLandmark('temple', 'the Forgotten Temple', flatSpot(forest.u - 55, forest.v - 40, 6, 30), 0, 26);
  addLandmark('stoneCircle', 'the Standing Stones', flatSpot(green.u + 70, green.v - 45, 6, 35, { high: true }), 0, 40);
  addLandmark('spring', 'the Moonwell', flatSpot((green.u + forest.u) / 2, (green.v + forest.v) / 2 + 55, 3, 30), 0, 22);
  addLandmark('ruinedTower', 'the Old Watchtower', flatSpot(spine[3]![0] - 10, spine[3]![1] + 55, 3, 30, { high: true, minH: 6 }), 2.2, 70);
  addLandmark('floatingRocks', 'the Drifting Stones', flatSpot(crystal.u, crystal.v, 5, 16, { minH: 8 }), 0, 60);
  addLandmark('crystalSpire', 'the Crystal Spire', flatSpot(crystal.u + 22, crystal.v + 12, 3, 16, { minH: 8 }), 1.6, 45);
  addLandmark('titanBones', "the Titan's Bones", flatSpot(ashen.u - 30, ashen.v - 50, 6, 30), 0, 40);
  addLandmark('volcano', 'the Fire Mountain', (() => {
    const p = xf.toWorld(volcano.u, volcano.v);
    return { x: p.x, z: p.z };
  })(), 0, 120);
  addLandmark('statue', 'the Watcher', flatSpot(ISLES[0]!.u, ISLES[0]!.v, 3, 14, { minH: 1.4 }), 1.6, 60);
  terrain.landmarks = landmarks;
  // The Moonwell is a small magical pool.
  const well = landmarks.find((l) => l.kind === 'spring');
  if (well) {
    const p: Pond = { id: ponds.length, x: well.x, z: well.z, radius: 2.6, level: sampleH(well.x, well.z) - 0.2, magic: true };
    ponds.push(p);
    carvePond(p, heights, res, cell, 77);
    const outer = p.radius * 1.7;
    for (let iz = Math.floor((p.z - outer + WORLD_HALF) / cell); iz <= Math.ceil((p.z + outer + WORLD_HALF) / cell); iz++) {
      for (let ix = Math.floor((p.x - outer + WORLD_HALF) / cell); ix <= Math.ceil((p.x + outer + WORLD_HALF) / cell); ix++) {
        if (ix < 0 || iz < 0 || ix >= res || iz >= res) continue;
        const i = iz * res + ix;
        const d = Math.hypot(ix * cell - WORLD_HALF - p.x, iz * cell - WORLD_HALF - p.z);
        if (d < p.radius * 1.6 && heights[i]! < p.level + 0.05) waterLevel[i] = p.level;
      }
    }
  }

  // ---- 8. Civilization homelands --------------------------------------------
  const siteAnchors: Array<{ u: number; v: number; b: BiomeId }> = [
    { u: green.u + 28, v: green.v + 18, b: Biome.Greenheart },
    { u: forest.u + 18, v: forest.v - 12, b: Biome.Elderwood },
    { u: -118, v: -104, b: Biome.Highlands },
    { u: ashen.u + 8, v: ashen.v + 55, b: Biome.Ashen },
    { u: crystal.u + 10, v: crystal.v + 4, b: Biome.CrystalWilds },
  ];
  const sites: CivSite[] = [];
  for (const sa of siteAnchors) {
    const c0 = xf.toWorld(sa.u, sa.v);
    let best: V2 | null = null;
    let bestS = -Infinity;
    for (let k = 0; k < 260; k++) {
      const a = rng.range(0, TAU);
      const d = Math.sqrt(rng.next()) * 45;
      const x = c0.x + Math.cos(a) * d;
      const z = c0.z + Math.sin(a) * d;
      const h = terrain.heightAt(x, z);
      if (h < 1.5 || terrain.isWater(x, z)) continue;
      const slope = terrain.slopeAt(x, z);
      if (slope > 0.22) continue;
      // Water within a comfortable walk, but not on the bank itself.
      let water = Infinity;
      for (const p of ponds) water = Math.min(water, Math.hypot(p.x - x, p.z - z) - p.radius);
      const i = idx(x, z);
      if (i >= 0 && riverDist[i]! < Infinity) water = Math.min(water, riverDist[i]! - 3);
      if (water < 9 || water > 34) continue;
      if (landmarks.some((l) => Math.hypot(l.x - x, l.z - z) < 30)) continue;
      let dev = 0;
      for (let q = 0; q < 8; q++) {
        const aa = (q / 8) * TAU;
        dev = Math.max(dev, Math.abs(terrain.heightAt(x + Math.cos(aa) * 10, z + Math.sin(aa) * 10) - h));
      }
      const s = -slope * 20 - dev * 1.2 - Math.abs(water - 18) * 0.12 - d * 0.03;
      if (s > bestS) {
        bestS = s;
        best = { x, z };
      }
    }
    if (best) sites.push({ ...best, biome: sa.b, region: terrain.regionAt(best.x, best.z)?.id ?? 0 });
  }

  // Highest peak (for descriptions and the camera intro).
  let peak = 0;
  for (let i = 1; i < N; i++) if (heights[i]! > heights[peak]!) peak = i;
  const mountain = { x: (peak % res) * cell - WORLD_HALF, z: Math.floor(peak / res) * cell - WORLD_HALF };

  return { terrain, start: sites[0] ?? { x: 0, z: 0 }, mountain, sites };
}

function carvePond(p: Pond, heights: Float32Array, res: number, cell: number, noiseSeed: number): void {
  const n = new Simplex2(noiseSeed);
  const outer = p.radius * 2.4;
  const ix0 = Math.max(0, Math.floor((p.x - outer + WORLD_HALF) / cell));
  const ix1 = Math.min(res - 1, Math.ceil((p.x + outer + WORLD_HALF) / cell));
  const iz0 = Math.max(0, Math.floor((p.z - outer + WORLD_HALF) / cell));
  const iz1 = Math.min(res - 1, Math.ceil((p.z + outer + WORLD_HALF) / cell));
  const depth = 1.6 + p.radius * 0.08;
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = ix * cell - WORLD_HALF;
      const z = iz * cell - WORLD_HALF;
      const dx = x - p.x;
      const dz = z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > outer) continue;
      const ang = Math.atan2(dz, dx);
      const rn = p.radius * (1 + 0.2 * n.noise(Math.cos(ang) * 1.3, Math.sin(ang) * 1.3));
      const i = iz * res + ix;
      const h = heights[i]!;
      if (d < rn) {
        const t = d / rn;
        heights[i] = p.level - depth * (1 - t * t) - 0.05;
      } else {
        // Gentle shore that rises out of the water, blended back into natural terrain.
        const shore = p.level + 0.12 + (d - rn) * 0.16;
        const cap = shore + 1.8 * smoothstep(rn, rn * 1.9, d);
        const w = 1 - smoothstep(rn * 1.4, outer, d);
        let nh = lerp(h, Math.max(shore, Math.min(h, cap)), w);
        if (d < p.radius * 1.75) nh = Math.max(nh, p.level + 0.1 + (d - rn) * 0.05);
        heights[i] = nh;
      }
    }
  }
}
