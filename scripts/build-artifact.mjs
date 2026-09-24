// Builds a single self-contained HTML page of the game for hosts that only allow CDN scripts
// (three.js from jsDelivr via an import map, fonts from Google Fonts, everything else inline).
//   node scripts/build-artifact.mjs [outFile]
import { build } from 'vite';
import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const outFile = process.argv[2] ?? 'dist-artifact/kaoe.html';
const tmp = 'dist-artifact/.build';
const THREE = '0.186.0';

await build({
  configFile: false,
  root: process.cwd(),
  base: './',
  logLevel: 'warn',
  plugins: [
    {
      // Fonts come from Google Fonts in this build.
      name: 'strip-fontsource',
      enforce: 'pre',
      resolveId: (id) => (id.startsWith('@fontsource/') ? '\0empty-font' : null),
      load: (id) => (id === '\0empty-font' ? '' : null),
    },
  ],
  build: {
    outDir: tmp,
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: { external: ['three', /^three\/examples\//] },
  },
});

const assets = join(tmp, 'assets');
const files = readdirSync(assets);
const js = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(assets, f), 'utf8'));
const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(assets, f), 'utf8'));
if (js.length !== 1) throw new Error(`expected one JS chunk, got ${js.length}`);
const code = js[0].replace(/<\/script/gi, '<\\/script');
const importMap = {
  imports: {
    three: `https://cdn.jsdelivr.net/npm/three@${THREE}/build/three.module.js`,
    'three/examples/jsm/': `https://cdn.jsdelivr.net/npm/three@${THREE}/examples/jsm/`,
  },
};
const page = `<title>Kaoe</title>
<meta name="description" content="A tiny tribe of autonomous humans survives and builds on a stylized island while you watch as their god.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600&family=Nunito:wght@400;700;800&display=swap">
<style>
:root { color-scheme: dark; }
${css.join('\n')}
</style>
<div id="app"></div>
<script type="importmap">${JSON.stringify(importMap)}</script>
<script type="module">
${code}
</script>
`;
writeFileSync(outFile, page);
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${outFile} (${(page.length / 1024).toFixed(0)} KB)`);
