// End-to-end browser test. Starts from a running dev/preview server URL (default: vite dev).
// Usage: node e2e/run.mjs [url]
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(e.message));

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const g = (fn, arg) => page.evaluate(fn, arg);
/** Wait until the game has rendered n more frames (robust to slow software rendering). */
const frames = async (n = 3) => {
  const start = await g(() => window.__game.frameCount);
  await page.waitForFunction((s) => window.__game.frameCount >= s, start + n, { timeout: 60000 });
};
/** Apply camera changes immediately so projections are valid. */
const applyCam = () => g(() => window.__game.controls.update(0));

await page.goto(url + (url.includes('?') ? '&' : '?') + 'seed=4242');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
await page.waitForTimeout(1500);

// ---- Startup & intro
console.log('fps (software renderer):', (await g(() => window.__game.fps)).toFixed(1));
check('intro card shown', await page.locator('.intro').isVisible());
check('world paused behind intro', (await g(() => window.__game.speed)) === 0);
await page.locator('.intro').click();
await page.waitForTimeout(500);
check('intro dismissed, sim running at 1x', (await g(() => window.__game.speed)) === 1);
check('6 humans spawned', (await g(() => window.__game.world.living.length)) === 6);

// ---- Simulation speed & pause
const rate = async (speed) =>
  g((sp) => {
    const game = window.__game;
    game.setSpeed(sp);
    const t = game.world.time;
    for (let i = 0; i < 60; i++) game.stepSim(1 / 60);
    return game.world.time - t;
  }, speed);
const r1 = await rate(1);
const r2 = await rate(2);
const r4 = await rate(4);
const r0 = await rate(0);
check('1x advances one game second per second', Math.abs(r1 - 1) < 0.06, r1.toFixed(3));
check('2x doubles the rate', Math.abs(r2 - 2) < 0.06, r2.toFixed(3));
check('4x quadruples the rate', Math.abs(r4 - 4) < 0.06, r4.toFixed(3));
check('pause stops time', r0 === 0);
await g(() => window.__game.setSpeed(1));
const t0 = await g(() => window.__game.world.time);
await frames(4);
check('time advances in real frames', (await g(() => window.__game.world.time)) > t0);
await page.keyboard.press('Space');
await frames(2);
check('space pauses', (await g(() => window.__game.speed)) === 0);
check('paused badge shown', (await page.locator('.paused-badge.on').count()) === 1);
const tp = await g(() => window.__game.world.time);
await frames(3);
check('no time passes while paused', (await g(() => window.__game.world.time)) === tp);
await page.keyboard.press('Space');
check('space resumes', (await g(() => window.__game.speed)) === 1);
await page.locator('.speed button', { hasText: '4×' }).click();
check('4x button', (await g(() => window.__game.speed)) === 4);
await page.locator('.speed button', { hasText: '2×' }).click();
check('2x button', (await g(() => window.__game.speed)) === 2);
await page.locator('.speed button', { hasText: '1×' }).click();

// ---- AI makes progress on its own
await g(() => window.__game.advance(20 * 6));
const state = await g(() => {
  const w = window.__game.world;
  return {
    goals: w.agents.map((a) => a.brain.active?.goal ?? 'none'),
    structures: w.structures.length,
    ate: w.agents.reduce((s, a) => s + a.stats.foodEaten, 0),
    drank: w.agents.filter((a) => a.log.some((e) => e.text.startsWith('Drank'))).length,
  };
});
check('humans pursue goals', state.goals.filter((x) => x !== 'none').length >= 5, state.goals.join(','));
check('a building was started', state.structures >= 1, `${state.structures} structures`);
check('someone has eaten', state.ate > 0, `${state.ate} food eaten`);
check('someone drank', state.drank > 0);

// ---- Selecting a human by clicking on them
await g(() => {
  const game = window.__game;
  const a = game.world.living[0];
  game.controls.follow = null;
  game.controls.jumpTo(a.x, a.z, 14);
  game.controls.snap();
});
await applyCam();
await frames(3);
const screen = await g(() => {
  const game = window.__game;
  const a = game.world.living[0];
  const p = game.session.humans.positionOf(a.id);
  const v = p.clone();
  v.y += 0.6;
  v.project(game.camera);
  return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight, id: a.id };
});
await page.mouse.click(screen.x, screen.y);
await page.waitForTimeout(600);
check('click selects human', (await g(() => window.__game.selectedId)) === screen.id);
check('inspector opens', await page.locator('.inspector.open').isVisible());
const insText = await page.locator('.inspector').innerText();
check('inspector explains goal & reason', /GOAL/i.test(insText) && /REASON/i.test(insText), insText.slice(0, 80).replace(/\n/g, ' '));
await page.keyboard.press('KeyF');
check('F follows selected', await g(() => window.__game.following));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Esc deselects', (await g(() => window.__game.selectedId)) === null);

// ---- Camera controls
const cam0 = await g(() => ({ ...window.__game.controls.target }));
await page.keyboard.down('KeyD');
await frames(4);
await page.keyboard.up('KeyD');
const cam1 = await g(() => ({ ...window.__game.controls.target }));
check('WASD pans camera', Math.hypot(cam1.x - cam0.x, cam1.z - cam0.z) > 2);
const d0 = await g(() => window.__game.controls.distance);
await page.mouse.move(640, 360);
await page.mouse.wheel(0, 400);
await page.waitForTimeout(200);
check('wheel zooms', (await g(() => window.__game.controls.distance)) > d0);

// ---- God powers through the real UI
const target = await g(() => {
  const w = window.__game.world;
  let t = null;
  for (const r of w.resources.values()) {
    if (r.kind === 'tree' && r.state === 'grown') {
      const d = Math.min(...w.living.map((a) => Math.hypot(a.x - r.x, a.z - r.z)));
      if (d > 25) {
        t = r;
        break;
      }
    }
  }
  const game = window.__game;
  game.controls.jumpTo(t.x, t.z, 30);
  game.controls.pitch = 1.2;
  game.controls.snap();
  return { x: t.x, z: t.z, id: t.id };
});
await applyCam();
await frames(2);
await applyCam();
const proj = await g((t) => {
  const game = window.__game;
  const v = new game.camera.position.constructor(t.x, game.world.terrain.heightAt(t.x, t.z), t.z).project(game.camera);
  return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
}, target);
await page.keyboard.press('Digit2');
check('lightning tool selected', (await g(() => window.__game.tool)) === 'lightning');
const strikes0 = await g(() => window.__game.world.stats.lightningStrikes);
await page.mouse.click(proj.x, proj.y);
await page.waitForTimeout(400);
check('lightning strikes', (await g(() => window.__game.world.stats.lightningStrikes)) === strikes0 + 1);
check('lightning ignites / scorches', (await g(() => window.__game.world.scorches.length)) > 0 && (await g(() => [...window.__game.world.resources.values()].some((r) => r.burning > 0))));
await page.keyboard.press('Digit3');
await page.mouse.click(proj.x, proj.y);
check('rain cloud summoned', (await g(() => window.__game.world.weather.clouds.some((c) => c.god))));
await g(() => window.__game.advance(20 * 1.5));
check('rain puts fires out', (await g(() => [...window.__game.world.resources.values()].filter((r) => r.burning > 0).length)) === 0);
await page.keyboard.press('Digit4');
const res0 = await g(() => window.__game.world.resources.size);
await page.mouse.click(proj.x + 60, proj.y + 40);
check('bless grows food', (await g(() => window.__game.world.resources.size)) > res0);
// Heal: hurt someone then heal them via the power.
await g(() => {
  const game = window.__game;
  const a = game.world.living[1];
  a.needs.health = 0.3;
  game.setSpeed(0);
  game.controls.jumpTo(a.x, a.z, 16);
  game.controls.snap();
});
await applyCam();
await frames(3);
await applyCam();
const hp = await g(() => {
  const game = window.__game;
  const a = game.world.living[1];
  const v = game.session.humans.positionOf(a.id).clone().project(game.camera);
  return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
});
await page.keyboard.press('Digit5');
await page.mouse.click(hp.x, hp.y);
check('heal restores health', (await g(() => window.__game.world.living[1].needs.health)) > 0.95);
await page.keyboard.press('Digit1');
await g(() => window.__game.setSpeed(1));

// ---- Save / load round trip
const before = await g(() => {
  const w = window.__game.world;
  return { time: w.time, pop: w.agents.length, structs: w.structures.length, names: w.agents.map((a) => a.name).join(','), res: w.resources.size };
});
const saveMsg = await g(() => window.__app.save('quick'));
check('save succeeds', saveMsg.startsWith('Saved'), saveMsg);
await g(() => window.__game.advance(20 * 3));
const loadMsg = await g(() => window.__app.load('quick'));
check('load succeeds', loadMsg.startsWith('Loaded'), loadMsg);
const after = await g(() => {
  const w = window.__game.world;
  return { time: w.time, pop: w.agents.length, structs: w.structures.length, names: w.agents.map((a) => a.name).join(','), res: w.resources.size };
});
check('load restores state', Math.abs(after.time - before.time) < 0.01 && after.pop === before.pop && after.structs === before.structs && after.names === before.names && after.res === before.res, JSON.stringify({ before, after }));
await g(() => window.__game.advance(20 * 2));
check('simulation continues after load', (await g(() => window.__game.world.living.every((a) => Number.isFinite(a.x) && a.brain.active !== undefined))));

// ---- Menu
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('Esc opens menu', await page.locator('.modal-back.on').isVisible());
await page.locator('.mbtn', { hasText: 'Resume' }).click();
await page.waitForTimeout(300);

// ---- New world
const seedBefore = await g(() => window.__game.world.seed);
await g(() => window.__app.newWorld(777));
await page.waitForTimeout(800);
check('new world generated', (await g(() => window.__game.world.seed)) === 777 && seedBefore !== 777);
check('new tribe spawned', (await g(() => window.__game.world.living.length)) === 6);

// ---- Resize
await page.setViewportSize({ width: 900, height: 600 });
await frames(3);
const size = await g(() => ({ w: window.__game.renderer.domElement.width / window.__game.renderer.getPixelRatio(), aspect: window.__game.camera.aspect }));
check('resize updates renderer', Math.abs(size.w - 900) < 2 && Math.abs(size.aspect - 1.5) < 0.01, JSON.stringify(size));
await page.setViewportSize({ width: 1280, height: 720 });

// ---- Long run stability (headless fast-forward in page)
await g(() => window.__game.advance(20 * 24 * 2));
const health = await g(() => {
  const w = window.__game.world;
  return { alive: w.living.length, nan: w.agents.some((a) => !Number.isFinite(a.x) || !Number.isFinite(a.z)), day: w.day, built: w.structures.filter((s) => s.complete).length };
});
check('two more days run cleanly', !health.nan && health.alive > 0, JSON.stringify(health));
await page.waitForTimeout(1000);

check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await page.screenshot({ path: 'e2e/out/e2e-final.png' });
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
