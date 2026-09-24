import type { World } from './World';
import { igniteResource, igniteStructure } from './ecology';
import { kill } from './needs';
import { describePlace } from '../ai/describe';

/**
 * A lightning strike. Everything nearby reacts: fires start, people get hurt, witnesses are
 * frightened (and, when the gods are responsible, a little more faithful).
 */
export function lightningStrike(w: World, x: number, z: number, byGod: boolean): void {
  w.stats.lightningStrikes++;
  w.events.emit('lightning', { x, z });
  w.events.emit('sfx', { kind: 'thunder', x, z, volume: 1 });
  w.dangers.push({ id: w.nextId(), x, z, radius: 11, ttl: 22, kind: 'lightning' });
  w.scorches.push({ id: w.nextId(), x, z, radius: 2.6, age: 0 });
  let hurt = 0;
  for (const a of w.agents) {
    if (!a.alive || a.inside !== null) continue;
    const d = Math.hypot(a.x - x, a.z - z);
    if (d < 2.4) {
      a.needs.health -= 0.2 + 0.75 * (1 - d / 2.4);
      a.knocked = 5;
      hurt++;
      a.addLog(w.time, 'event', 'Struck by lightning!');
      if (a.needs.health <= 0) {
        a.needs.health = 0;
        kill(a, w, 'lightning');
        continue;
      }
      w.log(`${a.name} was struck by lightning!`, 'lightning', 3, a, a.id);
    } else if (d < 5) {
      a.knocked = Math.max(a.knocked, 2.2);
      a.needs.health = Math.max(0.05, a.needs.health - 0.08);
    }
    if (d < 24) {
      const fear = 0.6 * (1 - d / 24) * (a.has('timid') ? 1.3 : a.has('brave') ? 0.6 : 1);
      a.needs.safety = Math.max(0, a.needs.safety - fear);
      a.emote = { icon: 'warning', until: w.time + 3 };
      if (d >= 2.4) a.addLog(w.time, 'event', d < 8 ? 'Lightning struck right next to me!' : 'Saw lightning strike nearby.');
      a.memory.addDanger({ x, z, at: w.time, kind: 'lightning' });
      if (byGod) a.faith = Math.min(1, a.faith + 0.06);
      a.brain.nextThink = w.time;
    }
  }
  let fires = 0;
  w.resourceHash.query(x, z, 3.4, (r) => {
    if (r.kind === 'rock') return;
    const d = Math.hypot(r.x - x, r.z - z);
    if (w.rng.chance(1 - d / 4)) {
      if (w.rainAt(r.x, r.z) > 0.5) return;
      igniteResource(w, r);
      fires++;
    }
  });
  for (const s of w.structures) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < 3.2 && w.rainAt(s.x, s.z) < 0.5) igniteStructure(w, s);
  }
  if (!hurt) {
    const what = byGod ? 'Lightning strikes' : 'Lightning from the storm strikes';
    if (fires) w.log(`${what} ${describePlace(w, x, z)} — fire!`, 'lightning', 2, { x, z });
    else if (byGod) w.log(`${what} ${describePlace(w, x, z)}.`, 'lightning', 1, { x, z });
  }
}


/** Storms occasionally throw lightning of their own. */
export function stormLightning(w: World, dt: number): void {
  for (const c of w.weather.clouds) {
    if (c.god || c.intensity < 0.6) continue;
    // Roughly one strike every couple of in-game hours per storm.
    if (!w.rng.chance(dt * 0.012 * c.intensity)) continue;
    const a = w.rng.range(0, Math.PI * 2);
    const r = Math.sqrt(w.rng.next()) * c.radius * 0.8;
    const x = c.x + Math.cos(a) * r;
    const z = c.z + Math.sin(a) * r;
    if (w.terrain.heightAt(x, z) < 0.3) {
      w.events.emit('lightning', { x, z });
      w.events.emit('sfx', { kind: 'thunder', x, z, volume: 1 });
      continue;
    }
    lightningStrike(w, x, z, false);
  }
}
