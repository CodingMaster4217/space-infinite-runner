#!/usr/bin/env node
/**
 * Pure-logic test suite (no browser, no Three.js):
 *   npm test
 *
 * Covers the difficulty curve, obstacle pattern generation, collision math and
 * speed conversion — the parts of the game that must be correct regardless of
 * what the renderer is doing.
 */

import {
  baseSpeedAt,
  boxesOverlap,
  difficultyAt,
  fullWidthRow,
  gapLanesAt,
  laneIsFlyableByShip,
  laneWindowFor,
  makeBox,
  pickWallRow,
  playerBox,
  powerupIntervalAt,
  rowBreathingAt,
  rowIntervalAt,
  solidDurationAt,
  sphereOverlap,
  toDisplaySpeed,
  wallBox,
  wallHalfLanes,
  warningColorAt,
  warningCssAt,
  warningDistanceAt,
  warningDurationAt,
  warningStripLengthAt,
} from '../src/collision.js';
import {
  DIFFICULTY,
  FAIRNESS,
  LANES,
  POWERUPS,
  SHIP,
  SPEED,
  WALLS,
  laneCenterX,
  laneIndexAt,
} from '../src/config.js';
import {
  candidatesKeepingPocket,
  freeLanes,
  freeWithin,
  gapRow,
  liftRow,
  pocketsOf,
  pocketGapRows,
  selectFairRow,
  sequenceFeasible,
  singleLaneRow,
  transit,
  TRANSITION,
} from '../src/fairness.js';
import { clamp, createRandom, damp } from '../src/utils.js';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ok   ${name}${detail ? ` — ${detail}` : ''}\n`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    process.stdout.write(` FAIL  ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

const nearly = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ------------------------------------------------------------------ */
/* difficulty curve                                                    */
/* ------------------------------------------------------------------ */
const diffs = [0, 500, 2500, 4500, 9000, 20000].map(difficultyAt);
check('difficulty starts at 0', nearly(diffs[0], 0));
check('difficulty saturates at 1', nearly(diffs[4], 1) && nearly(diffs[5], 1));
check('difficulty is monotonic', diffs.every((d, i) => i === 0 || d >= diffs[i - 1]), diffs.join(', '));

const warns = [0, 0.25, 0.5, 0.75, 1].map(warningDurationAt);
check('warning window shrinks as difficulty rises',
  warns.every((w, i) => i === 0 || w < warns[i - 1]), warns.map((w) => w.toFixed(2)).join(' → '));
check('warning window stays inside designed bounds',
  warns[0] <= DIFFICULTY.warning.start + 1e-9 && warns[warns.length - 1] >= DIFFICULTY.warning.end - 1e-9,
  `${warns[0].toFixed(2)}s → ${warns[warns.length - 1].toFixed(2)}s`);
check('warning window always leaves reaction time',
  warns[warns.length - 1] >= 0.5, `worst case ${warns[warns.length - 1].toFixed(2)}s`);

const rng = createRandom(1234);
/** Window sizes the spawner uses across the speed range, in lanes. */
const LANE_COUNTS = [5, 9, 13, 17, 21, 25, 29];

/* ------------------------------------------------------------------ */
/* row cadence + the lane-change window                                */
/* ------------------------------------------------------------------ */
const breathEarly = rowBreathingAt(0);
const breathLate = rowBreathingAt(1);
check('the lane-change window shrinks as difficulty climbs',
  breathLate < breathEarly, `${breathEarly.toFixed(2)}s → ${breathLate.toFixed(2)}s`);
check('there is always room for a lane change between barriers',
  transit(0, 1) <= breathLate - FAIRNESS.verifySafety,
  `1 lane needs ${transit(0, 1).toFixed(2)}s of a ${breathLate.toFixed(2)}s window`);
check('early barriers leave room for a two-lane change',
  transit(0, 2) <= breathEarly - FAIRNESS.verifySafety,
  `2 lanes need ${transit(0, 2).toFixed(2)}s of a ${breathEarly.toFixed(2)}s window`);

const avgOf = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const intervalEarly = [0, 0.1, 0.2].map((d) => rowIntervalAt(d, rng));
const intervalLate = [0.9, 0.95, 1].map((d) => rowIntervalAt(d, rng));
check('row cadence tightens with difficulty',
  avgOf(intervalLate) < avgOf(intervalEarly),
  `${avgOf(intervalEarly).toFixed(2)}s → ${avgOf(intervalLate).toFixed(2)}s apart`);
check('consecutive barriers never overlap solidly',
  [0, 0.5, 1].every((d) => rowIntervalAt(d, rng) >= 2 * solidDurationAt(d)),
  [0, 0.5, 1].map((d) => `${rowIntervalAt(d, rng).toFixed(2)}s vs ${(2 * solidDurationAt(d)).toFixed(2)}s solid`).join(', '));
check('the interval always carries the whole breathing window',
  [0, 0.5, 1].every(
    (d) => rowIntervalAt(d, rng) >= 2 * solidDurationAt(d) + rowBreathingAt(d) - 1e-9
  ),
  [0, 0.5, 1]
    .map(
      (d) =>
        `${rowIntervalAt(d, rng).toFixed(2)}s ≥ ${(2 * solidDurationAt(d) + rowBreathingAt(d)).toFixed(2)}s at difficulty ${d}`
    )
    .join(', '));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

const pu = [0, 0.5, 1].map((d) => powerupIntervalAt(d, rng));
check('power-ups arrive inside the designed window',
  pu.every((p) => p > 3 && p < 12), pu.map((p) => p.toFixed(1)).join(', ') + 's');
check('power-up orbs keep spawning under power-up time',
  POWERUPS.spawnInterval.end >= 4.5, `${POWERUPS.spawnInterval.end}s`);

const baseEarly = baseSpeedAt(0, 0);
const baseMid = baseSpeedAt(60, 0.5);
const baseLate = baseSpeedAt(600, 1);
check('base speed ramps over time', baseEarly < baseMid && baseMid < baseLate,
  `${baseEarly.toFixed(0)} → ${baseMid.toFixed(0)} → ${baseLate.toFixed(0)} u/s`);
check('base speed respects the ceiling', baseSpeedAt(10000, 1) <= SPEED.max + 1e-9, `cap ${SPEED.max}`);

/* ------------------------------------------------------------------ */
/* obstacle patterns                                                   */
/* ------------------------------------------------------------------ */
let allFree = true;
let coversWindow = true;
let gapContiguous = true;
let slabsContiguous = true;
let reachOk = true;
let sawWide = false;
let previousFree = null;
const patternRng = createRandom(99);

for (let difficulty = 0; difficulty <= 1.0001; difficulty += 0.05) {
  for (let i = 0; i < 60; i += 1) {
    const tight = difficulty > 0.35;
    const laneCount = LANE_COUNTS[(i + Math.floor(difficulty * 10)) % LANE_COUNTS.length];
    const row = pickWallRow(patternRng, difficulty, previousFree, tight, laneCount);
    const gap = row.gap;
    if (gap.length === 0 || row.free.length === 0) allFree = false;
    // every window lane is either blocked or part of the gap
    if (row.blocked.length + gap.length !== laneCount) coversWindow = false;
    for (let k = 1; k < gap.length; k += 1) if (gap[k] !== gap[k - 1] + 1) gapContiguous = false;
    if (gap[0] < 0 || gap[gap.length - 1] > laneCount - 1) gapContiguous = false;
    // each slab is a contiguous run, and there are never more than two of them
    if (row.segments.length > 2) slabsContiguous = false;
    for (const seg of row.segments) {
      for (let k = 1; k < seg.span; k += 1) {
        if (!row.blocked.includes(seg.start + k)) slabsContiguous = false;
      }
      if (seg.span < 1) slabsContiguous = false;
    }
    if (row.blocked.length >= 8) sawWide = true;
    previousFree = gap;
  }
}

// The "stay tight" rule is a heuristic on a fixed-size window (the window itself
// only changes when the run speeds up), so it is checked on a constant window.
let tightPrevious = null;
const tightRng = createRandom(5150);
for (let difficulty = 0.4; difficulty <= 1.0001; difficulty += 0.1) {
  for (let i = 0; i < 40; i += 1) {
    const row = pickWallRow(tightRng, difficulty, tightPrevious, true, LANES.count);
    if (tightPrevious && !tightPrevious.some((a) => row.gap.some((b) => Math.abs(a - b) <= 1))) {
      reachOk = false;
    }
    tightPrevious = row.gap;
  }
}

check('every wall row leaves at least one open lane (the gap)', allFree);
check('the barrier covers the whole lane window apart from its gap', coversWindow,
  `gap ${gapLanesAt(0)} → ${gapLanesAt(1)} lanes`);
check('the gap is a single contiguous run inside the window', gapContiguous);
check('barriers are at most two contiguous slabs', slabsContiguous);
check('wide barriers really do span the play area', sawWide);
check('tight gaps are always reachable from the previous gap', reachOk);
check('a single lane is wide enough for the ship', laneIsFlyableByShip(),
  `lane ${LANES.width} vs ship ${(SHIP.halfExtents.x * 2).toFixed(2)}`);

/* barrier width + warning scaling are driven by speed ----------------- */
const cruiseFlight = { warnDuration: warningDurationAt(0.5, SPEED.base), solidDuration: solidDurationAt(0.5) };
const halfAtCruise = wallHalfLanes({ speed: SPEED.base, ...cruiseFlight });
const halfAtMax = wallHalfLanes({ speed: SPEED.max, ...cruiseFlight });
check('the barrier widens as the run speeds up', halfAtMax > halfAtCruise,
  `${halfAtCruise} → ${halfAtMax} lanes each side`);
check('the barrier always covers at least the reachable band',
  halfAtCruise >= WALLS.minHalfLanes && halfAtMax <= WALLS.maxHalfLanes,
  `bounded by ${WALLS.minHalfLanes}..${WALLS.maxHalfLanes} lanes`);
check('a narrow viewport gets a narrower (cheaper) barrier than a wide one',
  wallHalfLanes({ speed: SPEED.base, ...cruiseFlight, aspect: 0.5 }) <=
    wallHalfLanes({ speed: SPEED.base, ...cruiseFlight, aspect: 2.2 }));

check('warning time is unchanged at cruise speed (difficulty still bites)',
  nearly(warningDurationAt(0.37, SPEED.base), warningDurationAt(0.37)),
  `${warningDurationAt(0.37).toFixed(3)}s at ${SPEED.base} u/s`);
const fastWarn = warningDurationAt(0.5, SPEED.max);
const slowWarn = warningDurationAt(0.5, SPEED.base);
check('the warning window stretches back out at speed', fastWarn > slowWarn,
  `${slowWarn.toFixed(2)}s @${SPEED.base} → ${fastWarn.toFixed(2)}s @${SPEED.max}`);
check('the warning *distance* grows with speed',
  warningDistanceAt(0.5, 300) > warningDistanceAt(0.5, SPEED.max) &&
    warningDistanceAt(0.5, SPEED.max) > warningDistanceAt(0.5, SPEED.base),
  `${warningDistanceAt(0.5, SPEED.base).toFixed(0)} → ${warningDistanceAt(0.5, SPEED.max).toFixed(0)} → ` +
    `${warningDistanceAt(0.5, 300).toFixed(0)} world units`);
check('the floor warning strip lengthens with speed',
  warningStripLengthAt(SPEED.max) > warningStripLengthAt(SPEED.base),
  `${warningStripLengthAt(SPEED.base)} → ${warningStripLengthAt(SPEED.max)} u`);
check('the solid sweep shortens with difficulty',
  solidDurationAt(1) < solidDurationAt(0), `${solidDurationAt(0).toFixed(2)}s → ${solidDurationAt(1).toFixed(2)}s`);

/* warning colour ramp: light red → dark red → deepest red -------------- */
const ramp = [0, 0.35, 0.7, 0.85, 1].map(warningColorAt);
const luminance = ({ r, g, b }) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
check('warning starts light red (#ff8888)',
  warningCssAt(0) === '#ff8888', warningCssAt(0));
check('warning turns dark red at 70% (#880000)',
  warningCssAt(0.7) === '#880000', warningCssAt(0.7));
check('warning ends deepest red (#440000)',
  warningCssAt(1) === '#440000', warningCssAt(1));
check('the warning only ever darkens',
  ramp.every((c, i) => i === 0 || luminance(c) < luminance(ramp[i - 1])),
  ramp.map((c) => luminance(c).toFixed(3)).join(' → '));
check('red is the dominant channel throughout', ramp.every((c) => c.r > c.g && c.r > c.b));
check('the ramp is clamped outside 0..1',
  warningCssAt(-3) === '#ff8888' && warningCssAt(9) === '#440000');

/* ------------------------------------------------------------------ */
/* collision math                                                      */
/* ------------------------------------------------------------------ */
const a = makeBox(0, 0, 0, 1, 1, 1);
check('overlapping boxes collide', boxesOverlap(a, makeBox(1.5, 0, 0, 1, 1, 1)));
check('separated boxes do not collide', !boxesOverlap(a, makeBox(2.5, 0, 0, 1, 1, 1)));
check('touching boxes register a hit (<=, inclusive)', boxesOverlap(a, makeBox(2, 0, 0, 1, 1, 1)));
check('vertical separation is respected', !boxesOverlap(a, makeBox(0, 3.5, 0, 1, 1, 1)));

const ship = playerBox(0, 0.75, 0);
const centreWall = wallBox(0, 1, 0);
check('ship collides with a wall dropped in its lane', boxesOverlap(ship, centreWall));
check('ship dodges a wall two lanes away', !boxesOverlap(ship, wallBox(2, 1, 0)));

/* lanes are unbounded: the geometry has to keep working far off the axis */
check('lane space extends past the old corridor edges',
  laneIndexAt(-38.4) === -8 && laneIndexAt(52.8) === 11,
  `lane -8 at x=${laneCenterX(-8)}, lane 11 at x=${laneCenterX(11)}`);
check('walls can be placed anywhere on the plane',
  wallBox(-8, 2, 0).cx === (laneCenterX(-8) + laneCenterX(-7)) / 2 &&
    boxesOverlap(playerBox(laneCenterX(-8), 0.75, 0), wallBox(-8, 2, 0)),
  `far-left wall x=${wallBox(-8, 2, 0).cx}`);
check('ship clears a far-left wall by steering right',
  !boxesOverlap(playerBox(laneCenterX(-6), 0.75, 0), wallBox(-8, 2, 0)));

const lane2Centre = laneCenterX(2);
check('wall box is centred on its lanes', nearly(wallBox(2, 1, 0).cx, lane2Centre, 1e-9),
  `x=${lane2Centre}`);
const span3 = wallBox(1, 3, 0);
check('multi-lane wall spans three lanes',
  nearly(span3.hx, (LANES.width * 3) / 2, 1e-9) &&
    nearly(span3.cx, laneCenterX(2), 1e-9),
  `halfWidth=${span3.hx}`);

check('ship at centre dodges a 3-lane wall offset from it',
  !boxesOverlap(playerBox(laneCenterX(0), 0.75, 0), wallBox(2, 3, 0)));
check('ship flying the open lane clears a 3-lane wall',
  !boxesOverlap(playerBox(laneCenterX(1), 0.75, 0), wallBox(2, 3, 0)));
check('ship drifting into a blocked lane hits the wall',
  boxesOverlap(playerBox(laneCenterX(2), 0.75, 0), wallBox(2, 3, 0)));

check('sphere overlap detects pickups', sphereOverlap(0, 0, 0, 1, 1.5, 0, 0, 1));
check('sphere overlap ignores distant pickups', !sphereOverlap(0, 0, 0, 1, 2.5, 0, 0, 1));

/* ------------------------------------------------------------------ */
/* fairness model                                                      */
/* ------------------------------------------------------------------ */
check('lane travel times grow with distance',
  TRANSITION[0][1] < TRANSITION[0][2] && TRANSITION[0][2] < TRANSITION[0][4],
  `1 lane ${TRANSITION[0][1].toFixed(2)}s, 2 lanes ${TRANSITION[0][2].toFixed(2)}s, 4 lanes ${TRANSITION[0][4].toFixed(2)}s`);
check('the ship cannot cross four lanes inside one warning window',
  TRANSITION[0][4] > DIFFICULTY.warning.end,
  `${TRANSITION[0][4].toFixed(2)}s needed vs ${DIFFICULTY.warning.end}s warning`);
check('lane travel time is defined for any lane separation',
  transit(0, 1) === TRANSITION[0][1] && transit(-9, -7) === TRANSITION[0][2] && transit(40, 40) === 0,
  `−9→−7 ${transit(-9, -7).toFixed(2)}s, 40→40 ${transit(40, 40)}s`);
check('free space is modelled around the ship, not a corridor',
  freeWithin([5], 0).length === LANES.reach * 2 + 1 - 1 &&
    !freeWithin([5], 0).includes(5) &&
    freeWithin([5], 0).includes(-LANES.reach) &&
    freeWithin([5], 0).includes(LANES.reach), `${freeWithin([5], 0).length} open lanes modelled`);
check('free lanes exclude the blocked block',
  freeLanes(1, 2).join(',') === '0,3,4', freeLanes(1, 2).join(','));
check('pockets split at blocked lanes',
  JSON.stringify(pocketsOf([0, 1, 3, 4])) === JSON.stringify([[0, 1], [3, 4]]),
  JSON.stringify(pocketsOf([0, 1, 3, 4])));
check('a single empty lane is still a pocket',
  JSON.stringify(pocketsOf([2])) === JSON.stringify([[2]]));

// two consecutive rows that require a lane change, with just enough gap for it
const tightPair = [
  { free: [0, 1, 2], materialiseIn: 0.0, arrivalIn: 0.9 },
  { free: [3, 4], materialiseIn: 1.5, arrivalIn: 2.4 },
];
const tightVerdict = sequenceFeasible(tightPair, { requireAllStartPockets: true, safety: 0.05 });
check('a tight but reachable lane change is accepted', tightVerdict.feasible,
  tightVerdict.feasible ? `spare ${tightVerdict.tightest.slack.toFixed(2)}s` : tightVerdict.reason);

// same rows with no gap at all: the ship is walled before it can move
const noGap = [
  { free: [0, 1, 2], materialiseIn: 0.0, arrivalIn: 0.9 },
  { free: [3, 4], materialiseIn: 0.9, arrivalIn: 1.8 },
];
check('a lane change with no gap is rejected',
  !sequenceFeasible(noGap, { requireAllStartPockets: true, safety: 0.05 }).feasible);

const impossible = [
  { free: [0], materialiseIn: 0.0, arrivalIn: 1.0 },
  { free: [1, 2, 3, 4], materialiseIn: 0.98, arrivalIn: 1.9 },
];
const impossibleVerdict = sequenceFeasible(impossible, { requireAllStartPockets: true, safety: 0.05 });
check('a forced pocket swap with no gap is rejected', !impossibleVerdict.feasible,
  impossibleVerdict.reason);

const wide = [
  { free: [0, 1, 2, 3, 4], materialiseIn: 0.5, arrivalIn: 1.5 },
  { free: [0, 1, 2, 3, 4], materialiseIn: 2.5, arrivalIn: 3.5 },
];
check('open rows are always feasible', sequenceFeasible(wide, { requireAllStartPockets: true }).feasible);
check('every start pocket is evaluated (no lucky-pocket bias)',
  (() => {
    // row 1 leaves lanes 1-2 and 5 open; row 2 keeps only lanes 1-2 and arrives
    // with a gap too short to travel from lane 5. A ship sitting in lane 5 dies,
    // so the strict check must reject it even though lane 1-2 has a path.
    const rows = [
      { free: [0, 1, 4], materialiseIn: 0.0, arrivalIn: 0.8 },
      { free: [0, 1], materialiseIn: 1.0, arrivalIn: 1.8 },
    ];
    const strict = sequenceFeasible(rows, { requireAllStartPockets: true, safety: 0.05 });
    const lenient = sequenceFeasible(rows, { safety: 0.05 });
    return !strict.feasible && lenient.feasible;
  })());

check('the spawner never returns a row that blocks every lane',
  (() => {
    const rand = createRandom(4242);
    for (let i = 0; i < 400; i += 1) {
      const picked = selectFairRow({
        rand,
        difficulty: (i % 100) / 100,
        inFlight: [],
        previousFree: null,
        warnDuration: 1.2,
        solidDuration: 0.9,
      });
      if (picked.row.free.length === 0) return false;
    }
    return true;
  })());

check('the spawner always produces a feasible first row',
  (() => {
    const rand = createRandom(777);
    const picked = selectFairRow({
      rand,
      difficulty: 1,
      inFlight: [],
      previousFree: null,
      warnDuration: 0.55,
      solidDuration: 0.7,
    });
    return picked.verdict.feasible;
  })());

check('single-lane fallbacks keep every pocket lane open',
  (() => {
    const options = candidatesKeepingPocket([4], 0);
    return options.length > 0 && options.every((row) => row.free.includes(4));
  })());

/* full-width row geometry --------------------------------------------- */
const wideRow = fullWidthRow(3, 2, 9);
check('a full-width row blocks both sides of its gap',
  wideRow.gap.join(',') === '3,4' &&
    wideRow.segments.length === 2 &&
    wideRow.segments[0].start === 0 &&
    wideRow.segments[1].start + wideRow.segments[1].span === 9,
  `slabs ${wideRow.segments.map((s) => `${s.start}+${s.span}`).join(' / ')}`);
check('the gap is open in the actual collision geometry',
  !boxesOverlap(playerBox(laneCenterX(3), 0.75, 0), wallBox(0, 3, 0)) &&
    !boxesOverlap(playerBox(laneCenterX(4), 0.75, 0), wallBox(5, 4, 0)) &&
    boxesOverlap(playerBox(laneCenterX(2), 0.75, 0), wallBox(0, 3, 0)) &&
    boxesOverlap(playerBox(laneCenterX(5), 0.75, 0), wallBox(5, 4, 0)),
  'slab boxes leave lanes 3-4 flyable');

/* fallbacks ------------------------------------------------------------ */
const heldRow = gapRow({ gapStart: -1, gapWidth: 2, windowBase: -6, laneCount: 13, anchorLane: 0 });
check('the extreme fallback keeps the lane the ship is holding open',
  heldRow.gap.includes(0) && heldRow.blocked.length === 11,
  `gap ${heldRow.gap.join(',')} of ${heldRow.gap.length + heldRow.blocked.length} lanes`);
check('pocket fallbacks can keep the whole pocket open',
  pocketGapRows([2, 3], 2, { windowBase: -4, laneCount: 13, gapWidth: 1 }).some(
    (row) => row.gap.includes(2) && row.gap.includes(3)
  ));
check('the spawner never leaves the ship with nowhere to go',
  (() => {
    const rand = createRandom(31337);
    // a deliberately impossible in-flight picture: every lane the retries would
    // try is already solid when the candidate lands
    const inFlight = [
      { free: [0], materialiseIn: 0, arrivalIn: 0.4 },
      { free: [0], materialiseIn: 0, arrivalIn: 0.8 },
    ];
    for (let i = 0; i < 60; i += 1) {
      const picked = selectFairRow({
        rand,
        difficulty: 1,
        inFlight,
        warnDuration: 0.6,
        solidDuration: 0.7,
        anchorLane: 0,
        laneCount: 13,
      });
      if (picked.row.free.length === 0 || !picked.row.gap.length) return false;
    }
    return true;
  })());

check('single-lane rows leave the rest of the plane open',
  (() => {
    const row = singleLaneRow(2);
    return (
      !row.free.includes(2) &&
      row.free.includes(3) &&
      row.free.includes(-1) &&
      row.free.length === LANES.reach * 2
    );
  })(), `${singleLaneRow(2).free.length} open lanes`);

check('the fairness guard margin leaves room for speed drift',
  FAIRNESS.safety >= TRANSITION[0][1] * 0.25, `${FAIRNESS.safety}s guard`);

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
check('clamp works', clamp(-5, 0, 10) === 0 && clamp(15, 0, 10) === 10 && clamp(5, 0, 10) === 5);
check('damp approaches the target without overshooting',
  damp(0, 10, 8, 1 / 60) > 0 && damp(0, 10, 8, 1 / 60) < 10);
check('display speed conversion', toDisplaySpeed(SPEED.base) === SPEED.base * 21,
  `${toDisplaySpeed(SPEED.base)} km/h at cruise`);

process.stdout.write(`\n${passed}/${passed + failures.length} logic checks passed.\n`);
if (failures.length) {
  process.stdout.write('FAILURES:\n');
  failures.forEach((f) => process.stdout.write(` - ${f}\n`));
  process.exit(1);
}
