import { updateBrain } from '../ai/Brain';
import { updateLocomotion } from '../ai/locomotion';
import { HOUR } from '../world/config';
import { effectiveSpeed } from '../civ/timeScale';
import { Ecology } from './ecology';
import { Families } from './family';
import { stormLightning } from './hazards';
import { updateNeeds } from './needs';
import { World } from './World';
import type { Civilization } from '../civ/Civilization';
import { CivSystem, ensureLeaders } from '../civ/civSystem';
import type { Agent } from '../agents/Agent';

/** Most substeps one civilization may take per world step (8x speed). */
const MAX_SUBSTEPS = 8;

/**
 * Owns the world and advances it in fixed steps. Has no rendering dependencies.
 *
 * Time model: the world (sun, weather, wild plants, fire) advances one fixed step at a time.
 * Every civilization then advances its own clock by `speed` steps of the same fixed size, so a
 * civilization at 4x really lives four steps (moves, thinks, eats, works, builds, ages) for each
 * world step, and one at 0.25x lives one step in four. Nothing is scaled or skipped: fast
 * civilizations are simply simulated more often, which keeps movement, pathing and resources exact.
 */
export class Simulation {
  readonly ecology = new Ecology();
  readonly families = new Families();
  readonly civSystem = new CivSystem();
  /** Profiling (ms) of the last step, for the debug overlay. */
  lastStepMs = 0;
  stepCount = 0;
  /** Agent-steps simulated in the last world step (all civilizations). */
  lastAgentSteps = 0;

  constructor(readonly world: World) {
    ensureLeaders(world);
  }

  /** Milliseconds spent per phase in the last step (debug/profiling). */
  readonly phase = { paths: 0, agents: 0, ecology: 0, families: 0 };

  step(dt: number): void {
    const t0 = performance.now();
    const w = this.world;
    w.worldTime += dt;
    w.time = w.worldTime;
    w.activeCiv = null;
    const shower = w.weather.update(dt, w.worldTime);
    if (shower) w.log(shower.peak > 0.75 ? 'A storm is rolling in!' : 'Dark clouds roll in. Rain is coming.', 'rain', 2, shower);
    stormLightning(w, dt);
    // Work out how many substeps each civilization takes this world step.
    let totalSub = 0;
    for (const civ of w.civs) {
      const speed = effectiveSpeed(civ, w.worldTime);
      civ.acc += speed;
      let n = Math.floor(civ.acc + 1e-9);
      if (n > MAX_SUBSTEPS) n = MAX_SUBSTEPS;
      civ.acc -= n;
      if (civ.acc > 1) civ.acc = 1;
      civ.lastSubsteps = n;
      totalSub += n;
    }
    w.paths.step(Math.max(4, Math.min(24, 3 + totalSub)));
    const t1 = performance.now();
    this.phase.paths = t1 - t0;
    let agentSteps = 0;
    // Interleave civilizations substep by substep so fast ones never "burst" ahead within a step.
    const maxN = w.civs.reduce((m, c) => Math.max(m, c.lastSubsteps), 0);
    for (let k = 0; k < maxN; k++) {
      for (const civ of w.civs) {
        if (k >= civ.lastSubsteps) continue;
        w.time = civ.clock;
        w.activeCiv = civ;
        agentSteps += this.stepCiv(civ, dt);
        civ.clock += dt;
      }
      if (k > 0 && k % 2 === 0) {
        w.time = w.worldTime;
        w.activeCiv = null;
        w.paths.step(2);
      }
    }
    w.time = w.worldTime;
    w.activeCiv = null;
    this.lastAgentSteps = agentSteps;
    const t2 = performance.now();
    this.phase.agents = t2 - t1;
    this.ecology.update(w, dt);
    this.civSystem.worldUpdate(w, dt);
    const t3 = performance.now();
    this.phase.ecology = t3 - t2;
    this.phase.families = 0;
    this.stepCount++;
    this.lastStepMs = performance.now() - t0;
  }

  /** One substep of a civilization in its own time context. Returns agents stepped. */
  private stepCiv(civ: Civilization, dt: number): number {
    const w = this.world;
    let n = 0;
    const members = civ.members;
    for (let i = 0; i < members.length; i++) {
      const a = members[i]!;
      a.prevX = a.x;
      a.prevZ = a.z;
      a.prevHeading = a.heading;
      if (!a.alive) {
        this.updateDead(a, dt);
        continue;
      }
      stepAgent(a, w, dt);
      n++;
    }
    // Buried members leave the roll.
    for (let i = members.length - 1; i >= 0; i--) if (members[i]!.buried) members.splice(i, 1);
    this.families.update(w, dt, civ);
    this.civSystem.civUpdate(w, civ, dt);
    return n;
  }

  /** Bodies are laid to rest in a grave after a while. */
  private updateDead(a: Agent, dt: number): void {
    const w = this.world;
    if (a.buried) return;
    a.animTime += dt;
    if (w.time - a.diedAt > HOUR * 1.5) {
      const spot = w.nav.nearestWalkable(a.x, a.z, 4) ?? { x: a.x, z: a.z };
      const g = w.createStructure('grave', spot.x, spot.z, a.heading, a.id, a.civId, a.settlementId);
      g.complete = true;
      g.progress = 1;
      g.label = a.name;
      w.events.emit('structureChanged', g);
      a.buried = true;
      w.agentHash.remove(a);
    }
  }
}

export function stepAgent(a: Agent, w: World, dt: number): void {
  updateNeeds(a, w, dt);
  if (!a.alive) return;
  if (a.knocked > 0) a.setAnim('knocked');
  else updateBrain(a, w, dt);
  updateLocomotion(a, w, dt);
  a.animTime += dt;
}

export { effectiveSpeed, resyncing } from '../civ/timeScale';
