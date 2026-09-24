import '@fontsource/fredoka/500.css';
import '@fontsource/fredoka/600.css';
import '@fontsource/nunito/400.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/800.css';
import './ui/styles.css';
import { App, showIntro } from './game/App';
import { randomSeed } from './core/rng';

const params = new URLSearchParams(location.search);
const seed = params.has('seed') ? Number(params.get('seed')) : randomSeed();
const pop = Math.max(1, Math.min(80, Number(params.get('pop') ?? 6) || 6));
const app = new App(document.getElementById('app')!, seed, pop);
const game = app.game;
if (params.has('hour')) game.world.time = Number(params.get('hour')) * 20;
game.start();

if (params.has('nointro')) {
  game.setSpeed(1);
} else {
  // The world idles gently behind the title card; time starts when the player begins.
  game.setSpeed(0);
  showIntro(() => game.setSpeed(1));
}

(window as unknown as Record<string, unknown>).__app = app;
(window as unknown as Record<string, unknown>).__game = game;
(window as unknown as Record<string, unknown>).__ready = true;
