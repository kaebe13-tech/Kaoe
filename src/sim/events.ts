import type { Agent } from '../agents/Agent';
import type { ResourceNode, Structure } from './types';

export type FeedIcon =
  | 'food'
  | 'water'
  | 'wood'
  | 'build'
  | 'home'
  | 'fire'
  | 'lightning'
  | 'rain'
  | 'heal'
  | 'death'
  | 'social'
  | 'explore'
  | 'star'
  | 'warning'
  | 'sleep'
  | 'bless';

export interface FeedEvent {
  text: string;
  icon: FeedIcon;
  time: number;
  x?: number;
  z?: number;
  agentId?: number;
  /** 1 = minor, 2 = notable, 3 = major */
  importance: 1 | 2 | 3;
}

export type SfxKind =
  | 'chop'
  | 'treeFall'
  | 'gather'
  | 'eat'
  | 'drink'
  | 'hammer'
  | 'build'
  | 'complete'
  | 'thunder'
  | 'ignite'
  | 'splash'
  | 'heal'
  | 'bless'
  | 'talk'
  | 'deposit'
  | 'death'
  | 'yelp';

export interface SfxEvent {
  kind: SfxKind;
  x: number;
  z: number;
  volume?: number;
}

export type FxKind = 'woodChips' | 'leaves' | 'berryPop' | 'dust' | 'buildDust' | 'splash' | 'sparkle' | 'smoke' | 'hearts' | 'zzz' | 'embers';

export interface FxEvent {
  kind: FxKind;
  x: number;
  z: number;
  y?: number;
  count?: number;
}

export interface SimEvents {
  log: FeedEvent;
  sfx: SfxEvent;
  fx: FxEvent;
  resourceChanged: ResourceNode;
  resourceAdded: ResourceNode;
  resourceHit: ResourceNode;
  treeFelled: { resource: ResourceNode; dirX: number; dirZ: number };
  structureAdded: Structure;
  structureChanged: Structure;
  structureRemoved: Structure;
  agentAdded: Agent;
  agentDied: Agent;
  lightning: { x: number; z: number };
}
