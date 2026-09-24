import { Rng } from '../core/rng';
import { clamp01, smoothstep } from '../core/math';
import { DAY_LENGTH, HOUR, ISLAND_RADIUS } from '../world/config';

export interface RainCloud {
  id: number;
  x: number;
  z: number;
  radius: number;
  /** Current intensity 0..1 (ramps in and out). */
  intensity: number;
  /** Peak intensity. */
  peak: number;
  /** Seconds of rain left. */
  ttl: number;
  vx: number;
  vz: number;
  god: boolean;
}

/**
 * Rain comes from drifting cloud cells. Natural showers are large and occasional; the Rain
 * god power summons a small, heavy cell wherever the player clicks.
 */
export class Weather {
  readonly clouds: RainCloud[] = [];
  private rng: Rng;
  nextNatural: number;
  private nextId = 1;
  windX = 1;
  windZ = 0.3;

  constructor(seed: number) {
    this.rng = new Rng(seed ^ 0x3a17);
    this.nextNatural = DAY_LENGTH * this.rng.range(1.2, 2.2);
  }

  get rngState(): number {
    return this.rng.state;
  }

  set rngState(v: number) {
    this.rng.state = v;
  }

  rainAt(x: number, z: number): number {
    let r = 0;
    for (const c of this.clouds) {
      const d = Math.hypot(x - c.x, z - c.z);
      if (d > c.radius) continue;
      r = Math.max(r, c.intensity * (1 - smoothstep(c.radius * 0.6, c.radius, d)));
    }
    return r;
  }

  /** Maximum rain intensity anywhere (for global ambience). */
  get anyRain(): number {
    let r = 0;
    for (const c of this.clouds) r = Math.max(r, c.intensity);
    return r;
  }

  summon(x: number, z: number, god: boolean, radius = 16, duration = 3 * HOUR, peak = 1): RainCloud {
    const c: RainCloud = {
      id: this.nextId++,
      x,
      z,
      radius,
      intensity: 0,
      peak,
      ttl: duration,
      vx: this.windX * (god ? 0.25 : 0.9),
      vz: this.windZ * (god ? 0.25 : 0.9),
      god,
    };
    this.clouds.push(c);
    return c;
  }

  update(dt: number, time: number): RainCloud | null {
    let started: RainCloud | null = null;
    if (time >= this.nextNatural) {
      const a = this.rng.range(0, Math.PI * 2);
      const d = ISLAND_RADIUS * this.rng.range(0.6, 1.1);
      const ang = a + Math.PI;
      this.windX = Math.cos(ang);
      this.windZ = Math.sin(ang);
      started = this.summon(Math.cos(a) * d, Math.sin(a) * d, false, this.rng.range(55, 80), HOUR * this.rng.range(1.5, 3.5), this.rng.range(0.55, 0.9));
      this.nextNatural = time + DAY_LENGTH * this.rng.range(1.3, 2.6);
    }
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const c = this.clouds[i]!;
      c.ttl -= dt;
      c.x += c.vx * dt * 0.35;
      c.z += c.vz * dt * 0.35;
      const target = c.ttl > 0 ? c.peak : 0;
      const rate = dt / (HOUR * 0.35);
      c.intensity = clamp01(c.intensity + Math.sign(target - c.intensity) * Math.min(Math.abs(target - c.intensity), rate));
      if (c.ttl <= 0 && c.intensity <= 0.001) this.clouds.splice(i, 1);
    }
    return started;
  }
}
