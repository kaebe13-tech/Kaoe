import {
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Object3D,
  Vector3,
} from 'three';
import { clamp01, lerp, smoothstep } from '../core/math';

/** A keyframe of the day/night look. `hour` in [0, 24). */
interface LookKey {
  hour: number;
  zenith: number;
  horizon: number;
  sun: number;
  sunI: number;
  hemiSky: number;
  hemiGround: number;
  hemiI: number;
  fog: number;
}

const KEYS: LookKey[] = [
  { hour: 0, zenith: 0x08112b, horizon: 0x1a2748, sun: 0x9fb6ff, sunI: 0.42, hemiSky: 0x4a5f9a, hemiGround: 0x1d2030, hemiI: 0.62, fog: 0x17223f },
  { hour: 4.5, zenith: 0x0d1838, horizon: 0x2a3560, sun: 0x9fb6ff, sunI: 0.35, hemiSky: 0x4a5f9a, hemiGround: 0x1d2030, hemiI: 0.6, fog: 0x1f2b4c },
  { hour: 5.6, zenith: 0x2a3f7a, horizon: 0xc48a8a, sun: 0xff9f6a, sunI: 0.35, hemiSky: 0x7a86b8, hemiGround: 0x3a3238, hemiI: 0.7, fog: 0x8a7a8e },
  { hour: 6.6, zenith: 0x4f86c6, horizon: 0xffc08a, sun: 0xffb27a, sunI: 1.35, hemiSky: 0xa9c4e0, hemiGround: 0x6a5a48, hemiI: 1.0, fog: 0xe8c9a8 },
  { hour: 8.5, zenith: 0x4a98de, horizon: 0xcfe7f4, sun: 0xfff0d8, sunI: 2.35, hemiSky: 0xbfdcf2, hemiGround: 0x6f7a4a, hemiI: 1.2, fog: 0xc5e0ee },
  { hour: 12.5, zenith: 0x3c8fe2, horizon: 0xc9e6f6, sun: 0xfffaf0, sunI: 2.6, hemiSky: 0xc4e0f5, hemiGround: 0x74804c, hemiI: 1.25, fog: 0xc2e0f0 },
  { hour: 16.5, zenith: 0x4a8cd6, horizon: 0xf0dfc0, sun: 0xffe6b8, sunI: 2.3, hemiSky: 0xc0d6ea, hemiGround: 0x7a784a, hemiI: 1.15, fog: 0xe6dcc4 },
  { hour: 18.4, zenith: 0x5a6aab, horizon: 0xff9d5c, sun: 0xff8f4f, sunI: 1.55, hemiSky: 0xb0a0c0, hemiGround: 0x6a4a3a, hemiI: 0.95, fog: 0xe8a07a },
  { hour: 19.3, zenith: 0x2e3a78, horizon: 0xb4607a, sun: 0xff7050, sunI: 0.45, hemiSky: 0x6a6a9a, hemiGround: 0x3a2a30, hemiI: 0.72, fog: 0x7a5070 },
  { hour: 20.3, zenith: 0x121c44, horizon: 0x3a3c6a, sun: 0x9fb6ff, sunI: 0.32, hemiSky: 0x4a5f9a, hemiGround: 0x1d2030, hemiI: 0.62, fog: 0x283058 },
  { hour: 24, zenith: 0x08112b, horizon: 0x1a2748, sun: 0x9fb6ff, sunI: 0.42, hemiSky: 0x4a5f9a, hemiGround: 0x1d2030, hemiI: 0.62, fog: 0x17223f },
];

export const SUNRISE = 6.0;
export const SUNSET = 19.0;

export interface DayLook {
  hour: number;
  zenith: Color;
  horizon: Color;
  ground: Color;
  sunColor: Color;
  sunIntensity: number;
  hemiSky: Color;
  hemiGround: Color;
  hemiIntensity: number;
  fog: Color;
  /** Direction toward the main light (sun by day, moon by night). */
  lightDir: Vector3;
  sunDir: Vector3;
  moonDir: Vector3;
  sunVisible: number;
  starVisible: number;
  /** 0 at noon .. 1 at deep night; used by other systems (fire glow, windows). */
  darkness: number;
}

const ca = new Color();
const cb = new Color();

function mixKey(out: Color, a: number, b: number, t: number): Color {
  ca.set(a);
  cb.set(b);
  return out.copy(ca).lerp(cb, t);
}

export function sunDirection(hour: number, out: Vector3): Vector3 {
  // Sun travels east -> west; elevation peaks at solar noon.
  const t = (hour - SUNRISE) / (SUNSET - SUNRISE); // 0..1 during the day
  const ang = t * Math.PI;
  const elev = Math.sin(ang);
  out.set(Math.cos(ang) * 0.9, elev * 0.95 + 0.05 * (elev > 0 ? 1 : -1), 0.35 + Math.sin(ang) * 0.1);
  return out.normalize();
}

export class LightingRig {
  readonly sun = new DirectionalLight(0xffffff, 2.5);
  readonly hemi = new HemisphereLight(0xc4e0f5, 0x74804c, 1.2);
  readonly ambient = new AmbientLight(0xffffff, 0.12);
  readonly fog: Fog;
  readonly look: DayLook;
  private readonly target = new Object3D();
  private readonly shadowExtent = 55;

  constructor() {
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.left = -this.shadowExtent;
    cam.right = this.shadowExtent;
    cam.top = this.shadowExtent;
    cam.bottom = -this.shadowExtent;
    cam.near = 1;
    cam.far = 400;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;
    this.sun.target = this.target;
    this.fog = new Fog(0xc2e0f0, 160, 620);
    this.look = {
      hour: 12,
      zenith: new Color(),
      horizon: new Color(),
      ground: new Color(),
      sunColor: new Color(),
      sunIntensity: 1,
      hemiSky: new Color(),
      hemiGround: new Color(),
      hemiIntensity: 1,
      fog: new Color(),
      lightDir: new Vector3(),
      sunDir: new Vector3(),
      moonDir: new Vector3(),
      sunVisible: 1,
      starVisible: 0,
      darkness: 0,
    };
  }

  get objects(): Object3D[] {
    return [this.sun, this.hemi, this.ambient, this.target];
  }

  /** Compute the look for a given hour. `overcast` 0..1 dims and greys everything (rain). */
  update(hour: number, focus: Vector3, overcast: number): DayLook {
    const L = this.look;
    L.hour = hour;
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1]!.hour <= hour) i++;
    const a = KEYS[i]!;
    const b = KEYS[i + 1]!;
    const t = smoothstep(0, 1, clamp01((hour - a.hour) / (b.hour - a.hour)));
    mixKey(L.zenith, a.zenith, b.zenith, t);
    mixKey(L.horizon, a.horizon, b.horizon, t);
    mixKey(L.sunColor, a.sun, b.sun, t);
    mixKey(L.hemiSky, a.hemiSky, b.hemiSky, t);
    mixKey(L.hemiGround, a.hemiGround, b.hemiGround, t);
    mixKey(L.fog, a.fog, b.fog, t);
    L.sunIntensity = lerp(a.sunI, b.sunI, t);
    L.hemiIntensity = lerp(a.hemiI, b.hemiI, t);

    sunDirection(hour, L.sunDir);
    L.moonDir.copy(L.sunDir).multiplyScalar(-1);
    L.moonDir.y = Math.abs(L.moonDir.y) * 0.8 + 0.25;
    L.moonDir.normalize();
    const sunUp = smoothstep(-0.08, 0.12, L.sunDir.y);
    L.sunVisible = smoothstep(-0.12, 0.02, L.sunDir.y);
    L.starVisible = 1 - smoothstep(-0.2, 0.05, L.sunDir.y);
    L.darkness = 1 - smoothstep(-0.15, 0.3, L.sunDir.y);
    // Main light: sun while it is up, otherwise moon; fade through the horizon.
    if (sunUp > 0.001) {
      L.lightDir.copy(L.sunDir);
      if (L.lightDir.y < 0.12) L.lightDir.y = 0.12;
      L.lightDir.normalize();
      L.sunIntensity *= Math.max(sunUp, 0.15);
    } else {
      L.lightDir.copy(L.moonDir);
    }

    if (overcast > 0) {
      const grey = new Color(0x6e7c88);
      const k = overcast * 0.75;
      L.zenith.lerp(grey, k);
      L.horizon.lerp(grey.clone().offsetHSL(0, 0, 0.1), k);
      L.fog.lerp(grey, k * 0.9);
      L.hemiSky.lerp(grey, k * 0.6);
      L.sunIntensity *= 1 - overcast * 0.7;
      L.hemiIntensity *= 1 - overcast * 0.15;
      L.sunVisible *= 1 - overcast;
      L.starVisible *= 1 - overcast;
    }
    L.ground.copy(L.fog).multiplyScalar(0.55);

    this.sun.color.copy(L.sunColor);
    this.sun.intensity = L.sunIntensity;
    this.hemi.color.copy(L.hemiSky);
    this.hemi.groundColor.copy(L.hemiGround);
    this.hemi.intensity = L.hemiIntensity;
    this.fog.color.copy(L.fog);
    this.fog.near = lerp(160, 70, overcast);
    this.fog.far = lerp(620, 320, overcast);

    // Keep the shadow frustum centred on what the camera looks at, snapped to texels to avoid shimmer.
    const texel = (this.shadowExtent * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + L.lightDir.x * 150, focus.y + L.lightDir.y * 150, fz + L.lightDir.z * 150);
    this.target.updateMatrixWorld();
    return L;
  }
}
