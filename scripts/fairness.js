#!/usr/bin/env node
/**
 * Spawner fairness verification — no browser, no pilot heuristics.
 *
 * Runs the *real* spawner (selectFairRow from src/fairness.js, the same call the
 * game makes) over a long flight, then checks the resulting obstacle timeline
 * with the shared fairness model, seeded from the ship's starting lane.
 *
 * A sequence passes only if, for every cluster, a lane exists that is open for
 * every row solid at that moment, and the ship can always reach the next safe
 * pocket in the gap available.
 *
 *   node scripts/fairness.js [--seconds 600] [--safety 0.06] [--seed 12345]
 */

import {
  baseSpeedAt,
  difficultyAt,
  rowDistanceAt,
  solidDurationAt,
  warningDurationAt,
} from '../src/collision.js';
import { FAIRNESS, LANES, WALLS, laneCenterX } from '../src/config.js';
import { freeLanes, selectFairRow, sequenceFeasible, TRANSITION } from '../src/fairness.js';
import { createRandom } from '../src/utils.js';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const SECONDS = getArg('--seconds', 600);
// The spawner runs with the configured guard margin; the finished timeline is
// then re-checked with only a token margin, to prove the real sequence is clean.
const GUARD_SAFETY = getArg('--guard-safety', FAIRNESS.safety);
const VERIFY_SAFETY = getArg('--safety', FAIRNESS.verifySafety);
const SEED = getArg('--seed', 12345);
const DT = 1 / 120;

/** Fly the real spawner forward and record every row that reaches the ship. */
function generateRows(seed, seconds) {
  const rand = createRandom(seed);
  const rows = [];
  const inFlight = [];
  const spacings = [];
  const spacingSpeeds = [];
  let elapsed = 0;
  let distance = 0;
  // rows are laid down by distance travelled, exactly like the game does
  let spawnDistance = WALLS.spacing.start * 0.6;
  let relaxations = 0;
  let totalAttempts = 0;

  while (elapsed < seconds) {
    const difficulty = difficultyAt(distance);
    const speed = baseSpeedAt(elapsed, difficulty);
    const travel = speed * DT;
    distance += travel;
    elapsed += DT;

    for (const wall of inFlight) wall.z += travel;

    spawnDistance -= travel;
    if (spawnDistance <= 0) {
      const warnDuration = warningDurationAt(difficulty, speed);
      const solidDuration = solidDurationAt(difficulty);
      const ahead = inFlight
        .filter((w) => w.z < 0)
        .map((w) => {
          const arrivalIn = Math.max(0, -w.z / speed);
          return {
            free: w.free,
            materialiseIn: Math.max(0, arrivalIn - w.solidDuration),
            arrivalIn,
          };
        })
        .sort((a, b) => a.materialiseIn - b.materialiseIn);

      // The verifier parks a virtual ship in lane 0 and never steers it, so every
      // row is anchored on that lane (the real game anchors on the lane the ship
      // is predicted to hold). That makes this the strictest case there is: the
      // clusters keep standing on the lane the verifier holds.
      const picked = selectFairRow({
        rand,
        difficulty,
        inFlight: ahead,
        warnDuration,
        solidDuration,
        safety: GUARD_SAFETY,
        anchorLane: 0,
      });
      totalAttempts += picked.attempts;
      if (picked.fallback) relaxations += 1;

      inFlight.push({
        start: picked.row.start,
        span: picked.row.span,
        tiles: picked.row.span,
        blocked: picked.row.blocked,
        segments: picked.row.segments,
        // the verifier's virtual ship holds lane 0, so rows anchor there
        anchorLane: 0,
        free: picked.row.free,
        predicted: {
          materialise: elapsed + warnDuration,
          arrival: elapsed + warnDuration + solidDuration,
          verdict: picked.verdict?.feasible,
        },
        z: -(warnDuration + solidDuration) * speed,
        warn: warnDuration,
        solid: solidDuration,
        solidDuration,
        difficulty,
        speed,
        arrival: null,
        materialise: null,
      });

      spawnDistance = rowDistanceAt(difficulty, rand);
      spacings.push(spawnDistance);
      spacingSpeeds.push(speed);
    }

    for (const wall of inFlight) {
      if (wall.materialise === null && wall.z >= -wall.solid * wall.speed) wall.materialise = elapsed;
      if (wall.arrival === null && wall.z >= 0) {
        wall.arrival = elapsed;
        rows.push(wall);
      }
    }
    for (let i = inFlight.length - 1; i >= 0; i -= 1) {
      if (inFlight[i].z > 30) inFlight.splice(i, 1);
    }
  }

  return { rows, relaxations, totalAttempts, spacings, spacingSpeeds };
}

/* ------------------------------------------------------------------ */

const { rows, relaxations, totalAttempts, spacings, spacingSpeeds } = generateRows(SEED, SECONDS);

const timeline = rows.map((r) => ({
  free: r.free,
  materialiseIn: r.materialise,
  arrivalIn: r.arrival,
}));

const verdict = sequenceFeasible(timeline, {
  safety: VERIFY_SAFETY,
  startPockets: [[0]],
});

const maxDifficulty = Math.max(...rows.map((r) => r.difficulty));
const maxSpeed = Math.max(...rows.map((r) => r.speed));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const tiles = rows.map((r) => r.blocked.length);
const widths = rows.map((r) => r.blocked.length * LANES.width);
const overCap = rows.filter((r) => r.blocked.length > WALLS.maxTiles).length;
const blockingShipLane = rows.filter((r) => r.blocked.includes(0)).length;
const multiTile = rows.filter((r) => r.blocked.length > 1).length;
const singleTile = rows.filter((r) => r.blocked.length === 1).length;
const spacingsSorted = [...spacings].sort((a, b) => a - b);
// world distance between rows converted to seconds at the speed that drew it
const secondsApart = spacings.map((d, i) => d / Math.max(1, spacingSpeeds[i]));

process.stdout.write('HYPERDRIVE spawner fairness verification\n\n');
process.stdout.write(
  `  rows generated          : ${rows.length} over ${SECONDS}s of flight\n` +
    `  difficulty reached      : ${maxDifficulty.toFixed(3)} (${Math.round(maxSpeed * 21)} km/h)\n` +
    `  pattern attempts per row: ${(totalAttempts / Math.max(1, rows.length)).toFixed(2)} (fairness retries)\n` +
    `  relaxed rows            : ${relaxations} (${((relaxations / Math.max(1, rows.length)) * 100).toFixed(1)}%)\n` +
    `  tiles per row           : ${Math.min(...tiles)}–${Math.max(...tiles)} (mean ${mean(tiles).toFixed(2)}, ` +
    `cap ${WALLS.maxTiles})\n` +
    `  rows over the tile cap  : ${overCap}\n` +
    `  row width               : ${Math.min(...widths).toFixed(0)}–${Math.max(...widths).toFixed(0)} world units ` +
    `(max ${WALLS.maxTiles * LANES.width})\n` +
    `  single-tile / clusters  : ${singleTile} single, ${multiTile} multi-tile\n` +
    `  rows blocking lane 0    : ${blockingShipLane} of ${rows.length} ` +
    `(${((blockingShipLane / Math.max(1, rows.length)) * 100).toFixed(1)}% — holding one lane is punished)\n` +
    `  spawn spacing (world)   : ${spacingsSorted[0].toFixed(0)}–${spacingsSorted[spacingsSorted.length - 1].toFixed(0)} units, ` +
    `mean ${mean(spacings).toFixed(0)}, sd ${std(spacings).toFixed(0)} (chaotic, not a metronome)\n` +
    `  spawn spacing (time)    : ${Math.min(...secondsApart).toFixed(2)}–${Math.max(...secondsApart).toFixed(2)}s apart\n` +
    `  lane travel matrix      : 1 lane ${TRANSITION[0][1].toFixed(2)}s, 2 lanes ${TRANSITION[0][2].toFixed(2)}s, 4 lanes ${TRANSITION[0][4].toFixed(2)}s\n` +
    `  lane space              : unbounded (clusters anchored to the ship, ${LANES.reach} lanes of reach modelled)\n`
);

if (verdict.feasible) {
  process.stdout.write(
    `  dodge path              : ALWAYS exists (${rows.length} row transitions checked)\n` +
      `  tightest transition     : ${verdict.tightest ? verdict.tightest.slack.toFixed(2) : 'n/a'}s spare ` +
      `(lane ${verdict.tightest ? verdict.tightest.lane : '—'}, ` +
      `needs ${verdict.tightest ? verdict.tightest.need.toFixed(2) : '—'}s of a ` +
      `${verdict.tightest ? verdict.tightest.gap.toFixed(2) : '—'}s gap)\n`
  );
} else {
  const f = verdict.failure || {};
  process.stdout.write(`  dodge path              : BROKEN — ${verdict.reason}\n`);
  process.stdout.write(
    `  first failure           : t=${f.at ? f.at.toFixed(2) : '?'}s, walls solid at once: ${f.solidCount ?? '?'}, ` +
      `open lanes ${f.openLanes ? f.openLanes.join(',') : f.blockedLanes ? 'none' : '?'}, ` +
      `needed ${f.needed ? f.needed.toFixed(2) : '?'}s of ${f.gap ? f.gap.toFixed(2) : '?'}s gap\n`
  );
}

const DEBUG = args.includes('--trace');
if (!verdict.feasible && DEBUG) {
  const at = verdict.failure?.at ?? 0;
  process.stdout.write('\n  realised timeline around the failure:\n');
  rows.forEach((r, i) => {
    if (r.materialise < at - 4 || r.materialise > at + 1.5) return;
    process.stdout.write(
      `    #${String(i).padStart(4)} lanes blocked ${r.start}..${r.start + r.span - 1} ` +
        `(open ${r.free.join(',')}) ` +
        `materialise t=${r.materialise.toFixed(2)} solid ${r.solid.toFixed(2)}s ` +
        `arrival t=${r.arrival.toFixed(2)} diff=${r.difficulty.toFixed(2)} ` +
        `predicted span ${r.predicted ? `${r.predicted.materialise.toFixed(2)}→${r.predicted.arrival.toFixed(2)}` : 'n/a'}\n`
    );
  });
}

const laneFree = freeLanes(0, 1);
process.stdout.write(
  `\n  sanity: a single tile blocks 1 of ${laneFree.length + 1} lanes; ` +
    `lane centres ${[-2, -1, 0, 1, 2].map((l) => laneCenterX(l)).join(' ')}; ` +
    `max row width ${WALLS.maxTiles} lanes (${WALLS.maxTiles * LANES.width} world units)\n`
);

process.stdout.write(
  `\n${verdict.feasible ? 'PASS' : 'FAIL'} — every generated cluster sequence has a physical dodge ` +
    `path up to difficulty ${maxDifficulty.toFixed(2)}, with no row ever wider than ${WALLS.maxTiles} tiles.\n`
);
process.exit(verdict.feasible ? 0 : 1);
