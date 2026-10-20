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
  chooseTileStart,
  difficultyAt,
  laneIsFlyableByShip,
  makeBox,
  pickTileRow,
  playerBox,
  powerupIntervalAt,
  rowDistanceAt,
  solidDurationAt,
  sphereOverlap,
  tileCountAt,
  tileRow,
  toDisplaySpeed,
  wallBox,
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
  pocketsOf,
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

/* ------------------------------------------------------------------ */
/* row width: never more than five tiles side by side                  */
/* ------------------------------------------------------------------ */
const tileSweep = [];
for (let difficulty = 0; difficulty <= 1.0001; difficulty += 0.05) {
  for (let i = 0; i < 80; i += 1) tileSweep.push({ difficulty, tiles: tileCountAt(difficulty, rng) });
}
const maxTilesSeen = Math.max(...tileSweep.map((t) => t.tiles));
const minTilesSeen = Math.min(...tileSweep.map((t) => t.tiles));
check('a row never stands more than five tiles side by side',
  tileSweep.every((t) => t.tiles >= 1 && t.tiles <= 5) && maxTilesSeen === 5,
  `${minTilesSeen}–${maxTilesSeen} tiles (cap ${WALLS.maxTiles})`);
check('rows are at most as wide as the cap says',
  WALLS.maxTiles === 5 && WALLS.maxTiles * LANES.width <= 26,
  `${WALLS.maxTiles} × ${LANES.width} = ${WALLS.maxTiles * LANES.width} world units`);
const earlyTiles = tileSweep.filter((t) => t.difficulty <= 0.1).map((t) => t.tiles);
const lateTiles = tileSweep.filter((t) => t.difficulty >= 0.9).map((t) => t.tiles);
const meanTiles = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
check('rows get wider as the run gets harder (up to the cap)',
  meanTiles(lateTiles) > meanTiles(earlyTiles) + 0.8,
  `${meanTiles(earlyTiles).toFixed(2)} → ${meanTiles(lateTiles).toFixed(2)} tiles`);
check('the early game never throws a five-tile row at the player',
  Math.max(...earlyTiles) <= 2, `widest early row ${Math.max(...earlyTiles)} tiles`);
check('the spawner asks for a lane change without ever walling the plane',
  tileSweep.every((t) => t.tiles < LANES.reach * 2 + 1),
  `${maxTilesSeen} of ${LANES.reach * 2 + 1} modelled lanes`);

/* ------------------------------------------------------------------ */
/* spacing: distance-driven and chaotic                                */
/* ------------------------------------------------------------------ */
const spacingEarly = [];
const spacingLate = [];
for (let i = 0; i < 600; i += 1) {
  spacingEarly.push(rowDistanceAt(0, rng));
  spacingLate.push(rowDistanceAt(1, rng));
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const spreadOf = (xs) => Math.max(...xs) / Math.min(...xs);
const meanEarlySeconds = mean(spacingEarly) / SPEED.base;
const meanLateSeconds = mean(spacingLate) / SPEED.max;
check('rows arrive more often as the run goes on',
  meanLateSeconds < meanEarlySeconds * 0.6 && meanEarlySeconds < 4.5,
  `${meanEarlySeconds.toFixed(2)}s apart at the start → ${meanLateSeconds.toFixed(2)}s at full speed`);
check('spawn spacing is chaotic, not a fixed interval',
  spreadOf(spacingEarly) > 2.5 && spreadOf(spacingLate) > 2.5 &&
    new Set(spacingLate.map((d) => Math.round(d))).size > 100,
  `spread ${spreadOf(spacingEarly).toFixed(1)}× early, ${spreadOf(spacingLate).toFixed(1)}× late, ` +
    `${new Set(spacingLate.map((d) => Math.round(d))).size} distinct values`);
check('the spacing draws mix bursts, ordinary gaps and breathers',
  (() => {
    const base = (WALLS.spacing.start + WALLS.spacing.end) / 2;
    const bursts = spacingLate.filter((d) => d < base * 0.8).length;
    const breathers = spacingLate.filter((d) => d > base * 1.5).length;
    return bursts > 60 && breathers > 60;
  })(),
  `${spacingLate.filter((d) => d < 130).length} bursts, ${spacingLate.filter((d) => d > 240).length} breathers of ${spacingLate.length}`);
check('every drawn gap clears the burst floor',
  spacingEarly.every((d) => d >= WALLS.spacing.start * WALLS.spacing.burst * 0.84 - 1e-9),
  `shortest ${Math.min(...spacingEarly).toFixed(0)} units`);
check('the row distance is a distance, not a duration',
  // the same difficulty draws the same *magnitude* regardless of the clock, so
  // callers convert it with their own speed rather than reading a timer
  rowDistanceAt(0.5, () => 0.5) === rowDistanceAt(0.5, () => 0.5),
  `${rowDistanceAt(0.5, () => 0.5).toFixed(1)} world units per ordinary gap`);

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
const geometryRow = tileRow(-3, 4);
check('a row is one contiguous run of tiles',
  geometryRow.span === 4 &&
    geometryRow.segments.length === 1 &&
    geometryRow.segments[0].start === -3 &&
    geometryRow.segments[0].span === 4 &&
    geometryRow.blocked.join(',') === '-3,-2,-1,0',
  `lanes ${geometryRow.blocked.join(',')}`);
check('a row refuses to grow past five tiles',
  tileRow(0, 9).span === WALLS.maxTiles && tileRow(0, 9).blocked.length === WALLS.maxTiles,
  `asked for 9, built ${tileRow(0, 9).span}`);
check('a row is never empty', tileRow(2, 0).span === 1, `${tileRow(2, 0).span} tile`);

const patternRng = createRandom(99);
let blockedAnchor = 0;
let nearMiss = 0;
let maxSpan = 0;
let farAnchor = 0;
for (let i = 0; i < 800; i += 1) {
  const difficulty = (i % 100) / 100;
  const anchor = i < 400 ? 4 : -9;
  const row = pickTileRow(patternRng, difficulty, { anchorLane: anchor });
  maxSpan = Math.max(maxSpan, row.span);
  if (row.span > WALLS.maxTiles) farAnchor += 1;
  if (row.blocked.includes(anchor)) blockedAnchor += 1;
  else if (row.start === anchor + 1 || row.start + row.span - 1 === anchor - 1) nearMiss += 1;
}
check('most rows stand on the lane the ship is heading for',
  blockedAnchor / 800 > 0.6,
  `${blockedAnchor}/800 rows block the anchor lane`);
check('some rows slide past one lane beside the ship',
  nearMiss > 20, `${nearMiss}/800 near misses`);
check('no generated row is wider than the cap',
  maxSpan <= WALLS.maxTiles && farAnchor === 0,
  `widest generated row ${maxSpan} tiles`);
check('clusters follow the ship far off the world axis',
  (() => {
    const row = pickTileRow(createRandom(4242), 1, { anchorLane: -9 });
    return row.blocked.every((lane) => Math.abs(lane + 9) <= WALLS.maxTiles);
  })(),
  'anchor lane -9');

// A reward lane in flight is meant to stay open more often than chance. The lane
// has to be one the clusters would otherwise sweep, so it sits beside the anchor.
const preferRng = createRandom(5150);
const plainRng = createRandom(5150);
let preferBlocked = 0;
let plainBlocked = 0;
for (let i = 0; i < 900; i += 1) {
  const difficulty = 0.5;
  if (pickTileRow(preferRng, difficulty, { anchorLane: 0, preferLane: 2 }).blocked.includes(2)) preferBlocked += 1;
  if (pickTileRow(plainRng, difficulty, { anchorLane: 0 }).blocked.includes(2)) plainBlocked += 1;
}
check('a reward lane is kept open more often than a random one',
  preferBlocked < plainBlocked * 0.85 && plainBlocked > 100,
  `${preferBlocked} vs ${plainBlocked} of 900 rows`);
check('the reward bias parks the cluster on the far side of the orb lane',
  // rand 0.1 always fires the bias branch: the orb in lane 1 sits to the right of
  // the anchor, so all four tiles have to land right of it
  tileRow(chooseTileStart(() => 0.1, 4, 0, 1), 4).blocked.join(',') === '2,3,4,5',
  `lanes ${tileRow(chooseTileStart(() => 0.1, 4, 0, 1), 4).blocked.join(',')}`);
check('the widest row leaves most of the reachable band open',
  freeWithin(tileRow(0, WALLS.maxTiles).blocked, 0).length === LANES.reach * 2 + 1 - WALLS.maxTiles,
  `${freeWithin(tileRow(0, WALLS.maxTiles).blocked, 0).length} of ${LANES.reach * 2 + 1} modelled lanes`);
check('a single lane is wide enough for the ship', laneIsFlyableByShip(),
  `lane ${LANES.width} vs ship ${(SHIP.halfExtents.x * 2).toFixed(2)}`);

/* warning scaling is still driven by speed --------------------------- */
const cruiseFlight = { warnDuration: warningDurationAt(0.5, SPEED.base), solidDuration: solidDurationAt(0.5) };
check('a cluster reads the same size however fast the run is',
  WALLS.maxTiles * LANES.width <= 26 && cruiseFlight.warnDuration > 0.5,
  `${WALLS.maxTiles * LANES.width} world units wide at any speed`);

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

/* tile-row geometry --------------------------------------------------- */
const cluster = tileRow(3, 4);
check('a cluster blocks exactly the lanes its tiles stand on',
  cluster.blocked.join(',') === '3,4,5,6' &&
    cluster.segments.length === 1 &&
    nearly(cluster.width, 4 * LANES.width),
  `${cluster.blocked.length} tiles, ${cluster.width} world units`);
check('the space beside a cluster is open in the collision geometry',
  !boxesOverlap(playerBox(laneCenterX(2), 0.75, 0), wallBox(3, 4, 0)) &&
    !boxesOverlap(playerBox(laneCenterX(7), 0.75, 0), wallBox(3, 4, 0)) &&
    boxesOverlap(playerBox(laneCenterX(3), 0.75, 0), wallBox(3, 4, 0)) &&
    boxesOverlap(playerBox(laneCenterX(6), 0.75, 0), wallBox(3, 4, 0)),
  'lanes 2 and 7 stay flyable past a 4-tile row');

/* fallbacks ------------------------------------------------------------ */
check('pocket fallbacks park the cluster outside the safe pocket',
  (() => {
    const options = candidatesKeepingPocket([2, 3], 2);
    return (
      options.length > 0 &&
      options.every((row) => row.span <= WALLS.maxTiles) &&
      options.every((row) => !row.blocked.includes(2) && !row.blocked.includes(3))
    );
  })(),
  `${candidatesKeepingPocket([2, 3], 2).length} candidates`);
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
      });
      if (picked.row.free.length === 0 || picked.row.span > WALLS.maxTiles) return false;
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
