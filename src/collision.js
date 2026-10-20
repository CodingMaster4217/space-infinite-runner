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
 * How many tiles a row gets at this difficulty.
 *
 * Early rows are a single wall or a pair; the late game draws up to the cap of
 * five. The result never exceeds `WALLS.maxTiles` — that cap is the whole point
 * of the row model, so it is asserted directly in `scripts/test-logic.js`.
 */
export const tileCountAt = (difficulty = 0, rand = Math.random) => {
  const d = clamp(difficulty, 0, 1);
  const { start, end } = WALLS.tiles;
  const min = Math.round(start.min + (end.min - start.min) * d);
  const max = Math.round(start.max + (end.max - start.max) * d);
  const spread = Math.max(0, max - min);
  return clamp(min + Math.floor(rand() * (spread + 1)), 1, WALLS.maxTiles);
};

/**
 * Absolute lane a row of `tiles` tiles starts on.
 *
 * Three placements keep the pattern from settling into a rhythm:
 *   - a power-up in flight pulls the cluster to one side so the reward lane
 *     stays open and collectable;
 *   - a *near miss* slides past one lane beside the ship, which the player can
 *     ignore (no steering needed, and no free pass either);
 *   - a *threat* stands on the lane the ship is heading for. The ship's offset
 *     inside the cluster is biased towards the near edge, so most rows ask for a
 *     single-lane move and the deeper placements are the occasional real lane
 *     change (the fairness guard rejects those when the traffic in flight leaves
 *     no time).
 */
export const chooseTileStart = (rand, tiles, anchorLane, preferLane = null) => {
  const span = clamp(Math.round(tiles), 1, WALLS.maxTiles);

  if (preferLane !== null && preferLane !== undefined && rand() < 0.32) {
    return preferLane >= anchorLane ? preferLane + 1 : preferLane - span;
  }

  if (rand() > WALLS.threatShare) {
    // near miss: one lane of clearance, or occasionally a wide berth
    const clear = rand() < 0.7 ? 1 : 2;
    return rand() < 0.5 ? anchorLane + clear : anchorLane - span - (clear - 1);
  }

  const into = Math.min(span - 1, Math.floor(Math.pow(rand(), 1.7) * span));
  return anchorLane - into;
};

/**
 * A contiguous row of `tiles` wall tiles starting at an absolute lane.
 * The row is one segment of at most `WALLS.maxTiles` tiles — a local obstacle,
 * not a barrier across the play area.
 */
export const tileRow = (startLane, tiles) => {
  const span = clamp(Math.round(tiles), 1, WALLS.maxTiles);
  const start = Math.round(startLane);
  const blocked = [];
  for (let i = 0; i < span; i += 1) blocked.push(start + i);
  return {
    start,
    span,
    tiles: span,
    blocked,
    segments: [{ start, span }],
    width: span * LANES.width,
  };
};

/** Pick a chaotic tile row for the current difficulty. */
export const pickTileRow = (rand, difficulty, { anchorLane = 0, preferLane = null } = {}) => {
  const tiles = tileCountAt(difficulty, rand);
  return tileRow(chooseTileStart(rand, tiles, anchorLane, preferLane), tiles);
};

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
 * World distance to travel before the next row is laid down.
 *
 * Rows are placed by *distance*, not by a timer: they land at irregular points on
 * the track instead of on a metronome. Three draws share the mix — a tight burst,
 * an ordinary jittered gap and the occasional long breather — so neither the row
 * width nor the rhythm ever repeats exactly.
 *
 * The base gap widens with difficulty because the ship covers more ground per
 * second: in world units rows sit further apart, in play they arrive far more
 * often (≈ 2.9 s apart at the start of a run, under a second at full tilt).
 */
export const rowDistanceAt = (difficulty = 0, rand = Math.random) => {
  const { start, end, burst, jitter, breather } = WALLS.spacing;
  const t = Math.pow(clamp(difficulty, 0, 1), 0.9);
  const base = start + (end - start) * t;
  const roll = rand();
  if (roll < 0.22) return base * burst * (0.85 + rand() * 0.3);
  if (roll < 0.4) return base * breather * (0.9 + rand() * 0.3);
  return base * (1 - jitter / 2 + rand() * jitter);
};

/** Seconds between power-up drops (rarer as the run gets faster, but never scarce). */
export const powerupIntervalAt = (difficulty, rand = Math.random) => {
  const { start, end } = POWERUPS.spawnInterval;
  return start - (start - end) * difficulty * (0.75 + rand() * 0.5);
};

/** Guarantees at least one lane of breathing room for the ship. */
export const laneIsFlyableByShip = () => LANES.width > SHIP.halfExtents.x * 2.4;

/**
 * Seconds a cluster stays solid as it sweeps past the ship.
 *
 * Kept short: this is the part of the flight a tile can actually hit the hull, so
 * it sets how long the player has to be clear of a row rather than merely how
 * long it is visible on the way in.
 */
export const solidDurationAt = (difficulty) => 0.8 - 0.26 * clamp(difficulty, 0, 1);

/** Convert world speed to a display speed (km/h) for the HUD. */
export const toDisplaySpeed = (worldSpeed) => worldSpeed * 21;
