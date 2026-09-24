import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/World';
import { Simulation } from '../src/sim/Simulation';
import { SIM_DT } from '../src/world/config';
import { POWERS, usePower, findDead } from '../src/powers/GodPowers';
import { kill } from '../src/sim/needs';
import { serialize, deserialize } from '../src/save/SaveSystem';
import { startWorldEvent } from '../src/sim/worldEvents';

function setup(seed = 21): { w: World; sim: Simulation } {
  const w = new World(seed);
  w.spawnCivilizations(4, 6);
  const sim = new Simulation(w);
  for (let i = 0; i < 20; i++) sim.step(SIM_DT);
  return { w, sim };
}

/** A walkable spot well away from any village or wonder. */
function openLand(w: World): { x: number; z: number } {
  for (let r = 60; r < 260; r += 10) {
    for (let a = 0; a < 24; a++) {
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (!w.nav.walkable(x, z) || w.terrain.heightAt(x, z) < 2 || w.terrain.slopeAt(x, z) > 0.3) continue;
      if (w.settlements.some((s) => Math.hypot(s.x - x, s.z - z) < 60)) continue;
      if (w.terrain.landmarks.some((l) => Math.hypot(l.x - x, l.z - z) < 50)) continue;
      if (w.terrain.ponds.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius + 20)) continue;
      let wet = false;
      for (let k = 0; k < 16 && !wet; k++) for (const d of [0, 6, 12, 18]) if (w.terrain.isWater(x + Math.cos(k) * d, z + Math.sin(k) * d)) wet = true;
      if (wet) continue;
      return { x, z };
    }
  }
  throw new Error('no open land');
}

describe('god powers', () => {
  it('every power does something or explains why not', () => {
    const { w } = setup();
    const cap = w.civs[0]!.capital!;
    const leader = w.agent(w.civs[0]!.leaderId)!;
    for (const p of POWERS) {
      if (p.id === 'teleport' || p.id === 'resurrect') continue;
      const at = p.target === 'civ' ? { x: cap.x, z: cap.z, humanId: leader.id } : { ...openLand(w), humanId: p.target === 'person' ? leader.id : null };
      const r = usePower(w, p.id, at);
      expect(r.ok || !!r.message, `${p.id}`).toBe(true);
    }
  });

  it('a meteor leaves a crater and the save remembers it', () => {
    const { w, sim } = setup();
    const at = openLand(w);
    const before = w.terrain.heightAt(at.x, at.z);
    expect(usePower(w, 'meteor', { ...at, humanId: null }).ok).toBe(true);
    for (let i = 0; i < 60; i++) sim.step(SIM_DT);
    const after = w.terrain.heightAt(at.x, at.z);
    expect(after).toBeLessThan(before - 1.5);
    expect(w.terrainEdits.length).toBe(1);
    const loaded = deserialize(JSON.parse(JSON.stringify(serialize(w))));
    expect(loaded.terrain.heightAt(at.x, at.z)).toBeCloseTo(after, 3);
  });

  it('a spring makes drinkable water', () => {
    const { w } = setup();
    const at = openLand(w);
    const lakes = w.water.length;
    expect(usePower(w, 'spring', { ...at, humanId: null }).ok).toBe(true);
    expect(w.water.length).toBe(lakes + 1);
    expect(w.terrain.isWater(at.x, at.z)).toBe(true);
    expect(w.nav.walkable(at.x, at.z)).toBe(false);
    const loaded = deserialize(JSON.parse(JSON.stringify(serialize(w))));
    expect(loaded.terrain.isWater(at.x, at.z)).toBe(true);
    expect(loaded.water.length).toBe(lakes + 1);
  });

  it('the dead can be called back', () => {
    const { w } = setup();
    const a = w.civs[1]!.living[2]!;
    w.withCiv(w.civs[1]!, () => kill(a, w, 'curse'));
    expect(findDead(w, a.x, a.z)).toBe(a);
    expect(usePower(w, 'resurrect', { x: a.x, z: a.z, humanId: null }).ok).toBe(true);
    expect(a.alive).toBe(true);
    expect(w.civs[1]!.members.includes(a)).toBe(true);
  });

  it('world events happen and are remembered', () => {
    const { w } = setup();
    const e = startWorldEvent(w, 'tempest');
    expect(e).not.toBeNull();
    expect(w.worldEventLog.length).toBe(1);
    expect(w.weather.clouds.length).toBeGreaterThan(0);
  });
});
