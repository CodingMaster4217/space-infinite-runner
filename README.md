# HYPERDRIVE — 3D Space Infinite Runner

A standalone WebGL space runner built with **Three.js + vanilla JavaScript + HTML/CSS**.
No build step, no runtime CDN, no external assets: Three.js r186 is vendored in
`vendor/`, every texture is painted procedurally into a canvas, and every sound is
synthesised with the Web Audio API at runtime.

Thread the collapsing lanes of the Kessel Rift. Wall barriers span the whole play
area and leave a single gap: they telegraph before they materialise, deepening from
light red to dark red as they close in, so read the lattice, cross to the hole and
collect warp power-ups. The plane is **endless in every direction**: no left or
right borders, no edge to the world — and no perimeter to hide in either, because
every barrier is generated around the ship wherever it flies.

## Run it

```bash
npm start            # zero-dependency static server → http://localhost:3000
```

Or serve the folder with any static file server (`python3 -m http.server 3000`) —
the only requirement is that ES modules are served over HTTP(S).

## Controls

| Input | Action |
| --- | --- |
| `←` `→` / `A` `D` | Steer (analog, continuous — no lane snapping) |
| Drag anywhere on the playfield | Steer (touch / mouse, relative drag) |
| On-screen `◀ ▶` | Steer (mobile buttons, also clickable on desktop) |
| `P` / `Esc` | Pause / resume |
| `R` | Instant restart |
| `Enter` / `Space` | Launch, resume or restart depending on state |
| `M` / 🔊 button | Mute / unmute |

## Gameplay systems

**Ship** — procedural hull built from Three.js primitives, glowing cyan engine
trail (pooled particle system), banking roll into turns, speed-reactive nozzle
flames, under-glow and shield/invincibility auras.

**Endless plane** — infinite scrolling grid floor with lane separators (custom GLSL
shader evaluated in *world space*, so the grid tiles forever and the plane can be
re-centred on the camera without the lines sliding). No side walls, no rails and no
lateral clamp: the ship steers as far left or right as it likes, and the ground
plane, starfield, nebula backdrop and drifting debris field all track the camera so
no edge ever comes into view. Lane space is unbounded — lane 0 sits on the world
axis and the index simply keeps counting (…, −8, −7) as you fly out.

**Full-width barriers + warning system** — every row is a barrier that covers the
entire play area around the ship: the band it could physically reach while the row
is in flight, plus everything visible beside it (7–14 lanes each side, 106–134 world
units of wall per row). It leaves exactly **one free gap**, and each row runs
through two phases:

1. `warn` — a translucent lattice marks the lanes the barrier will occupy: a floor
   strip with travelling chevrons, edge lasers and a vertical warning grid, drawn
   in **light red `#ff8888`** and eased smoothly to **dark red `#880000`** and then
   deepest **`#440000`** over the warning, so the colour itself counts the time
down. The warning's *length* and *lookahead distance* both scale with speed (a
   longer floor strip and a barrier that spawns further down the track the faster
   you fly), which keeps reaction distance growing even as the window shrinks.
2. `solid` — the barrier materialises with a bright **pop** (white-hot edges, a
   flash burst and a shockwave per slab) and collides until it sweeps past.

Because there is nothing to fly around, holding a direction cannot dodge anything:
the hole is where the game is. Rows are anchored on the lane the ship is *predicted*
to hold when they arrive, so a hard strafe does not leave the barrier behind — and
the hole is never left on that lane either: it is pushed at least one lane to one
side, so **the barrier demands a lane change on every single row**. Flying straight
is a losing line, not a safe one. The only exceptions are the two biases that keep a
*specific* lane interesting — an orb in flight pulls the hole towards itself so the
reward stays collectable, and a row sometimes continues the hole the last barrier
left open. The HUD calls out the **gap** ("gap at lane +2 · in your lane"). On top
of the barrier visuals, the lane grid tints red while a wall is inbound.

**Celestial horizon** — a glowing vector sun sits exactly on the vanishing point of
the flight axis, wrapped in a fan of light rays and tightening corona rings. It is
positioned from the camera every frame, so it stays welded to the horizon on any
aspect ratio, field of view or strafe distance, and it is drawn behind the gameplay
layer (depths off, additive) so the barrier warnings and power-ups always read in
front of it.

**Difficulty scaling** — base speed ramps over time, the warning window shortens
(1.80 s → 0.55 s at cruise speed, stretched back out proportionally as the run gets
faster), the free gap narrows (3 → 1 lanes), the barrier widens (9 → 14 lanes each
side) and the clear track between barriers tightens (1.15 s → 0.72 s of lane-change
window), with reachability constraints applied to every row as distance grows. The
hole also walks further off the ship's lane less often late in a run: the lane-change
window is only a lane transit plus the guard margin wide, so the fairness model
rejects the long slides and retries them as one-lane threads.

**Power-ups** — hovering orbs with three behaviours:

| Orb | Effect |
| --- | --- |
| Speed Boost (green/cyan) | Warp burst ×1.95 speed, temporary invincibility; walls shatter for bonus distance and star streaks stretch |
| Warp Brake (blue) | Time dilation — world and obstacles slow to 42 %, ship keeps full agility |
| Shield Core (gold) | Absorbs exactly one wall impact, then shatters (with a short grace window) |

**States** — Start menu → gameplay ⇄ paused → game over, with a modal per state and
an instant restart that resets everything in place (no page reload).

## Project layout

```
index.html              canvas + HUD + modal markup
styles/main.css          cyberpunk dark-mode UI, responsive layout, FX overlays
src/main.js              bootstrap, WebGL guard, debug surface
src/game.js              state machine, fixed-step loop, collisions, power-up effects
src/player.js            ship model, steering physics, banking, engine trail, auras
src/environment.js       starfield, nebula, endless-plane shaders, debris, lights
src/obstacles.js         pooled wall barriers + warning indicators, phase management
src/powerups.js          collectible orbs (pooled)
src/collision.js         pure AABB/sphere math, difficulty curves, spawn cadence
src/fairness.js          spawner fairness model + fair row selection (shared by tests)
src/audio.js             Web Audio synthesis (hum, swoosh, chime, alarm, crash)
src/input.js             keyboard + touch + drag steering, action routing
src/ui.js                HUD readouts, power-up tray, alerts, toasts, modals
src/vfx.js               procedural textures, pooled bursts, shockwave rings
scripts/                 dev server + verification suites (see below)
vendor/three.module.js   Three.js r186 (vendored)
```

## Verification

```bash
npm run check            # parse every ES module (node --check)
npm test                 # 78 pure-logic checks: difficulty, barriers, ramp, collisions, fairness
node scripts/fairness.js # proves the spawner never emits an undodgeable barrier sequence
node scripts/simulate.js # balance benchmark + perimeter probes (hold a direction / never steer)
node scripts/e2e.js      # 136 browser checks (Playwright, real page over HTTP)
node scripts/perf-probe.js --frames 12   # isolates frame-time costs layer by layer
```

`scripts/e2e.js` needs Playwright plus a browser; on a bare container install the
Chromium shared libraries with `scripts/setup-browser-deps.sh` (no root required).

### Fairness guarantee

`src/fairness.js` models the obstacle field as a timeline of *phases* with a
constant set of solid walls, where adjacent free lanes form pockets the ship can
move within; travel time between any two lanes is derived from the ship's real
acceleration limits (memoised per lane delta, so it works for unbounded lanes).
Every candidate row is validated against everything already in flight — from every
pocket the ship could legally be occupying — and rejected unless a physically
dodgeable continuation exists. Each row is anchored to the lane the ship is
predicted to hold, so the danger follows the player across the endless plane instead
of sitting in a fixed corridor.

A full-width barrier changes what "dodgeable" means: while a row is sweeping past,
the ship cannot cross any blocked lane, so the only place it can change lanes is the
clear track *between* two barriers. Row cadence is therefore derived rather than
tuned by feel — `2 × solidDuration + rowBreathing`, where the breathing window
(1.15 s → 0.72 s) is guaranteed to be longer than a one-lane transit (0.46 s) — and
the jitter only ever adds time. Without that window every hole would have to sit on
the lane the ship already occupies, and holding a direction would be a winning
strategy. `scripts/fairness.js` replays the real spawner for 600 s of flight (262
rows up to difficulty 1.0, 0 relaxed rows, 1.00 spawn attempts per row) and confirms a
valid dodge path for every one — while 97.3 % of those rows block the lane the ship is
anchored on, because the hole is placed off it by construction. `scripts/simulate.js`
runs the complementary probes and requires that a pilot who holds one direction for
ever *and* a pilot who never steers at all both die, in every run (median survival
195 m either way, against ≈10 km for the greedy pilot).

## Performance notes

The game loop is decoupled from rendering: gameplay runs on a fixed 1/60 s step
(catching up to 8 steps per frame), rendering happens once per animation frame, and
the renderer scales its pixel ratio down automatically if frames get slow. Measured
CPU budgets on this machine: **≈0.1–0.6 ms per logic step** and **≈0.7–1.2 ms per
render submission** with ~35–55 draw calls and ~1–3 k triangles.

> This repository was developed on a GPU-less VM, so the *rasterised* frame time
> (1.5–6 fps at 1440×900 through SwiftShader) is an artefact of software rendering
> and is **not** a measurement of the game's 60 FPS behaviour on real hardware. Use
> `scripts/perf-probe.js` on a target device to measure actual fill-rate headroom;
> HUD backdrop blur and the full-screen FX overlays are the first things to cut on
> very weak GPUs (already disabled for coarse-pointer/mobile profiles in CSS).

`scripts/perf-probe.js` ranks the remaining layers on this machine (760 ms frames
through SwiftShader, so treat the ratios, not the absolutes): nebula backdrop
≈ −120 ms, celestial horizon ≈ −125 ms, full-screen FX overlays ≈ −8 ms, endless
ground plane ≈ −30 ms, debris field ≈ −22 ms. Row-to-row noise on the shared VM is
larger than several of those deltas (a full 9-row sweep reorders the cheap layers),
so read them as ordinals, not measurements. Both heavy layers are additive
full-screen fill: the ground plane is a single full-width quad, and the horizon is a
ray fan plus a glow disc locked to the vanishing point. On a fill-bound device the
nebula is the first thing to cut, then the horizon ray fan.

Because the spawner now demands a lane change on every row, a pilot that never
touches the controls dies in ~4 s (195 m). The cadence check in `scripts/e2e.js`
therefore keeps the ship shielded while it samples the arrival rhythm, rather than
relying on straight flight to survive the measurement.

Best distance is stored in `localStorage` (wrapped in a try/catch so private-mode
browsers fall back to an in-memory store).
