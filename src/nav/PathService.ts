import type { V2 } from '../core/math';
import type { NavGrid } from './NavGrid';
import { Pathfinder } from './Pathfinder';

export interface PathRequest {
  owner: number;
  from: V2;
  to: V2;
  done: (path: V2[] | null) => void;
  cancelled: boolean;
}

/**
 * Queues path requests and solves a bounded number per simulation step so a burst of
 * decisions (e.g. everyone waking at dawn) never causes a frame hitch.
 */
export class PathService {
  readonly finder: Pathfinder;
  private readonly queue: PathRequest[] = [];
  private readonly byOwner = new Map<number, PathRequest>();
  perStep = 6;
  /** Rolling stats for the debug overlay. */
  solvedTotal = 0;
  msTotal = 0;

  constructor(readonly grid: NavGrid) {
    this.finder = new Pathfinder(grid);
  }

  request(owner: number, from: V2, to: V2, done: (path: V2[] | null) => void): PathRequest {
    this.cancel(owner);
    const req: PathRequest = { owner, from: { ...from }, to: { ...to }, done, cancelled: false };
    this.queue.push(req);
    this.byOwner.set(owner, req);
    return req;
  }

  cancel(owner: number): void {
    const prev = this.byOwner.get(owner);
    if (prev) {
      prev.cancelled = true;
      this.byOwner.delete(owner);
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  step(): void {
    let solved = 0;
    while (this.queue.length && solved < this.perStep) {
      const req = this.queue.shift()!;
      if (req.cancelled) continue;
      this.byOwner.delete(req.owner);
      const t0 = performance.now();
      const path = this.finder.find(req.from, req.to);
      this.msTotal += performance.now() - t0;
      this.solvedTotal++;
      solved++;
      req.done(path);
    }
  }
}
