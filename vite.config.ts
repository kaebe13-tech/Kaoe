import { defineConfig, type Plugin } from 'vitest/config';
import { loadEnv } from 'vite';
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLeaderApi, type LeaderApi } from './server/leaderApi.mjs';
import { modelsFromEnv } from './server/env.mjs';

/** Copy the standalone services/ page into the build untouched (it is not part of the game). */
function copyStatic(dirs: string[]): Plugin {
  return {
    name: 'copy-static-pages',
    apply: 'build',
    closeBundle() {
      for (const d of dirs) {
        const src = resolve(import.meta.dirname, d);
        if (existsSync(src)) cpSync(src, resolve(import.meta.dirname, "dist", d), { recursive: true });
      }
    },
  };
}

/**
 * Serve the leader AI endpoints from the dev and preview servers. The key is read here, in
 * Node, from the environment or .env; it has no VITE_ prefix so it is never bundled.
 */
function aiBackend(mode: string): Plugin {
  let api: LeaderApi | null = null;
  const get = () => {
    if (api) return api;
    const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
    const off = /^(0|false|off)$/i.test(env.KAOE_AI ?? '');
    api = createLeaderApi({ apiKey: off ? undefined : env.GEMINI_API_KEY, models: modelsFromEnv(env), log: (m) => console.log(m) });
    return api;
  };
  return {
    name: 'kaoe-ai-backend',
    configureServer(server) {
      server.middlewares.use((req, res, next) => void get().handle(req, res, next));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => void get().handle(req, res, next));
    },
  };
}

// Relative base so the build works from any sub-path (e.g. GitHub Pages project sites).
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [copyStatic(['services']), aiBackend(mode)],
  server: { host: true, port: 5173 },
  preview: { port: 4173 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('node_modules/three') ? 'three' : undefined),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
}));
