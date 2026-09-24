import { Color, Group, PointLight, Vector3 } from 'three';

export interface LightSource {
  position: Vector3;
  color: Color;
  /** Current desired intensity (0 = off). */
  intensity: number;
  distance: number;
}

/**
 * A fixed handful of point lights shared by every glowing thing in the world (campfires,
 * wonders). Each frame they go to the brightest sources nearest the camera, so the shader
 * light count never changes (no recompiles) and the cost stays flat however many fires burn.
 */
export class LightPool {
  readonly group = new Group();
  private readonly lights: PointLight[] = [];
  private readonly sources = new Set<LightSource>();

  constructor(size = 4) {
    for (let i = 0; i < size; i++) {
      const l = new PointLight(0xffffff, 0, 16, 1.6);
      l.castShadow = false;
      this.lights.push(l);
      this.group.add(l);
    }
  }

  add(s: LightSource): LightSource {
    this.sources.add(s);
    return s;
  }

  remove(s: LightSource): void {
    this.sources.delete(s);
  }

  update(focus: Vector3): void {
    const ranked = [...this.sources].filter((s) => s.intensity > 0.01).map((s) => ({ s, score: s.position.distanceTo(focus) - s.intensity * 2 }));
    ranked.sort((a, b) => a.score - b.score);
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i]!;
      const r = ranked[i];
      if (!r || r.score > 180) {
        l.intensity = 0;
        continue;
      }
      l.position.copy(r.s.position);
      l.color.copy(r.s.color);
      l.distance = r.s.distance;
      // Fade lights out as they drop off the end of the list, so switching is invisible.
      const fade = Math.min(1, Math.max(0, (180 - r.score) / 40));
      l.intensity = r.s.intensity * fade;
    }
  }
}
