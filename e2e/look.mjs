// Scripted screenshots: node e2e/look.mjs <url> <prefix> '<js returning shots>'
// Each shot: { name, eval (string, run in page), wait (ms) }
import { chromium } from 'playwright-core';
const [url, prefix, shotsJson, w = '1280', h = '720'] = process.argv.slice(2);
const shots = JSON.parse(shotsJson);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
page.on('console', (m) => { const t = m.text(); if (!t.includes('[vite]')) console.log('[console]', m.type(), t.slice(0, 500)); });
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
await page.goto(url);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
for (const s of shots) {
  if (s.eval) {
    const r = await page.evaluate(s.eval);
    if (r !== undefined && r !== null) console.log(`[${s.name}]`, typeof r === 'string' ? r : JSON.stringify(r));
  }
  await page.waitForTimeout(s.wait ?? 1500);
  if (!s.noshot) {
    await page.screenshot({ path: `e2e/out/${prefix}-${s.name}.png` });
    console.log('saved', `e2e/out/${prefix}-${s.name}.png`);
  }
}
await browser.close();
