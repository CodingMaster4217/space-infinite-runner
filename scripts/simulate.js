#!/usr/bin/env node
/**
 * Gameplay balance simulation — no browser, no rendering.
 *
 * Drives the pure difficulty/spawn/collision modules with a human-like reactive
 * pilot (fixed reaction delay, real lateral acceleration limits) to answer the
 * balance question: is the pre-wall warning window actually dodgeable as the
 * game speeds up?
 *
 *   node scripts/simulate.js [--runs 25] [--seconds 180] [--reaction 0.2]
 */

import {
  baseSpeedAt,
  boxesOverlap,
  difficultyAt,
  gapLanesAt,
  laneWindowFor,
  playerBox,
  rowIntervalAt,
  solidDurationAt,
  wallBox,
  wallHalfLanes,
  warningDurationAt,
} from '../src/collision.js';
import { selectFairRow } from '../src/fairness.js';
import { LANES, SHIP, laneCenterX, laneIndexAt } from '../src/config.js';
import { clamp, createRandom } from '../src/utils.js';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const RUNS = getArg('--runs', 25);
const MEDIAN_BAR = getArg('--median-bar', 1200);
const MAX_SECONDS = getArg('--seconds', 180);
const REACTION = getArg('--reaction', 0.2);
// The pilot plans over the window the game actually announces (the warning phase),
// capped here. Anything further ahead is information the player never sees.
const LOOKAHEAD = getArg('--lookahead', 2.6);
const VERBOSE = args.includes('--verbose');
/** 'all' (balance + probes) or a single probe: 'stubborn' | 'straight'. */
const PILOT = args.includes('--pilot') ? args[args.indexOf('--pilot') + 1] : 'all';
const DT = 1 / 60;

/** Per-frame trace captured in verbose mode for post-mortem inspection. */
function traceLine(t, ship, wall, decision, decisionAt) {
  return (
    `    t=${t.toFixed(2)}s ship.x=${ship.x.toFixed(2)} (lane ${laneIndexAt(ship.x)}) ` +
    `target=${decision ? decision.desiredX.toFixed(2) : '—'}` +
    `${decision ? ` armed@${decisionAt.toFixed(2)}s` : ''} ` +
    `| nearest wall lanes ${wall ? `${wall.start}..${wall.start + wall.span - 1}` : '—'} ` +
    `z=${wall ? wall.z.toFixed(1) : '—'} ` +
    `ttImpact=${wall ? Math.max(0, -wall.z / Math.max(1, wall.speed)).toFixed(2) : '—'}s ` +
    `phase=${wall ? (wall.z >= -wall.solid * wall.speed ? 'SOLID' : 'warn') : '—'}`
  );
}

/**
 * Numeric model of the ship's own lateral physics: how long until the hull can
 * be sitting at `targetX`? Used by the pilot to judge whether a lane is still
 * reachable before an in-flight wall row arrives there.
 */
function timeToReach(ship, targetX) {
  const dt = 0.05;
  const dir = Math.sign(targetX - ship.x) || 1;
  let v = ship.vel;
  let x = ship.x;
  let t = 0;
  while (Math.abs(targetX - x) > 0.2 && t < 5) {
    const target = dir * SHIP.maxLateralSpeed;
    v += clamp(target - v, -SHIP.lateralAccel * dt, SHIP.lateralAccel * dt);
    x += v * dt;
    t += dt;
  }
  return t;
}

/** Lanes that a barrier blocks (it spans the play area apart from its gap). */
const rowBlocks = (wall, lane) => wall.blocked.includes(lane);

/**
 * Collision boxes of a barrier: one per slab, leaving the gap open. `sweep` is the
 * distance covered this step, so a fast wall cannot pass through the ship between
 * frames (same continuous test the renderer-side game uses).
 */
const rowBoxes = (wall, z, sweep = 0) =>
  wall.segments.map((s) => wallBox(s.start, s.span, z - sweep / 2, 2.2 + sweep));

/** Look-ahead horizon (seconds) the pilot refuses to be blocked inside. */
let NEAR_TERM = 1.1;

/** Lanes the pilot scans: a window around itself, since lane space is infinite. */
const SCAN = LANES.count + 1;

/**
 * Human-like pilot: read the warning the game shows, then fly for the hole in the
 * barrier that arrives next, committing only once the hole is reachable in time.
 * Myopic on purpose (fixed reaction delay, real lateral physics, capped lookahead)
 * so the numbers it produces are a lower bound on playability.
 */
function chooseLane(walls, ship, speed) {
  const upcoming = walls
    .filter((w) => w.z < 30)
    .map((w) => ({ ...w, tt: Math.max(0, -w.z / Math.max(speed, 1)) }));
  const current = laneIndexAt(ship.x);
  const hold = laneCenterX(current);

  const ahead = upcoming.filter((w) => w.tt > 0).sort((a, b) => a.tt - b.tt);
  if (!ahead.length) return hold;

  // the barrier the pilot is acting on: the soonest one inside the warning window
  const target = ahead[0];
  const horizon = Math.min(NEAR_TERM, target.warn + target.solid);
  if (target.tt > horizon && !rowBlocks(target, current)) return hold;

  // aim for the reachable hole, nearest first
  const holes = (target.gap.length ? target.gap : target.free)
    .slice()
    .sort((a, b) => Math.abs(a - current) - Math.abs(b - current));
  for (const lane of holes) {
    if (Math.abs(lane - current) <= 0) return laneCenterX(lane);
    if (timeToReach(ship, laneCenterX(lane)) <= target.tt - 0.05) return laneCenterX(lane);
  }

  // not reachable any more: commit to the closest hole and hope (this is what a
  // human does too, and it is why this pilot is a lower bound)
  const last = holes.find((lane) => !upcoming.some((w) => w.tt <= 0.05 && rowBlocks(w, lane)));
  return laneCenterX(last ?? holes[0] ?? current);
}

/**
 * @param {number} seed
 * @param {'greedy'|'stubborn'|'straight'} pilot
 *   greedy   — a myopic reactive pilot (the playability benchmark)
 *   stubborn — holds one direction for ever, never looking at the walls
 *   straight — never touches the controls at all
 */
function simulate(seed, pilot = 'greedy', holdDir = -1) {
  const rand = createRandom(seed);
  const ship = { x: 0, vel: 0 };
  let distance = 0;
  let elapsed = 0;
  let topSpeed = 0;
  let difficulty = 0;
  let spawnTimer = 1.35;
  let previousFree = null;
  let walls = [];
  let deaths = 0;
  let closestMargin = Infinity;
  let decision = null;
  let committedX = null;
  let committedAt = 0;
  let perceivedX = null;
  let perceivedAt = 0;
  let firstFailure = null;

  const trace = [];

  const stepShip = (axis) => {
    const target = axis * SHIP.maxLateralSpeed;
    const accel = SHIP.lateralAccel * (0.72 + clamp(topSpeed / (205 * 21), 0, 1) * 0.6);
    const delta = target - ship.vel;
    ship.vel += clamp(delta, -accel * DT, accel * DT);
    ship.x += ship.vel * DT;
  };

  while (elapsed < MAX_SECONDS) {
    difficulty = difficultyAt(distance);
    const speed = baseSpeedAt(elapsed, difficulty);
    topSpeed = Math.max(topSpeed, speed);
    const travel = speed * DT;
    distance += travel;
    elapsed += DT;

    /* spawn ---------------------------------------------------------- */
    spawnTimer -= DT;
    if (spawnTimer <= 0) {
      const warn = warningDurationAt(difficulty, speed);
      const solid = solidDurationAt(difficulty);
      const halfLanes = wallHalfLanes({ speed, warnDuration: warn, solidDuration: solid });
      const ahead = walls
        .filter((w) => w.z < 0)
        .map((w) => {
          const arrivalIn = Math.max(0, -w.z / speed);
          return {
            free: w.free,
            materialiseIn: Math.max(0, arrivalIn - w.solid),
            arrivalIn,
          };
        })
        .sort((a, b) => a.materialiseIn - b.materialiseIn);
      // the game anchors on the lane the ship is *predicted* to hold
      const anchorLane = laneIndexAt(ship.x + ship.vel * (warn + solid));
      const picked = selectFairRow({
        rand,
        difficulty,
        inFlight: ahead,
        previousFree,
        warnDuration: warn,
        solidDuration: solid,
        anchorLane,
        laneCount: laneWindowFor(halfLanes),
        gapWidth: gapLanesAt(difficulty),
      });
      const row = picked.row;
      previousFree = row.free;
      walls.push({
        start: row.start,
        span: row.span,
        segments: row.segments,
        blocked: row.blocked,
        gap: row.gap,
        free: row.free,
        z: -(warn + solid) * speed,
        warn,
        solid,
        speed,
        announced: false,
        born: elapsed,
      });
      spawnTimer = Math.max(rowIntervalAt(difficulty, rand), 34 / Math.max(20, speed));
    }

    /* move walls + react --------------------------------------------- */
    for (const wall of walls) {
      wall.z += travel;
      const ttImpact = Math.max(0, -wall.z / Math.max(speed, 1));
      wall.ttImpact = ttImpact;
      if (!wall.announced && ttImpact <= wall.warn + wall.solid) {
        wall.announced = true;
      }
    }

    // perceive -> commit after a human reaction delay -> steer
    let axis = 0;
    if (pilot === 'greedy') {
      const desiredX = chooseLane(walls, ship, speed);
      if (desiredX === null) {
        committedX = null;
      } else if (committedX === null) {
        committedX = desiredX;
        committedAt = elapsed;
      } else if (Math.abs(desiredX - committedX) > 0.5) {
        if (perceivedX === null || Math.abs(perceivedX - desiredX) > 0.5) {
          perceivedX = desiredX;
          perceivedAt = elapsed;
        } else if (elapsed - perceivedAt >= REACTION) {
          committedX = desiredX;
          committedAt = elapsed;
        }
      }
      axis =
        committedX === null ? 0 : Math.abs(committedX - ship.x) < 0.25 ? 0 : clamp((committedX - ship.x) / 0.8, -1, 1);
      decision = committedX === null ? null : { desiredX: committedX, armedAt: committedAt };
    } else {
      // the perimeter probe: hold one direction (or never steer) and see whether
      // the barriers finally close in
      axis = pilot === 'stubborn' ? holdDir : 0;
      decision = { desiredX: axis };
    }
    stepShip(axis);

    if (VERBOSE) {
      const nearest = walls
        .filter((w) => w.z < 20)
        .sort((a, b) => b.z - a.z)[0];
      trace.push(traceLine(elapsed, ship, nearest, decision, decision ? decision.armedAt : 0));
    }

    /* collisions ------------------------------------------------------ */
    const shipBox = playerBox(ship.x, 0.75, 0);
    for (const wall of walls) {
      if (wall.z < -wall.solid * speed) continue; // still in the warning phase
      const hit = rowBoxes(wall, wall.z, travel).some((box) => boxesOverlap(shipBox, box));
      if (hit) {
        deaths += 1;
        if (!firstFailure) {
          firstFailure = {
            t: elapsed,
            distance,
            difficulty,
            speed,
            warn: wall.warn,
            solid: wall.solid,
            laneStart: wall.start,
            laneSpan: wall.span,
            gap: wall.gap.slice(),
            shipLane: laneIndexAt(ship.x),
          };
        }
        wall.z = 999; // consumed
        continue;
      }
      // record how close the hull came to the barrier edge as it swept past
      if (Math.abs(wall.z) < 1.2) {
        for (const box of rowBoxes(wall, 0, travel)) {
          closestMargin = Math.min(closestMargin, Math.max(0, Math.abs(ship.x - box.cx) - box.hx));
        }
      }
    }
    walls = walls.filter((w) => w.z <= 40 && w.z < 900);
    if (deaths > 0) {
      if (VERBOSE) {
        process.stdout.write('  last 2 seconds before the crash:\n');
        trace.slice(-120).forEach((line) => process.stdout.write(`${line}\n`));
      }
      break;
    }
  }

  return {
    survived: deaths === 0,
    seconds: elapsed,
    distance: Math.round(distance),
    topSpeedKmh: Math.round(topSpeed * 21),
    difficulty: Number(difficulty.toFixed(3)),
    firstFailure,
    closestMargin: Number.isFinite(closestMargin) ? Number(closestMargin.toFixed(2)) : null,
  };
}

NEAR_TERM = LOOKAHEAD;

const PROBE_RUNS = getArg('--probe-runs', 12);

/* Single-probe mode: run just the perimeter question, for a focused check. */
if (PILOT === 'stubborn' || PILOT === 'straight') {
  const probe = [];
  for (let i = 0; i < PROBE_RUNS; i += 1) {
    probe.push(
      PILOT === 'stubborn'
        ? simulate(777 + i * 104729, 'stubborn', i % 2 === 0 ? -1 : 1)
        : simulate(4242 + i * 104729, 'straight')
    );
  }
  const died = probe.filter((r) => !r.survived).length;
  const distances = probe.map((r) => r.distance).sort((a, b) => a - b);
  const first = probe.find((r) => r.firstFailure);
  process.stdout.write(
    `HYPERDRIVE perimeter probe — pilot: ${PILOT === 'stubborn' ? 'holds one direction' : 'never steers'}, ` +
      `${probe.length} runs, up to ${MAX_SECONDS}s\n\n` +
      `  runs punished by a barrier      : ${died}/${probe.length}\n` +
      `  median survival distance        : ${distances[Math.floor(distances.length / 2)]} m\n` +
      `  longest survival                : ${distances[distances.length - 1]} m\n` +
      (first && first.firstFailure
        ? `  first crash                     : t=${first.firstFailure.t.toFixed(1)}s, ship lane ` +
          `${first.firstFailure.shipLane}, gap lanes ${first.firstFailure.gap.join(',')}, ` +
          `barrier spanning ${first.firstFailure.laneSpan} lanes\n`
        : '') +
      `\n${died === probe.length ? 'PASS' : 'FAIL'} — there is no unpunished perimeter: holding a ` +
      `direction runs into a full-width barrier.\n`
  );
  process.exit(died === probe.length ? 0 : 1);
}

const runs = [];
for (let i = 0; i < RUNS; i += 1) runs.push(simulate(1000 + i * 7919));

/*
 * Perimeter probe — the Step 3 question: with every barrier spanning the play
 * area, can a player who just holds a direction (or touches nothing at all) stay
 * alive and unpunished? Both probes must crash, every single run.
 */
const stubborn = [];
for (let i = 0; i < PROBE_RUNS; i += 1) {
  stubborn.push(simulate(777 + i * 104729, 'stubborn', i % 2 === 0 ? -1 : 1));
}
const straight = [];
for (let i = 0; i < PROBE_RUNS; i += 1) straight.push(simulate(4242 + i * 104729, 'straight'));

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const probes = [
  { label: 'holds left/right for ever', runs: stubborn },
  { label: 'never steers at all', runs: straight },
];
const probesPunished = probes.every((p) => p.runs.every((r) => !r.survived));

const survived = runs.filter((r) => r.survived);
const best = runs.reduce((a, b) => (b.distance > a.distance ? b : a));
const worst = runs.reduce((a, b) => (b.distance < a.distance ? b : a));

process.stdout.write(
  `HYPERDRIVE balance simulation — ${RUNS} runs, up to ${MAX_SECONDS}s each, ` +
    `${REACTION}s reaction delay\n\n`
);
process.stdout.write(
  `  runs survived to the time limit : ${survived.length}/${RUNS}\n` +
    `  median distance                 : ${runs.map((r) => r.distance).sort((a, b) => a - b)[Math.floor(RUNS / 2)]} m\n` +
    `  best run                        : ${best.distance} m in ${best.seconds.toFixed(1)}s ` +
    `(speed ${best.topSpeedKmh} km/h, difficulty ${best.difficulty})\n` +
    `  shortest run                    : ${worst.distance} m in ${worst.seconds.toFixed(1)}s\n`
);

if (worst.firstFailure) {
  const f = worst.firstFailure;
  process.stdout.write(
    `  first crash (worst run)         : ${f.t.toFixed(1)}s @ ${Math.round(f.distance)} m, ` +
      `difficulty ${f.difficulty.toFixed(2)}, blocked lanes ${f.laneStart}-${f.laneStart + f.laneSpan - 1}, ` +
      `warning ${f.warn.toFixed(2)}s + ${f.solid.toFixed(2)}s solid\n`
  );
}

const highDifficultyFailures = runs
  .filter((r) => r.firstFailure)
  .map((r) => r.firstFailure.difficulty);
process.stdout.write(
  `  crashes at difficulty           : ${
    highDifficultyFailures.length
      ? `${Math.min(...highDifficultyFailures).toFixed(2)} – ${Math.max(...highDifficultyFailures).toFixed(2)}`
      : 'none'
  }\n`
);

const margin = best.closestMargin;
process.stdout.write(`  tightest clearance in best run   : ${margin === null ? 'n/a' : `${margin} m`}\n`);

process.stdout.write('\n  perimeter probes (must all be punished):\n');
for (const probe of probes) {
  const died = probe.runs.filter((r) => !r.survived).length;
  const distances = probe.runs.map((r) => r.distance);
  const firstCrash = probe.runs.find((r) => r.firstFailure);
  process.stdout.write(
    `    pilot ${probe.label.padEnd(26)}: died in ${died}/${probe.runs.length} runs, ` +
      `median survival ${median(distances)} m` +
      (firstCrash && firstCrash.firstFailure
        ? ` (first crash t=${firstCrash.firstFailure.t.toFixed(1)}s, ship lane ` +
          `${firstCrash.firstFailure.shipLane}, gap ${firstCrash.firstFailure.gap.join(',')})\n`
        : '\n')
  );
}

const medianDistance = runs.map((r) => r.distance).sort((a, b) => a - b)[Math.floor(RUNS / 2)];
const medianDifficulty = medianDistance / 9000;
const ok = medianDistance >= MEDIAN_BAR && probesPunished;

process.stdout.write(
  `\n${ok ? 'PASS' : 'FAIL'} — a deliberately myopic pilot (greedy ${LOOKAHEAD}s lookahead, ` +
    `${REACTION}s reaction) reaches a median of ${medianDistance} m (difficulty ~${medianDifficulty.toFixed(2)}),\n` +
    `and neither perimeter probe survives: holding a direction is not a safe spot because every\n` +
    `barrier spans the play area around the ship.\n` +
    `Note: this is a playability lower bound, not a fairness bound — scripts/fairness.js proves with\n` +
    `the engine's own guard module that an exact dodge path exists for every generated sequence.\n`
);
process.exit(ok ? 0 : 1);
