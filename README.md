# HYPERDRIVE — 3D Space Infinite Runner

A standalone WebGL space runner built with **Three.js + vanilla JavaScript + HTML/CSS**.
No build step, no runtime CDN, no external assets: Three.js r186 is vendored in
`vendor/`, every texture is painted procedurally into a canvas, and every sound is
synthesised with the Web Audio API at runtime.

Thread the collapsing lanes of the Kessel Rift. Wall clusters of one to five tiles
stand in the flight path: they telegraph before they materialise, deepening from
light red to dark red as they close in, so read the lattice, pick a side and slip
past — then collect warp power-ups. The plane is **endless in every direction**: no
left or right borders, no edge to the world, and the clusters are laid down around
the ship wherever it flies.

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
axis and the index simply keeps counting (…, −8, −7) as you fly out.**Wall clusters + warning system** — a row is **one to five tiles standing side by
side**, never more (the cap is a single constant, `WALLS.maxTiles`, and both the
spawner and the renderer read it). Each tile is one lane wide and only just taller
than the hull (2.05 × 1.25 world units, shrunk by a seam so neighbours read as
separate walls), so even a five-tile row is 24 world units across instead of a
wall across the screen. Rows are anchored on the lane the ship is *predicted* to
hold when they arrive, so a hard strafe does not leave the cluster behind, and each
one runs through two phases:

1. `warn` — a translucent lattice marks the lanes the tiles will occupy: a floor
   strip with travelling chevrons, edge lasers and a vertical warning grid, drawn
   in **light red `#ff8888`** and eased smoothly to **dark red `#880000`** and then
   deepest **`#440000`** over the warning, so the colour itself counts the time
   down. The warning's *length* and *lookahead distance* both scale with speed (a
   longer floor strip and a cluster that spawns further down the track the faster
   you fly), which keeps reaction distance growing even as the window shrinks.
2. `solid` — the tiles materialise with a bright **pop** (a flash burst per tile
   and one shockwave per row) and collide until they sweep past.

Because the cluster is local, the dodge is lateral: fly around it, not through a
hole in a wall. Most rows stand on the lane the ship is heading for (82 %, biased
to the near edge so the usual ask is a one-lane move), and the rest slide past one
or two lanes clear — so **flying straight is a losing line, not a safe one**,
without every row demanding a full lane change. Cluster width is drawn per row
(1–2 tiles early in a run, up to the five-tile cap late), an orb in flight pulls the
cluster to one side so its reward lane stays open, and the row spacing is a
*distance* draw, not a timer. The HUD calls out the threatened lanes ("5 tiles at
lanes −2,−1,0,+1,+2 · in your lane"). On top of the cluster visuals, the lane grid
tints red while a row is inbound.

**Celestial horizon** — a glowing vector sun sits exactly on the vanishing point of
the flight axis, wrapped in a fan of light rays and tightening corona rings. It is
positioned from the camera every frame, so it stays welded to the horizon on any
aspect ratio, field of view or strafe distance, and it is drawn behind the gameplay
layer (depths off, additive) so the cluster warnings and power-ups always read in
front of it.

**Difficulty scaling** — base speed ramps over time, the warning window shortens
(1.80 s → 0.55 s at cruise speed, stretched back out with speed to a 2.20 s
ceiling), and the clusters get wider and denser: rows draw 1–2 tiles at the start
of a run and 2–5 late, while the base gap between rows grows from 108 to 176 world
units so that in *play* they arrive every ≈2.9 s early and ≈1.0 s at full
difficulty. Spacing is laid down by distance travelled, with three draws staggered
on top of the base gap — a tight burst (×0.6), an ordinary jittered gap and the
occasional long breather (×1.85) — so a 600 s replay sees gaps anywhere from 64 to
391 world units (mean 183, sd 78) and 0.44–3.53 s apart. Every row still carries
reachability constraints as distance grows: the fairness model rejects placements
the ship cannot clear in the time available and retries them, so the deep slides
out of a wide cluster only happen when there is room for them.

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
src/obstacles.js         pooled wall clusters + warning indicators, phase management
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
npm test                 # 83 pure-logic checks: difficulty, tile rows, spacing, collisions, fairness
node scripts/fairness.js # proves the spawner never emits an undodgeable row sequence
node scripts/simulate.js # balance benchmark + perimeter probes (hold a direction / never steer)
node scripts/e2e.js      # 137 browser checks (Playwright, real page over HTTP)
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

The row cap is part of the model, not just the art: `tileRow()` clamps a row to
`WALLS.maxTiles`, and `scripts/test-logic.js` sweeps every difficulty and 800
generated placements to assert that no row ever stands more than five tiles side by
side (a request for nine still builds five) — and that the widest row still leaves
21 of the 25 modelled lanes open. The spacing draws are checked the same way: 600
draws per difficulty band must produce a >2.5× spread and more than 100 distinct
distances, so a future tuning change cannot quietly turn the spawner back into a
metronome.

`scripts/fairness.js` replays the real spawner for 600 s of flight (626 rows up to
difficulty 1.0, **0 relaxed rows**, 1.00 spawn attempts per row) and confirms a
valid dodge path for every one — while 77 % of those rows block the lane the
verifier holds, so the proof is not passing by leaving the player alone. The same
run reports the row geometry the renderer builds: 1–5 tiles per row, 5–24 world
units wide, 64–391 world units between rows (mean 183, sd 78) and 0.44–3.53 s
apart. `scripts/simulate.js` runs the complementary probes and requires that a
pilot who holds one direction for ever *and* a pilot who never steers at all both
die, in every run (median survival ≈215 m either way, against ≈5.1 km for the
greedy pilot — the denser cadence costs the skilled game about 40 % of its distance
compared with the old full-width rows, which is the price of roughly twice as many
rows per second).

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

Because the spawner keeps dropping clusters on the lane the ship is holding, a
pilot that never touches the controls dies in ~4 s (≈215 m). The cadence check in
`scripts/e2e.js` therefore keeps the ship shielded while it samples the arrival
rhythm (0.48 rows/s at the start of a run in the browser), and it samples the
spacing the live spawner drew rather than assuming a constant: the last run
recorded 7 gaps between 63 and 236 world units, a 3.75× spread.

Best distance is stored in `localStorage` (wrapped in a try/catch so private-mode
browsers fall back to an in-memory store).
