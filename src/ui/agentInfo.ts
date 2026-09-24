import type { Agent } from '../agents/Agent';
import type { World } from '../sim/World';

/** One-word mood derived from needs, used in lists and the inspector. */
export function mood(a: Agent): { text: string; tone: 'good' | 'ok' | 'bad' } {
  if (!a.alive) return { text: 'Deceased', tone: 'bad' };
  const n = a.needs;
  if (a.knocked > 0) return { text: 'Stunned', tone: 'bad' };
  if (a.collapsed) return { text: 'Collapsed', tone: 'bad' };
  if (n.safety < 0.35) return { text: 'Terrified', tone: 'bad' };
  if (n.health < 0.35) return { text: 'Hurt', tone: 'bad' };
  if (n.hunger < 0.2) return { text: 'Starving', tone: 'bad' };
  if (n.thirst < 0.2) return { text: 'Parched', tone: 'bad' };
  if (n.energy < 0.2) return { text: 'Exhausted', tone: 'bad' };
  const avg = (n.hunger + n.thirst + n.energy + n.health + n.safety + n.social) / 6;
  if (n.social < 0.25) return { text: 'Lonely', tone: 'ok' };
  if (n.hunger < 0.4) return { text: 'Hungry', tone: 'ok' };
  if (n.thirst < 0.4) return { text: 'Thirsty', tone: 'ok' };
  if (n.energy < 0.35) return { text: 'Tired', tone: 'ok' };
  if (n.safety < 0.6) return { text: 'Uneasy', tone: 'ok' };
  if (avg > 0.8) return { text: 'Happy', tone: 'good' };
  return { text: 'Content', tone: 'good' };
}

export function initials(name: string): string {
  return name.slice(0, 1).toUpperCase();
}

/** Icons for urgent needs shown next to names. */
export function warnings(a: Agent): string[] {
  if (!a.alive) return [];
  const out: string[] = [];
  if (a.needs.hunger < 0.25) out.push('food');
  if (a.needs.thirst < 0.25) out.push('water');
  if (a.needs.energy < 0.2) out.push('sleep');
  if (a.needs.health < 0.4) out.push('heal');
  if (a.needs.safety < 0.4) out.push('warning');
  return out;
}

export function homeText(w: World, a: Agent): string {
  const home = w.structure(a.homeId);
  if (!home) return 'No home';
  const mates = home.residents.filter((id) => id !== a.id).map((id) => w.agent(id)?.name).filter(Boolean);
  if (!home.complete) return 'Hut being built';
  return mates.length ? `Hut with ${mates.join(', ')}` : 'Own hut';
}

export function activityText(a: Agent): { icon: string; text: string } {
  if (!a.alive) return { icon: 'death', text: a.deathCause ? `Died (${a.deathCause})` : 'Died' };
  if (a.knocked > 0) return { icon: 'warning', text: 'Knocked down' };
  const act = a.brain.active;
  if (!act) return { icon: 'idle', text: 'Deciding...' };
  if (a.inside !== null && act.goal === 'sleep') return { icon: 'sleep', text: 'Asleep at home' };
  return { icon: act.icon, text: act.label };
}
