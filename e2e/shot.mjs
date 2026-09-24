// Usage: node e2e/shot.mjs <url> <out.png> [waitMs] [width] [height]
import { chromium } from 'playwright-core';
const [url = 'http://localhost:5173/', out = 'e2e/out/shot.png', waitMs = '2500', w = '1280', h = '720'] = process.argv.slice(2);
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const errors = [];
page.on('console', (m) => { if (!m.text().includes('[vite]')) console.log('[console]', m.type(), m.text().slice(0, 2000)); });
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
await page.goto(url);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
await page.waitForTimeout(Number(waitMs));
await page.screenshot({ path: out });
console.log('saved', out);
if (errors.length) console.log(errors.join('\n'));
await browser.close();
