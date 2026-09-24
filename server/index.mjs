// Production server: serves the built game from dist/ and the leader AI endpoints.
//   npm run build && npm run serve        (reads GEMINI_API_KEY from the environment or .env)
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, modelsFromEnv } from './env.mjs';
import { createLeaderApi } from './leaderApi.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
loadEnvFile(join(root, '.env'));
const dist = join(root, 'dist');
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const aiOff = /^(0|false|off)$/i.test(process.env.KAOE_AI ?? '');

const api = createLeaderApi({
  apiKey: aiOff ? undefined : process.env.GEMINI_API_KEY,
  models: modelsFromEnv(),
  log: (m) => console.log(m),
});

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let path;
  try {
    path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const cache = file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff' });
  createReadStream(file).pipe(res);
}

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/ is missing. Run `npm run build` first.');
  process.exit(1);
}

createServer((req, res) => {
  if ((req.url ?? '').startsWith('/api/')) {
    void api.handle(req, res, () => res.writeHead(404, { 'content-type': 'application/json' }).end('{"ok":false,"error":"not_found"}'));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  serveStatic(req, res);
}).listen(port, host, () => {
  console.log(`Kaoe is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(api.available ? 'AI leaders: Gemini (key loaded from the server environment)' : 'AI leaders: local only (set GEMINI_API_KEY in .env to enable Gemini)');
});
