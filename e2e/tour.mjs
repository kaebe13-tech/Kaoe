// Visual tour: node e2e/tour.mjs <url> <prefix> [kinds...]
// Flies the camera to each landmark (or named spot) and screenshots it.
import { chromium } from 'playwright-core';
const [url, prefix, ...only] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' && !t.includes('[vite]')) console.log('[console]', t.slice(0, 400)); });
await page.goto(url);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
const spots = await page.evaluate(() => {
  const w = window.__game.world;
  const out = w.terrain.landmarks.map((l) => ({ name: l.kind, x: l.x, z: l.z, d: l.kind === 'volcano' ? 90 : l.kind === 'greatTree' ? 55 : 32, pitch: l.kind === 'volcano' ? 0.7 : 0.42 }));
  for (const r of w.terrain.rivers) { const p = r.points[Math.floor(r.points.length * 0.55)]; out.push({ name: `river${r.id}`, x: p.x, z: p.z, d: 26, pitch: 0.6 }); }
  w.civs.forEach((c, i) => out.push({ name: `civ${i}`, x: c.capital.x, z: c.capital.z, d: 30, pitch: 0.62 }));
  return out;
});
for (const s of spots) {
  if (only.length && !only.some((o) => s.name.startsWith(o))) continue;
  await page.evaluate((s) => { const g = window.__game; g.controls.follow = null; g.controls.jumpTo(s.x, s.z, s.d); g.controls.pitch = s.pitch; g.controls.snap(); }, s);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `e2e/out/${prefix}-${s.name}.png` });
  console.log('saved', s.name);
}
await browser.close();
