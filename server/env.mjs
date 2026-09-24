// Tiny .env reader (no dependency). Values are put in process.env and never printed.
import { existsSync, readFileSync } from 'node:fs';

export function loadEnvFile(path) {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

/** Comma-separated model list from GEMINI_MODEL, or undefined for the defaults. */
export function modelsFromEnv(env = process.env) {
  const v = env.GEMINI_MODEL;
  if (!v) return undefined;
  const list = v.split(',').map((s) => s.trim()).filter((s) => /^[a-z0-9.\-]+$/i.test(s));
  return list.length ? list : undefined;
}
