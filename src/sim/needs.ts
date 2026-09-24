import type { Agent } from '../agents/Agent';
import { HOUR } from '../world/config';
import { campCenter } from './settlement';
import type { World } from './World';
import { abortActive } from '../ai/brainCore';
import { stopNav } from '../ai/locomotion';

const WORK_ANIMS = new Set(['chop', 'build', 'gather']);

/** Drain and restore needs; handle starvation, exhaustion and death. */
export function updateNeeds(a: Agent, w: World, dt: number): void {
  if (!a.alive) return;
  const n = a.needs;
  const hr = dt / HOUR;
  const asleep = a.anim === 'sleep';
  const working = WORK_ANIMS.has(a.anim);
  const running = a.anim === 'run';

  const kid = a.isChild ? 0.75 : 1;
  n.hunger -= hr * 0.042 * kid * (a.has('glutton') ? 1.3 : 1) * (working ? 1.2 : 1) * (asleep ? 0.55 : 1);
  n.thirst -= hr * 0.066 * (running ? 1.4 : 1) * (working ? 1.15 : 1) * (asleep ? 0.5 : 1);
  if (!asleep) n.energy -= hr * 0.045 * (a.has('sleepy') ? 1.2 : 1) * (working ? 1.35 : 1) * (running ? 1.6 : 1);
  n.social -= hr * 0.028 * (a.has('sociable') ? 1.35 : 1) * (asleep ? 0.3 : 1);

  if (!asleep && a.inside === null) {
    let company = 0;
    w.agentHash.query(a.x, a.z, 5, (o) => {
      if (o !== a && o.alive && o.awake) company++;
    });
    n.social += hr * 0.007 * Math.min(company, 2);
  }

  // Safety drifts back toward a baseline that depends on circumstances.
  let baseline = 1;
  if (w.isNight && a.inside === null) {
    const far = Math.hypot(a.x - campCenter(w).x, a.z - campCenter(w).z) > 25;
    if (far) baseline = a.has('timid') ? 0.45 : 0.75;
  }
  const rain = a.inside === null ? w.rainAt(a.x, a.z) : 0;
  if (rain > 0.3) baseline = Math.min(baseline, 0.85);
  n.safety += (baseline - n.safety) * Math.min(1, hr * (n.safety < baseline ? 0.5 : 0.8));

  // Health: starvation and thirst hurt; being fed and rested heals.
  let cause = '';
  if (n.hunger <= 0) {
    n.health -= hr * 0.05;
    cause = 'starvation';
  }
  if (n.thirst <= 0) {
    n.health -= hr * 0.08;
    cause = 'thirst';
  }
  if (n.hunger > 0.3 && n.thirst > 0.3) n.health += hr * 0.025 * (asleep ? 3 : a.anim === 'sit' ? 2.5 : 1);

  // Standing in a fire.
  w.resourceHash.query(a.x, a.z, 2.2, (r) => {
    if (r.burning > 0) {
      n.health -= dt * 0.015;
      cause = 'burns';
    }
  });

  n.hunger = clamp(n.hunger);
  n.thirst = clamp(n.thirst);
  n.energy = clamp(n.energy);
  n.social = clamp(n.social);
  n.safety = clamp(n.safety);
  n.health = clamp(n.health);

  if (a.knocked > 0) a.knocked = Math.max(0, a.knocked - dt);
  if (a.emote && a.emote.until < w.time) a.emote = null;
  // Faith fades slowly without new signs from above.
  if (a.faith > 0) a.faith = Math.max(0, a.faith - (dt / (HOUR * 24)) * 0.04);

  warn(a, w);
  if (n.health <= 0) kill(a, w, cause || 'exhaustion');
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const warned = new Map<string, number>();

function warn(a: Agent, w: World): void {
  const check = (key: string, cond: boolean, text: string) => {
    const k = `${a.id}:${key}`;
    if (!cond) {
      warned.delete(k);
      return;
    }
    if (warned.has(k)) return;
    warned.set(k, w.time);
    w.log(text, 'warning', 2, a, a.id);
  };
  check('hunger', a.needs.hunger < 0.08, `${a.name} is starving!`);
  check('thirst', a.needs.thirst < 0.08, `${a.name} is dying of thirst!`);
  check('health', a.needs.health < 0.25, `${a.name} is badly hurt.`);
}

export function kill(a: Agent, w: World, cause: string): void {
  if (!a.alive) return;
  abortActive(a, w, 'died');
  stopNav(a, w);
  a.alive = false;
  a.deathCause = cause;
  a.diedAt = w.time;
  a.inside = null;
  a.setAnim('dead');
  w.stats.deaths++;
  const how: Record<string, string> = {
    starvation: 'starved to death',
    thirst: 'died of thirst',
    burns: 'died in the fire',
    lightning: 'was killed by lightning',
    exhaustion: 'died of exhaustion',
  };
  w.log(`${a.name} ${how[cause] ?? 'has died'}.`, 'death', 3, a, a.id);
  w.events.emit('sfx', { kind: 'death', x: a.x, z: a.z });
  w.events.emit('agentDied', a);
  // Everyone who knew them grieves, the closest friends the most.
  for (const o of w.agents) {
    if (o === a || !o.alive) continue;
    const aff = o.affinity(a.id);
    o.needs.safety = Math.max(0, o.needs.safety - 0.2 - aff * 0.3);
    o.needs.social = Math.max(0, o.needs.social - aff * 0.3);
    o.addLog(w.time, 'event', `Mourning ${a.name}.`);
    if (aff > 0.4) o.memory.addDanger({ x: a.x, z: a.z, at: w.time, kind: 'death' });
    if (o.homeId !== null) {
      const hut = w.structure(o.homeId);
      if (hut && hut.id === a.homeId) o.addLog(w.time, 'event', `The hut feels empty without ${a.name}.`);
    }
  }
  const hut = w.structure(a.homeId);
  if (hut) hut.residents = hut.residents.filter((id) => id !== a.id);
  a.homeId = null;
}
