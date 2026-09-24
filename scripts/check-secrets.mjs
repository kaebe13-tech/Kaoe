// Fails if an API key could reach the browser or the repository.
//   node scripts/check-secrets.mjs      (run after `npm run build` / `npm run build:artifact`)
// Checks the built bundles and every git-tracked file for the configured GEMINI_API_KEY value
// and for anything shaped like a Google API key. Never prints a secret.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from '../server/env.mjs';

loadEnvFile('.env');
const key = process.env.GEMINI_API_KEY ?? '';
const patterns = [/AIza[0-9A-Za-z_-]{30,}/, /AQ\.[0-9A-Za-z_-]{30,}/];
const problems = [];

function scan(file, text) {
  if (key && key.length >= 12 && text.includes(key)) problems.push(`${file}: contains the GEMINI_API_KEY value`);
  for (const p of patterns) if (p.test(text)) problems.push(`${file}: contains something shaped like an API key`);
}

function walk(dir) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|html|css|json|map|txt)$/.test(f)) scan(p, readFileSync(p, 'utf8'));
  }
}

walk('dist');
walk('dist-artifact');
const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
for (const f of tracked) {
  if (f === '.env' || (f.startsWith('.env.') && f !== '.env.example')) problems.push(`${f}: an env file is tracked by git`);
  if (!existsSync(f) || statSync(f).size > 2_000_000) continue;
  scan(f, readFileSync(f, 'utf8'));
}
const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' }).split('\n').filter(Boolean);
for (const f of staged) if (f === '.env' || (f.startsWith('.env.') && f !== '.env.example')) problems.push(`${f}: an env file is staged`);

if (problems.length) {
  console.error(`Secret check FAILED:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Secret check passed (${tracked.length} tracked files and the built bundles; ${key ? 'a key is configured locally and appears nowhere' : 'no key configured locally'}).`);
