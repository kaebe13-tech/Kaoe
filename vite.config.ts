import { defineConfig, type Plugin } from 'vitest/config';
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Copy the standalone services/ page into the build untouched (it is not part of the game). */
function copyStatic(dirs: string[]): Plugin {
  return {
    name: 'copy-static-pages',
    apply: 'build',
    closeBundle() {
      for (const d of dirs) {
        const src = resolve(__dirname, d);
        if (existsSync(src)) cpSync(src, resolve(__dirname, 'dist', d), { recursive: true });
      }
    },
  };
}

// Relative base so the build works from any sub-path (e.g. GitHub Pages project sites).
export default defineConfig({
  base: './',
  plugins: [copyStatic(['services'])],
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
});
