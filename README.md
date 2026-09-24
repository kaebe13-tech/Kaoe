# Kaoe — a tiny god sandbox

A browser-based 3D god game built with **Three.js + TypeScript**. A small tribe washes up on a
stylized island and has to survive on its own: find water and food, build a campfire, raise huts,
fill a storehouse, plant gardens, raise children, and gather around the fire at night. You watch
from above as their god. Inspect anyone to see what they're thinking and why, then meddle with
lightning, rain, blessings and healing.

Nothing is scripted. Every scene you watch comes from a few interacting systems: needs,
memory, utility-based decisions with commitment, pathfinding, construction, weather and fire.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

Requires Node 20.19+ or 22.12+ (developed on Node 22). No server or API keys are needed. Everything runs in
the browser, including all sound, which is synthesized with WebAudio.

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Type-check and build to `dist/` (the `services/` page is copied verbatim) |
| `npm run preview` | Serve the production build on port 4173 |
| `npm test` | Unit tests (Vitest): world gen, pathfinding, AI, construction, save/load, survival |
| `npm run soak -- --days 10 --pop 6 --seed 1337` | Headless simulation soak test with a stats report |
| `npm run e2e [url]` | Playwright browser test against a running server (needs Chromium; see below) |

URL options: `?seed=123` fixes the island, `?pop=20` sets the starting population (1–80),
`?nointro` skips the title card.

## Controls

| Input | Action |
| --- | --- |
| `W A S D` / arrows, or left-drag the ground | Move the camera (`Shift` = faster) |
| Right-drag, `Q` / `E` | Rotate |
| Mouse wheel, `+` / `-` | Zoom (toward the cursor) |
| `Z` / `X` | Tilt |
| Click a human | Inspect them. Double-click, or `F`, to follow |
| `Tab` / `Shift+Tab` | Jump to the next/previous human |
| `1`–`5` | Observe, Lightning, Rain, Bless, Heal |
| `Space`, `[` `]` | Pause/resume, slower/faster (Pause · 1× · 2× · 4×) |
| `C` | Chronicle: the tribe's history, day by day |
| `H` | Controls card |
| `Esc` | Close panels, deselect, or open the menu (save, load, new world, volume) |
| `F3` or `` ` `` | Developer overlay |
| Minimap | Click or drag to fly there |

## What to watch for

- **Survival**: hunger, thirst and energy drive most behavior. People drink at ponds, pick
  berries and fruit, and sleep at night: in their hut if they have one, otherwise by the fire.
  They carry snacks, eat from the storehouse, and eat before bed so they don't wake up starving.
- **Memory**: everyone remembers the food and water they've seen, and goes back to it. They
  share what they know when they chat. They notice when a bush has been picked clean and
  look elsewhere.
- **Building**: the tribe decides what it needs next (campfire, then a hut per couple, a
  storehouse, berry gardens, more huts as children grow up). Someone marks out a site,
  others chop trees and carry logs, and the building goes up piece by piece.
- **Social life**: chats, friendships, evening circles around the campfire, stargazing,
  sharing food with someone who's starving, tending the injured. Couples in a hut may have
  a child. Children play, stay near their parents, grow up in a few days, and then need a
  home of their own.
- **Danger**: fire spreads between trees and can burn down huts. Lightning injures, knocks
  people down and sends everyone nearby running. Storms roll in on their own and people take
  shelter. Rain puts fires out.
- **Faith**: people who witness your miracles start to believe. Believe enough and they'll
  build a shrine and go there to pray when frightened or grieving.
- **The land remembers**: foot traffic wears dirt paths between camp, ponds and forests.
  Felled trees leave stumps that slowly regrow, and burnt forests recover.

## God powers

| Power | Effect |
| --- | --- |
| ⚡ Lightning | Strikes where you click: ignites trees and buildings, injures and terrifies anyone nearby, scorches the ground |
| 🌧 Rain | Summons a rain cloud: puts out fires, speeds plant regrowth, lets people drink rainwater, sends them to shelter |
| 🌱 Bless | Grows a fruit tree full of fruit (or berry bushes). Nearby people notice, and so does their faith |
| ✚ Heal | Restores a human's health and calms their fear; witnesses gain faith |

## How the AI works

Each human is an `Agent` with needs (hunger, thirst, energy, health, safety, social), traits
(industrious, curious, sociable, timid, brave, big appetite, sleepy, kind), an inventory, a
home, relationships, faith and a `Memory` of resource locations and explored land.

About once a second, each agent **thinks** (`src/ai/Brain.ts`):

1. **Perceive**: update memory with what's in sight (food, ponds, fires).
2. **Evaluate goals** (`src/ai/goals.ts`): every goal (flee, drink, eat, sleep, shelter, comfort,
   recover, help, socialize, pray, play, found a building, supply materials, construct, haul,
   tend the fire, explore, idle) proposes concrete **candidates**. A candidate has a utility score
   built from response curves over needs, time of day, distance, personality and what the tribe
   needs. It also carries a human-readable reason, a target, and a multi-step plan.
3. **Commit**: the current goal gets a hysteresis bonus, with extra stickiness just after it's
   adopted. Short actions like eating, drinking, delivering and chatting can't be interrupted,
   an agent won't bounce straight back to a goal it just dropped, and failed targets go on
   cooldown. Urgent needs (fleeing fire, critical thirst) can still pre-empt anything.
4. **Execute**: the plan is a sequence of small resumable `Action`s (`src/ai/actions.ts`), for
   example *walk to tree → chop 4 logs → walk to site → deliver*. Each action can fail with a
   reason ("Someone had already cut the tree down"). The failure is logged and the agent replans.

Soft **claims** on resources and promised deliveries to building sites spread work across the
tribe without making it robotic: two people still sometimes race for the same bush.

Everything an agent decides, completes, fails, learns or experiences goes into a decision log
with a short first-person thought. The inspector shows the goal, reason, target, the plan with
step-by-step progress, needs, inventory, home, friends and recent decisions. That is how you
can follow one person and understand *why* they're doing what they're doing.

## Architecture

```
src/
  core/        rng, simplex noise, math, typed event emitter, spatial hash
  world/       config, terrain generation (island, mountain, ponds), resource placement
  sim/         World state, Simulation step, needs, ecology (regrowth, fire), weather,
               construction, settlement planning, families, hazards (lightning), blueprints
  agents/      Agent data, Memory, traits, names
  ai/          Brain (utility selection + commitment), goals, actions, locomotion/steering,
               perception, place descriptions
  nav/         NavGrid (walkability + dynamic blockers), A* Pathfinder (+ string pulling),
               PathService (budgeted request queue)
  render/      terrain, water, sky, lighting (day/night), vegetation (instanced), humans
               (instanced procedural rig + poses), structures (staged construction), effects
               (particles, fire, rain, lightning, falling trees), birds, see-through foliage
  input/       god camera controller, terrain picking
  ui/          HUD, inspector, world labels, tribe list, feed, chronicle, minimap, menus
  audio/       synthesized WebAudio ambience and positional one-shots
  save/        versioned save/load to localStorage (quick save + autosave)
  powers/      god powers
  debug/       developer overlay
  game/        Game (render loop, fixed-step sim), WorldSession (sim ↔ views), App (wiring)
```

- The **simulation has no rendering dependencies**. It runs headless for the soak test and the
  unit tests, at more than 10,000 steps per second.
- It advances in **fixed 50 ms steps**, and 2× and 4× simply run more steps per frame. Rendering
  interpolates positions between steps, so motion stays smooth at any speed.
- Views subscribe to simulation events (`resourceChanged`, `structureAdded`, `fx`, `sfx`...)
  instead of polling.
- **Performance**: vegetation and humans are instanced, so each human body part is one draw
  call for the whole population. Pathfinding uses typed-array A* with a per-step budget.
  Spatial hashes handle perception and separation, and AI thinking is staggered.
  50 humans stay well within budget.

## Saving

Use Esc → **Save game** for a quick save. An **autosave** is written every 3 minutes of play.
Saves are versioned JSON in `localStorage` and hold the seed (the island is regenerated from
it), time, weather, every resource's state, structures, agents (needs, inventory, memory,
relationships, faith, family, decision log), foot-traffic wear and the chronicle.

## Developer tools

Press `F3` for FPS, frame and sim timings, draw calls, path statistics, and resource and
particle counts. It can also show each agent's top-scoring goal candidates above their head,
live path lines and blocked nav cells. There are buttons for ×8/×16 speed, skipping ahead an
hour or a day, spawning a human, starving, tiring, hurting or killing the selected human,
summoning a storm, and revealing all food.

## Browser tests

`npm run e2e` drives the game in Chromium with Playwright. It covers startup, speeds and
pause, selection and the inspector, camera, all four powers, save/load round trip, the menu,
new world, resize, a two-day fast-forward, and console errors. It uses `playwright-core`; if
you don't already have a matching Chromium build, run `npx playwright@1.56.1 install chromium`, then:

```bash
npm run dev            # in one terminal
npm run e2e            # in another (defaults to http://localhost:5173/)
```

## Deployment

`npm run build` produces a static site in `dist/` that works from any sub-path.
`.github/workflows/deploy.yml` publishes it to GitHub Pages on pushes to `main`. To enable
it, set **Settings → Pages → Source** to **GitHub Actions**. The existing `services/` page is
published alongside the game at `/services/`, unchanged.
