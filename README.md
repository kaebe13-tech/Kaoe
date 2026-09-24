# Kaoe — a god sandbox of small peoples

A browser-based 3D god game built with **Three.js + TypeScript**. Four small peoples share one
wide continent of meadows, old forests, highlands, crystal wilds and ash fields. Each has its own
culture, leader, knowledge of the world, relations with the others, history and **its own clock**
(pause one, run another at 8×). They find water and food, build villages, explore, meet each
other, pray, and remember what you do to them. You watch from above as their god: inspect anyone,
speak to villagers and leaders, answer or refuse their prayers, and reshape their world.

Nothing is scripted. Every scene comes from interacting systems: needs, memory, utility-based
decisions, pathfinding, construction, weather, fire, diplomacy and the peoples' view of their god.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173  (game + optional AI leader endpoints)
```

Requires Node 20.19+ or 22.12+ (developed on Node 22). Everything works without any API key:
leaders then think with their built-in local minds.

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload, including the `/api/ai/*` endpoints |
| `npm run build` | Type-check and build to `dist/` |
| `npm run serve` | Production server: serves `dist/` and the AI endpoints (`PORT`, default 8787) |
| `npm run build:artifact` | Single-file static page (no server; local minds only) |
| `npm run check:secrets` | Fails if an API key appears in the bundles or in any tracked file |
| `npm test` | Unit tests (Vitest): world, pathfinding, civilizations, powers, save/load, AI validation, server |
| `npm run soak -- --days 10 --civs 4 --speeds 1,4,0.25,1` | Headless soak test with per-civilization reports |

URL options: `?seed=123` fixes the world, `?pop=10` sets people per civilization, `?nointro` skips the title.

## AI leaders (optional Gemini)

Leaders always decide with a local planner first. If a model is available it may **refine** that
decision a moment later, and it gives leaders and villagers their own words when you speak to them.

1. `cp .env.example .env` and set `GEMINI_API_KEY` (from Google AI Studio). Never commit `.env`
   (it is git-ignored).
2. `npm run dev` (or `npm run build && npm run serve`). The HUD shows **✦ AI** when connected,
   **Local** otherwise. Toggle it in the menu (Esc → *AI leaders*).

How it is kept safe and bounded:

- The key lives only in the server process (`server/`); the browser calls the same-origin
  `/api/ai/leader`, never Google. The bundle never contains it (`npm run check:secrets`).
- The server enforces a same-origin check, a 32 KB body limit, per-client and global rate
  limits, a concurrency cap, timeouts, and a model fallback chain (`gemini-2.5-flash` first;
  overloaded or missing models are skipped; models that reject `thinkingConfig` are retried
  without it).
- Models only ever produce **structured JSON** (`responseSchema`). Every reply is validated on
  the server and again in the browser (`shared/leaderProtocol.mjs`): the priority must be one of
  13 known objectives, targets must name real regions and known peoples, text is cleaned and
  length-limited, and anything else is dropped. Unknown actions are rejected. Nothing generated
  is ever executed.
- The model never moves anyone or touches physics: it picks a high-level priority, a mood,
  a memory and words. Whether a leader **obeys the god** is decided deterministically by the
  simulation (faith, fear, trust, anger, personality, feasibility); the model only voices it.
- Calls are asynchronous and never block the game. Failures (timeout, rate limit, network,
  malformed or invalid output) fall back to the local mind, with backoff and a circuit breaker.
  Tests cover each failure mode with a mock provider.

## Controls

| Input | Action |
| --- | --- |
| `W A S D` / arrows, or left-drag the ground | Move the camera (`Shift` = faster) |
| Right-drag, `Q` / `E` · wheel · `Z` / `X` | Rotate · zoom · tilt |
| Click · double-click / `F` | Inspect a person · follow them |
| `T` | Speak to the selected person as the god (leaders answer for their people) |
| `1` · `2`–`7` · `G` | Observe · powers of the current group · next power group |
| `M` | World view (and back); click a people's name to open their panel |
| `C` | Chronicles: the world's history and each people's own history |
| `Space`, `[` `]` | Pause · slower/faster (world speed ¼× to 16×) |
| `Esc` · `H` · `F3` | Menu/close · controls card · developer overlay |

Click a people in the top bar to see their leader, mood, plans, prayers, neighbours and how they
see you, change **the speed of their time**, speak to their leader, or read their history.

## God powers

Seven groups, 27 powers. Each changes the simulation, and each people interprets it through
what they saw: acts that help them build faith and trust, acts that hurt them build fear and
anger, and striking their enemies can please them.

| Group | Powers |
| --- | --- |
| Creation | Fruit Tree, Grow Forest, Spring (opens a new pond), Stone & Crystal |
| Destruction | Lightning, Meteor (falls from the sky and leaves a crater), Earthquake, Wildfire |
| Weather | Rain, Storm, Mist, Drought, Clear Skies |
| Life | Heal, Resurrect (a body or a fresh grave), Bounty, Fertility |
| World | Shape Land (raise; `Shift` lowers), Carry (pick someone up and set them down), Vision |
| Peoples | Inspire, Peace, Sanctuary, Curse, Wrath |
| Miracles | Manifest (come down as a pillar of light; people gather and kneel), Sign in the Sky |

**Speaking as the god.** What you type is classified locally as a question, command, promise,
threat, blessing or plain words. Commands map to objectives (explore a region, honour you, make
peace, gather food, found a village…); the leader obeys or refuses for reasons shown in the
panel, and remembers it. Promises are remembered too: keep them and trust grows, break them and
it falls. Leaders also pray to you; answer from the civ panel (**Grant** performs the fitting act)
or refuse, or ignore them and let the prayer expire.

**The world has moods of its own**: droughts, great blooms, crystal surges, strange mists,
tempests and falling stars come and go, and the peoples take note.

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
