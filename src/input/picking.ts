import { Camera, Ray, Raycaster, Vector2, Vector3 } from 'three';
import type { Terrain } from '../world/Terrain';

const _ray = new Raycaster();
const _p = new Vector3();

export function screenRay(camera: Camera, dom: HTMLElement, clientX: number, clientY: number): Ray {
  const rect = dom.getBoundingClientRect();
  const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  _ray.setFromCamera(ndc, camera);
  return _ray.ray;
}

/** March along the ray over the heightfield (and the sea surface). Exact enough for clicks. */
export function raycastTerrain(ray: Ray, terrain: Terrain, maxDist = 1500): Vector3 | null {
  let t = 0;
  let prevT = 0;
  const hit = (tt: number) => {
    ray.at(tt, _p);
    return _p.y - Math.max(terrain.heightAt(_p.x, _p.z), 0);
  };
  let prevGap = hit(0);
  if (prevGap < 0) return ray.at(0, new Vector3());
  while (t < maxDist) {
    const step = Math.max(0.25, prevGap * 0.5);
    prevT = t;
    t += step;
    const gap = hit(t);
    if (gap <= 0) {
      // Refine with a short binary search.
      let lo = prevT;
      let hi = t;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        if (hit(mid) > 0) lo = mid;
        else hi = mid;
      }
      const out = ray.at(hi, new Vector3());
      out.y = Math.max(terrain.heightAt(out.x, out.z), 0);
      return out;
    }
    prevGap = gap;
  }
  return null;
}
