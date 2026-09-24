import { angleDiff, clamp, damp, dampAngle, type V2 } from '../core/math';
import type { Agent } from '../agents/Agent';
import type { World } from '../sim/World';
import { CARRY_CAPACITY, inventoryWeight } from '../sim/types';

export const WALK_SPEED = 2.1;
export const RUN_SPEED = 3.9;
const TURN_RATE = 7;

/** Ask the path service for a route; movement starts when it arrives. */
export function navigateTo(a: Agent, w: World, dest: V2, arrive: number, run: boolean): void {
  const nav = a.nav;
  nav.dest = { x: dest.x, z: dest.z };
  nav.arrive = arrive;
  nav.run = run;
  nav.stuck = 0;
  nav.bestDist = Infinity;
  nav.repaths = 0;
  nav.failReason = '';
  nav.travelled = 0;
  nav.requestedAt = w.time;
  if (Math.hypot(dest.x - a.x, dest.z - a.z) <= arrive) {
    nav.status = 'arrived';
    nav.path = [];
    return;
  }
  nav.status = 'pending';
  requestPath(a, w);
}

function requestPath(a: Agent, w: World): void {
  const nav = a.nav;
  const dest = nav.dest!;
  w.paths.request(a.id, { x: a.x, z: a.z }, dest, (path) => {
    if (nav.dest !== dest) return; // superseded
    if (!path || path.length === 0) {
      nav.status = 'failed';
      nav.failReason = 'Could not find a way there';
      nav.path = [];
      return;
    }
    nav.path = path;
    nav.idx = 0;
    nav.status = 'moving';
    nav.bestDist = Infinity;
    nav.stuck = 0;
  });
}

export function stopNav(a: Agent, w: World): void {
  w.paths.cancel(a.id);
  a.nav.status = 'idle';
  a.nav.path = [];
  a.nav.dest = null;
}

export function remainingDistance(a: Agent): number {
  const nav = a.nav;
  if (!nav.dest) return 0;
  if (nav.status !== 'moving') return Math.hypot(nav.dest.x - a.x, nav.dest.z - a.z);
  let d = 0;
  let px = a.x;
  let pz = a.z;
  for (let i = nav.idx; i < nav.path.length; i++) {
    const p = nav.path[i]!;
    d += Math.hypot(p.x - px, p.z - pz);
    px = p.x;
    pz = p.z;
  }
  return d;
}

function speedFactor(a: Agent, w: World, dirX: number, dirZ: number): number {
  let f = 1;
  const ahead = w.terrain.heightAt(a.x + dirX, a.z + dirZ) - w.terrain.heightAt(a.x, a.z);
  if (ahead > 0) f *= clamp(1 - ahead * 0.5, 0.55, 1);
  f *= 1 - (inventoryWeight(a.inventory) / CARRY_CAPACITY) * 0.18;
  if (a.needs.energy < 0.2) f *= 0.75;
  if (a.needs.health < 0.4) f *= 0.7;
  if (w.isNight) f *= 0.9;
  return f;
}

const sep = { x: 0, z: 0 };

/** Path following with smooth turning, gentle separation and stuck recovery. */
export function updateLocomotion(a: Agent, w: World, dt: number): void {
  if (a.inside !== null) {
    a.speed = 0;
    return;
  }
  const nav = a.nav;
  const canMove = a.alive && a.knocked <= 0 && !a.collapsed && a.anim !== 'sleep';
  let desired = 0;
  let dirX = 0;
  let dirZ = 0;

  if (nav.status === 'moving' && canMove) {
    let wp = nav.path[nav.idx];
    while (wp) {
      const d = Math.hypot(wp.x - a.x, wp.z - a.z);
      const last = nav.idx === nav.path.length - 1;
      const reach = last ? Math.max(0.12, Math.min(nav.arrive, 0.35)) : 0.55;
      if (d > reach) break;
      nav.idx++;
      nav.bestDist = Infinity;
      nav.stuck = 0;
      wp = nav.path[nav.idx];
    }
    const dest = nav.dest!;
    const toDest = Math.hypot(dest.x - a.x, dest.z - a.z);
    if (!wp || toDest <= nav.arrive) {
      nav.status = 'arrived';
    } else {
      const dx = wp.x - a.x;
      const dz = wp.z - a.z;
      const d = Math.hypot(dx, dz) || 1;
      dirX = dx / d;
      dirZ = dz / d;
      desired = (nav.run ? RUN_SPEED : WALK_SPEED) * speedFactor(a, w, dirX, dirZ);
      const remaining = nav.idx === nav.path.length - 1 ? d : Infinity;
      if (remaining < 1.2) desired *= Math.max(0.45, remaining / 1.2);
      // Stuck detection: no progress toward the current waypoint.
      if (d < nav.bestDist - 0.08) {
        nav.bestDist = d;
        nav.stuck = 0;
      } else {
        nav.stuck += dt;
      }
      if (nav.stuck > 1.8) {
        nav.stuck = 0;
        nav.bestDist = Infinity;
        nav.repaths++;
        w.stuckLog.push({ id: a.id, x: a.x, z: a.z, wx: wp.x, wz: wp.z, time: w.time, final: nav.repaths > 3 });
        if (w.stuckLog.length > 200) w.stuckLog.shift();
        if (nav.repaths > 3) {
          nav.status = 'failed';
          nav.failReason = 'Got stuck on the way';
        } else {
          // Nudge sideways a little and ask for a fresh route.
          const side = nav.repaths % 2 === 0 ? 1 : -1;
          const nx = a.x - dirZ * 0.4 * side;
          const nz = a.z + dirX * 0.4 * side;
          if (w.nav.walkable(nx, nz)) {
            a.x = nx;
            a.z = nz;
          }
          nav.status = 'pending';
          requestPath(a, w);
        }
      }
    }
  }

  // Separation keeps people from overlapping without elaborate avoidance.
  sep.x = 0;
  sep.z = 0;
  if (a.alive && canMove) {
    w.agentHash.query(a.x, a.z, 0.85, (o, d2) => {
      if (o === a || !o.alive || o.inside !== null) return;
      const d = Math.sqrt(d2) || 0.01;
      const push = (0.85 - d) / 0.85;
      sep.x += ((a.x - o.x) / d) * push;
      sep.z += ((a.z - o.z) / d) * push;
    });
  }

  if (desired > 0) {
    const target = Math.atan2(dirX, dirZ);
    const diff = angleDiff(a.heading, target);
    const maxTurn = TURN_RATE * dt;
    a.heading += clamp(diff, -maxTurn, maxTurn);
    const align = clamp(Math.cos(diff), 0.1, 1);
    a.speed = damp(a.speed, desired * align, 6, dt);
  } else {
    a.speed = damp(a.speed, 0, 12, dt);
    if (a.speed < 0.05) a.speed = 0;
    if (a.focus && canMove) {
      const target = Math.atan2(a.focus.x - a.x, a.focus.z - a.z);
      a.heading = dampAngle(a.heading, target, 6, dt);
    }
  }

  const mx = Math.sin(a.heading) * a.speed * dt + sep.x * dt * 1.2;
  const mz = Math.cos(a.heading) * a.speed * dt + sep.z * dt * 1.2;
  if (mx !== 0 || mz !== 0) {
    let nx = a.x + mx;
    let nz = a.z + mz;
    if (!w.nav.walkable(nx, nz)) {
      if (w.nav.walkable(nx, a.z)) nz = a.z;
      else if (w.nav.walkable(a.x, nz)) nx = a.x;
      else {
        nx = a.x;
        nz = a.z;
      }
    }
    const moved = Math.hypot(nx - a.x, nz - a.z);
    a.x = nx;
    a.z = nz;
    a.walkPhase += moved * 2.35;
    nav.travelled += moved;
    a.stats.distance += moved;
    if (moved > 0.001) w.addWear(a.x, a.z, moved * 0.022);
  }

  // Never leave anyone standing inside an obstacle (e.g. a hut built around them).
  if (a.alive && !w.nav.walkable(a.x, a.z)) {
    const p = w.nav.nearestWalkable(a.x, a.z, 8);
    if (p) {
      a.x = p.x;
      a.z = p.z;
    }
  }
  w.agentHash.update(a);
}
