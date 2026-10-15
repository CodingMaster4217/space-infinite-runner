/**
 * Pure collision + difficulty math.
 * Kept free of Three.js so it can be unit-tested in plain Node.
 */

import { LANES, DIFFICULTY, SPEED, SHIP, POWERUPS, WALLS, laneCenterX } from './config.js';
import { clamp } from './utils.js';

/* ------------------------------------------------------------------ */
/* Collision primitives                                                */
/* ------------------------------------------------------------------ */

/** Axis-aligned box described by its centre and half extents. */
export const makeBox = (cx, cy, cz, hx, hy, hz) => ({ cx, cy, cz, hx, hy, hz });

export const boxesOverlap = (a, b) =>
  Math.abs(a.cx - b.cx) <= a.hx + b.hx &&
  Math.abs(a.cy - b.cy) <= a.hy + b.hy &&
  Math.abs(a.cz - b.cz) <= a.hz + b.hz;

/** Player collision volume (slightly forgiving: shaved tips). */
export const playerBox = (x, y, z, shrink = 0.86) =>
  makeBox(
    x,
    y,
    z,
    SHIP.halfExtents.x * shrink,
    SHIP.halfExtents.y * shrink,
    SHIP.halfExtents.z * shrink
  );

/** A wall that occupies `laneCount` contiguous lanes starting at `laneIndex`. */
export const wallBox = (laneIndex, laneSpan, z, thickness = WALLS.size.thickness) => {
  const first = laneCenterX(laneIndex);
  const last = laneCenterX(laneIndex + laneSpan - 1);
  const cx = (first + last) / 2;
  const hx = (Math.abs(last - first) + LANES.width) / 2;
  const halfHeight = WALLS.size.height / 2;
  return makeBox(cx, halfHeight, z, hx, halfHeight, thickness / 2);
};

export const sphereOverlap = (ax, ay, az, ar, bx, by, bz, br) => {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  const r = ar + br;
  return dx * dx + dy * dy + dz * dz <= r * r;
};

/* ------------------------------------------------------------------ */
/* Difficulty curve                                                    */
/* ------------------------------------------------------------------ */

/** 0 → 1 ramp driven purely by distance travelled. */
export const difficultyAt = (distance) =>
  clamp(distance / DIFFICULTY.fullAtDistance, 0, 1);

/** Base corridor speed for a given elapsed time and difficulty. */
export const baseSpeedAt = (elapsed, difficulty) =>
  Math.min(SPEED.max, SPEED.base + elapsed * SPEED.gainPerSecond * (0.65 + difficulty * 0.7));

/**
 * World-space lookahead the warning phase must cover at a given speed.
 *
 * The warning is not just a reaction *time*: it is a distance down the track, and
 * that distance grows as the run accelerates so the barrier is spotted earlier
 * (in metres) the faster the ship is travelling.
 */
export const warningLookaheadAt = (speed) =>
  clamp(WALLS.lookahead.base + (speed - SPEED.base) * WALLS.lookahead.gain, WALLS.lookahead.base, WALLS.lookahead.max);

/**
 * How long the red lane warning stays up before the wall materialises.
 *
 * Difficulty shortens the window (harder = tighter reaction), but speed stretches
 * it back out so the *lookahead distance* keeps growing with speed. At cruise
 * speed this is exactly the old difficulty curve, which keeps balance runs
 * comparable over time.
 */
export const warningDurationAt = (difficulty, speed = SPEED.base) => {
  const { start, end } = DIFFICULTY.warning;
  const base = start - (start - end) * Math.pow(difficulty, 0.85);
  const speedFactor = clamp(speed / SPEED.base, 1, 3);
  const scaled = base * (1 + WALLS.speedWarningGain * (speedFactor - 1));
  // The stretch is capped (rather than left to grow with the difficulty curve's
  // `start`): the warning *distance* keeps growing with speed either way, and the
  // cap is what keeps the reachable band — and so the barrier's width — bounded
  // at boost speed. See `WALLS.warningStretchCap` and `wallReachLanes`.
  return clamp(scaled, end, WALLS.warningStretchCap);
};

/** Warning distance actually realised at this difficulty + speed, in world units. */
export const warningDistanceAt = (difficulty, speed = SPEED.base) =>
  warningDurationAt(difficulty, speed) * speed;

/** Length of the floor warning strip drawn ahead of the wall (speed-scaled). */
export const warningStripLengthAt = (speed = SPEED.base) =>
  clamp(WALLS.strip.base + speed * WALLS.strip.perSpeed, WALLS.strip.base, WALLS.strip.max);

/**
 * Free gap width (in lanes) a full-width row leaves, by difficulty.
 * The barrier is unavoidable, so the gap is the whole game: generous early,
 * thread-the-needle late.
 */
export const gapLanesAt = (difficulty = 0) => {
  const { start, end } = WALLS.gap;
  const lanes = start - (start - end) * Math.pow(clamp(difficulty, 0, 1), 0.9);
  return Math.max(1, Math.round(lanes));
};

/**
 * The band the ship could physically cross while a row is in flight, in lanes
 * each side of the lane it holds when the row arrives, plus one lane of cushion.
 *
 * This is the *hard* lower bound on how wide a barrier has to be: anything
 * narrower can be outflown sideways, which is exactly the perimeter exploit
 * full-width rows exist to close. Kept separate from `wallHalfLanes` (which may
 * enlarge the window for looks) so the bound can be asserted against
 * `WALLS.maxHalfLanes` instead of being silently clamped below what it must be.
 */
export const wallReachLanes = ({ warnDuration, solidDuration } = {}) => {
  const flight = Math.max(0.2, (warnDuration ?? 1.2) + (solidDuration ?? 0.9));
  return Math.ceil((SHIP.maxLateralSpeed * flight) / LANES.width) + WALLS.edgeMargin;
};

/**
 * How many lanes each side of the ship a wall row must cover.
 *
 * Two constraints are reconciled:
 *   - *reach*: the ship travels up to `maxLateralSpeed × flightTime` while the row
 *     is in flight, so a narrower barrier could simply be outrun sideways;
 *   - *sight*: the barrier should read as filling the play area, so it also covers
 *     half of what the frustum shows at the warning distance.
 *
 * The window is deliberately kept to the smallest span that still satisfies both:
 * a barrier only stays on screen for as long as it sweeps past the ship, so every
 * lane of extra geometry is screen clutter the player has to read on the way in.
 */
export const wallHalfLanes = ({
  speed,
  warnDuration,
  solidDuration,
  aspect = 16 / 9,
  fov = 72,
} = {}) => {
  const flight = Math.max(0.2, (warnDuration ?? 1.2) + (solidDuration ?? 0.9));
  const reachLanes = wallReachLanes({ warnDuration, solidDuration });
  const depth = Math.max(30, (speed ?? SPEED.base) * flight * 0.5);
  const halfWidth = depth * Math.tan((fov * Math.PI) / 360) * aspect;
  const visibleLanes = Math.ceil((halfWidth / LANES.width) * 0.5) + WALLS.edgeMargin;
  return clamp(Math.max(reachLanes, visibleLanes), WALLS.minHalfLanes, WALLS.maxHalfLanes);
};

/** Lane window (count) implied by a half-width. */
export const laneWindowFor = (halfLanes) => halfLanes * 2 + 1;

/* ------------------------------------------------------------------ */
/* warning colour ramp                                                 */
/* ------------------------------------------------------------------ */

const rgbOf = (hex) => ({
  r: ((hex >> 16) & 255) / 255,
  g: ((hex >> 8) & 255) / 255,
  b: (hex & 255) / 255,
});

/**
 * Warning indicator colour over its life: light red (#ff8888) → dark red
 * (#880000) over the first 70% of the warning, then deeper still (#440000) as it
 * is about to solidify. Returns linear 0..1 channels so it is testable without a
 * renderer.
 */
export const warningColorAt = (progress) => {
  const t = clamp(progress, 0, 1);
  const { light, dark, deepest } = WALLS.colors;
  const early = t < 0.7;
  const from = rgbOf(early ? light : dark);
  const to = rgbOf(early ? dark : deepest);
  const k = early ? t / 0.7 : (t - 0.7) / 0.3;
  const e = k * k * (3 - 2 * k); // smoothstep: the shift is unmistakable mid-warning
  return {
    r: from.r + (to.r - from.r) * e,
    g: from.g + (to.g - from.g) * e,
    b: from.b + (to.b - from.b) * e,
  };
};

/** Warning colour as a CSS hex string (used by the HUD alert chip). */
export const warningCssAt = (progress) => {
  const { r, g, b } = warningColorAt(progress);
  const hex = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
};

/**
 * Clear track between one barrier clearing the ship and the next turning solid.
 * This is the lane-change window the fairness model relies on.
 */
export const rowBreathingAt = (difficulty) => {
  const { start, end } = DIFFICULTY.rowBreathing;
  return start - (start - end) * Math.pow(clamp(difficulty, 0, 1), 0.9);
};

/**
 * Seconds between obstacle rows.
 *
 * A barrier is dangerous from the moment it materialises until it has swept past
 * the ship: `2 × solidDuration` seconds on the ship's clock. While it is sweeping
 * it, the ship cannot cross any blocked lane, so the next barrier must not turn
 * solid until then plus a real breathing space — otherwise the ship has no window
 * in which to reach the next gap, and every hole has to sit on the lane it is
 * already flying. Interval = 2 × solid + breathing, with a light jitter that never
 * eats into the window.
 */
export const rowIntervalAt = (difficulty, rand = Math.random) => {
  const solid = solidDurationAt(difficulty);
  // jitter only ever *adds* time, so the guaranteed window is never eaten into
  return (2 * solid + rowBreathingAt(difficulty)) * (1 + rand() * 0.08);
};

/** Seconds between power-up drops (rarer as the run gets faster, but never scarce). */
export const powerupIntervalAt = (difficulty, rand = Math.random) => {
  const { start, end } = POWERUPS.spawnInterval;
  return start - (start - end) * difficulty * (0.75 + rand() * 0.5);
};

/* ------------------------------------------------------------------ */
/* Obstacle pattern generation                                         */
/* ------------------------------------------------------------------ */

/** Contiguous runs of a sorted, gap-free lane list. */
export const runsOf = (lanes) => {
  const runs = [];
  let run = null;
  for (const lane of lanes) {
    if (run && lane === run.start + run.span) run.span += 1;
    else {
      run = { start: lane, span: 1 };
      runs.push(run);
    }
  }
  return runs;
};

const nearestFreeDistance = (freeA, freeB) => {
  let best = Infinity;
  for (const a of freeA) for (const b of freeB) best = Math.min(best, Math.abs(a - b));
  return best;
};

/**
 * Turn a gap position into a whole wall row inside a lane window.
 *
 * The row blocks every lane of the window except the `gap`, so the window reads
 * as one barrier spanning the full play area with a single hole in it (rendered
 * as one or two contiguous segments either side of the hole).
 *
 * @param {number} gapStart window-relative first lane of the gap
 * @param {number} gapWidth lanes left open
 * @param {number} count lanes in the window
 * @returns {{start:number, span:number, blocked:number[], free:number[], segments:{start:number,span:number}[], gap:number[]}}
 */
export const fullWidthRow = (gapStart, gapWidth, count) => {
  const width = Math.max(1, Math.min(gapWidth, count - 1));
  // keep at least `edge` lanes blocked on each side of the hole: a gap flush with
  // the window edge would leave a lane at the far end of the play area that a
  // player could simply hug, which is exactly the perimeter exploit to close.
  const edge = Math.max(1, Math.min(WALLS.edgeMargin, Math.floor((count - width) / 2)));
  const maxStart = Math.max(0, count - width - edge);
  const start = Math.max(Math.min(edge, maxStart), Math.min(Math.max(0, gapStart), maxStart));
  const gap = [];
  for (let i = 0; i < width; i += 1) gap.push(start + i);
  const blocked = [];
  for (let lane = 0; lane < count; lane += 1) if (lane < start || lane >= start + width) blocked.push(lane);
  const segments = runsOf(blocked);
  const first = segments.length ? segments[0].start : start;
  const lastSeg = segments.length ? segments[segments.length - 1] : { start, span: 1 };
  return {
    start: first,
    span: lastSeg.start + lastSeg.span - first,
    blocked,
    free: gap.slice(),
    segments,
    gap,
  };
};

/**
 * Where to put the gap inside a lane window.
 *
 * The window is centred on the lane the ship is *predicted* to hold, and the hole
 * is deliberately never left on that lane. A full-width barrier whose gap sits
 * under the ship is a free pass: a pilot that never touches the controls would
 * coast through the whole run. Instead the hole is pushed to one side of the
 * ship's lane by at least a lane — the barrier asks for a real (short) lane
 * change every single row, and only the two rewards that keep a *specific* lane
 * interesting override that:
 *
 *   - an orb in flight pulls the hole towards itself so the reward stays
 *     collectable through the barrier the player has to thread;
 *   - the previous hole is sometimes continued, which rewards a player who is
 *     already flying the line the last barrier left open.
 */
const chooseGapStart = (rand, count, gap, previousFree, tightGap, prefer = null) => {
  const maxStart = Math.max(0, count - gap);
  const centred = (lane) => Math.max(0, Math.min(maxStart, Math.round(lane - (gap - 1) / 2)));
  // lane the row is anchored on: the ship's own lane inside this window
  const ship = Math.floor(count / 2);

  if (prefer !== null && prefer !== undefined && rand() < 0.55) return centred(prefer);

  // Sometimes continue the lane that was open last row. It is deliberately a
  // bias and not a rule: if the gap always followed the previous one, a ship that
  // never steers would sit in a straight tube for ever — exactly the perimeter
  // exploit full-width barriers exist to close.
  if (previousFree && previousFree.length && rand() < (tightGap ? 0.35 : 0.25)) {
    const target = previousFree.reduce((best, lane) =>
      Math.abs(lane - ship) < Math.abs(best - ship) ? lane : best
    , previousFree[0]);
    return centred(target);
  }

  // Otherwise the hole is pushed off the ship's lane: pick a side, then how many
  // lanes of travel the row demands. One lane is the bread-and-butter demand;
  // two or three are the occasional real lane change (the fairness guard rejects
  // them when the walls in flight leave no time, and retries).
  const side = rand() < 0.5 ? -1 : 1;
  const away = 1 + (rand() < 0.3 ? 1 : 0) + (rand() < 0.08 ? 1 : 0);
  // the whole hole has to clear `ship`: left of it, or right of it
  const start = side < 0 ? ship - away - gap + 1 : ship + away;
  return Math.max(0, Math.min(maxStart, start));
};

/**
 * Pick a full-width wall row.
 *
 * @param {() => number} rand
 * @param {number} difficulty 0..1
 * @param {number[]|null} previousFree window-relative lanes that were open last row
 * @param {boolean} tightGap require the gap to stay adjacent to the previous one
 * @param {number} laneCount lanes the barrier spans (grows with speed)
 * @param {number|null} gapWidth lanes left open (defaults to the difficulty curve)
 * @param {number|null} prefer window-relative lane to weight the gap towards
 * @returns {{start:number, span:number, blocked:number[], free:number[], segments:{start:number,span:number}[], gap:number[], reach:number}} lanes
 */
export function pickWallRow(
  rand,
  difficulty,
  previousFree = null,
  tightGap = false,
  laneCount = LANES.count,
  gapWidth = null,
  prefer = null
) {
  const count = Math.max(3, Math.round(laneCount));
  const gap = Math.max(1, Math.min(Math.round(gapWidth ?? gapLanesAt(difficulty)), count - 2));

  let best = null;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const row = fullWidthRow(chooseGapStart(rand, count, gap, previousFree, tightGap, prefer), gap, count);
    row.reach = previousFree ? nearestFreeDistance(previousFree, row.free) : Infinity;
    if (row.reach <= 1) {
      best = row;
      break;
    }
    // nothing satisfies the tight rule (the window may have moved on since the
    // last row): keep the tightest attempt so the pattern still trends inward
    if (!best || row.reach < best.reach) best = row;
  }

  if (!best) {
    best = fullWidthRow(Math.floor((count - gap) / 2), gap, count);
    best.reach = Infinity;
  }
  return best;
}

/** Guarantees at least one lane of breathing room for the ship. */
export const laneIsFlyableByShip = () => LANES.width > SHIP.halfExtents.x * 2.4;

/**
 * Seconds a wall stays solid as it sweeps past the ship.
 *
 * Shorter than it used to be: the sweep time is what makes a barrier feel like a
 * slab rather than a gate, and it also sets the barrier's lateral footprint (see
 * `wallReachLanes`). Trimming it shrinks the wall *and* tightens the row cadence,
 * because the interval between rows is derived from it.
 */
export const solidDurationAt = (difficulty) => 0.8 - 0.26 * clamp(difficulty, 0, 1);

/** Convert world speed to a display speed (km/h) for the HUD. */
export const toDisplaySpeed = (worldSpeed) => worldSpeed * 21;
