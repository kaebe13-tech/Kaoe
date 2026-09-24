import { updateBrain } from '../ai/Brain';
import { updateLocomotion } from '../ai/locomotion';
import { HOUR } from '../world/config';
import { Ecology } from './ecology';
import { Families } from './family';
import { updateNeeds } from './needs';
import { World } from './World';

/** Owns the world and advances it in fixed steps. Has no rendering dependencies. */
export class Simulation {
  readonly ecology = new Ecology();
  readonly families = new Families();
  /** Profiling (ms) of the last step, for the debug overlay. */
  lastStepMs = 0;
  stepCount = 0;

  constructor(readonly world: World) {}

  step(dt: number): void {
    const t0 = performance.now();
    const w = this.world;
    w.time += dt;
    const shower = w.weather.update(dt, w.time);
    if (shower) w.log('Dark clouds roll in over the island. Rain is coming.', 'rain', 2, shower);
    w.paths.step();
    for (const a of w.agents) {
      a.prevX = a.x;
      a.prevZ = a.z;
      a.prevHeading = a.heading;
      if (!a.alive) {
        this.updateDead(a.id, dt);
        continue;
      }
      updateNeeds(a, w, dt);
      if (!a.alive) continue;
      if (a.knocked > 0) {
        a.setAnim('knocked');
      } else {
        updateBrain(a, w, dt);
      }
      updateLocomotion(a, w, dt);
      a.animTime += dt;
    }
    this.ecology.update(w, dt);
    this.families.update(w, dt);
    this.stepCount++;
    this.lastStepMs = performance.now() - t0;
  }

  /** Bodies are laid to rest in a grave after a while. */
  private updateDead(id: number, dt: number): void {
    const w = this.world;
    const a = w.agent(id);
    if (!a || a.buried) return;
    a.animTime += dt;
    if (w.time - a.diedAt > HOUR * 1.5) {
      const spot = w.nav.nearestWalkable(a.x, a.z, 4) ?? { x: a.x, z: a.z };
      const g = w.createStructure('grave', spot.x, spot.z, a.heading, a.id);
      g.complete = true;
      g.progress = 1;
      g.label = a.name;
      w.events.emit('structureChanged', g);
      a.buried = true;
      w.agentHash.remove(a);
    }
  }
}
