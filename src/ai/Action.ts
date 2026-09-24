import type { Agent } from '../agents/Agent';
import type { World } from '../sim/World';

export type ActionStatus = 'running' | 'success' | 'failure';

/**
 * One step of a plan ("walk to the bush", "pick berries", "eat"). Actions are small,
 * resumable state machines ticked by the brain at simulation rate.
 */
export abstract class Action {
  /** Human-readable description for the inspector. */
  abstract get label(): string;
  /** 0..1 when meaningful, otherwise -1. */
  progress = -1;
  failReason = '';
  /** Non-interruptible actions can only be pre-empted by urgent goals. */
  interruptible = true;
  begun = false;
  /** Optional completion summary for the decision log (e.g. "Ate 3 berries"). */
  summary = '';

  begin(_a: Agent, _w: World): ActionStatus | void {}

  abstract tick(a: Agent, w: World, dt: number): ActionStatus;

  finish(_a: Agent, _w: World, _status: ActionStatus | 'aborted'): void {}

  protected fail(reason: string): ActionStatus {
    this.failReason = reason;
    return 'failure';
  }
}
