import type { IncomingMessage, ServerResponse } from 'node:http';

export interface LeaderApiOptions {
  apiKey?: string;
  models?: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  enabled?: boolean;
  perMinute?: number;
  perClientPerMinute?: number;
  maxInflight?: number;
  log?: (msg: string) => void;
}
export interface LeaderApi {
  handle(req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<void>;
  stats: { calls: number; ok: number; failed: number; lastError: string; lastModel: string; lastMs: number };
  available: boolean;
}
export function createLeaderApi(opts?: LeaderApiOptions): LeaderApi;
