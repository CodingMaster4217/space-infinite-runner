/**
 * Global tuning constants for HYPERDRIVE.
 * Everything a designer would want to tweak lives here.
 */

export const LANES = {
  /** lanes covered by one obstacle window (the band rows are generated in) */
  count: 5,
  width: 4.8,
  /**
   * How far either side of the ship the fairness model looks, in lanes.
   * Lanes are unbounded (the plane has no left/right border), so the model
   * reasons about a generous neighbourhood around the ship instead of a
   * fixed corridor.
   */
  reach: 12,
};

export const CORRIDOR = {
  length: 760,
  spawnZ: -300,
  despawnZ: 26,
  /** width of the ground plane; it is re-centred on the camera every frame */
  planeWidth: 2600,
};

/**
 * Wall hazards.
 *
 * Every row is a *full-width barrier*: it covers the whole play area around the
 * ship — the band it could physically reach plus everything visible beside it —
 * and leaves exactly one free gap. Holding left or right therefore cannot escape
 * a row; the only way through is the gap, which the fairness model guarantees is
 * reachable in time.
 */
export const WALLS = {
  /** lanes covered beyond the band the ship could physically reach */
  edgeMargin: 1,
  /** a row never covers less than this many lanes each side of the ship */
  minHalfLanes: 5,
  /** ...and never more: past this the extra geometry buys no gameplay */
  maxHalfLanes: 14,
  /** free gap width in lanes, eased from `start` (easy) to `end` (hard) */
  gap: { start: 3, end: 1.4 },
  /**
   * World-space lookahead the warning phase must extend down the track. It grows
   * with speed, so the faster the run the further ahead the barrier is announced.
   */
  lookahead: { base: 62, gain: 0.85, max: 215 },
  /** floor strip drawn under the incoming wall, in world units (speed-scaled) */
  strip: { base: 26, perSpeed: 0.22, max: 74 },
  /** how strongly the reaction cushion grows with speed (fraction per ×base) */
  speedWarningGain: 0.55,
  /** warning indicator colours: light red → dark red → deepest red */
  colors: { light: 0xff8888, dark: 0x880000, deepest: 0x440000 },
  /** seconds of flash + squash when the barrier solidifies (the "pop") */
  pop: 0.3,
};

/**
 * The celestial destination: a glowing core sitting exactly on the vanishing
 * point of the view axis, with light rays converging on it. Positioned from the
 * camera every frame, so it stays locked to the horizon on any viewport.
 */
export const HORIZON = {
  /** distance of the body along the view axis (world units) */
  distance: 1250,
  /** vertical screen position of the core, in normalised device coords */
  ndcY: 0.22,
  coreScale: 132,
  /** ray fan quad; kept modest because it is additive full-screen fill */
  rayScale: { x: 820, y: 520 },
  opacity: 0.5,
};

export const SHIP = {
  startY: 0.75,
  halfExtents: { x: 0.95, y: 0.52, z: 1.45 },
  /** collision sphere radius used against power-up orbs */
  radius: 1.15,
  maxLateralSpeed: 17.5,
  lateralAccel: 46,
  lateralDamping: 9.5,
  bankMax: 0.62,
};

/**
 * Lane space is unbounded: index 0 sits on the world axis and there is no last
 * lane. Lane `n` is centred at `n * LANES.width`. Obstacle rows are anchored to
 * whichever lane the ship is flying in, so the track keeps generating danger
 * wherever the player steers.
 */
export const laneCenterX = (index) => index * LANES.width;

/** Lane index containing world x (unbounded; may be negative). */
export const laneIndexAt = (x) => Math.round(x / LANES.width);

export const SPEED = {
  base: 46,
  gainPerSecond: 1.55,
  max: 205,
  boostMultiplier: 1.95,
  timeDilation: 0.42,
};

export const DIFFICULTY = {
  /** distance (metres) at which difficulty reaches 1.0 */
  fullAtDistance: 9000,
  warning: { start: 1.8, end: 0.55 },
  /**
   * Clear track between the end of one barrier and the next one turning solid,
   * in seconds.
   *
   * This is the *lane-change window*, and it is what makes a full-width barrier a
   * game rather than a rail: while a barrier is sweeping past the ship it cannot
   * cross any blocked lane, so the hole in the next barrier is only reachable if
   * this window is at least a lane transit long. `scripts/fairness.js` proves the
   * generated sequence stays inside it.
   */
  rowBreathing: { start: 1.15, end: 0.72 },
  /** minimum distance between consecutive rows, in world units */
  minRowGap: 34,
  /** documented bound on how much of a lane window a single row may block */
  maxBlockedShare: 0.8,
};

/**
 * Fairness guard. The spawner validates every row against these margins so the
 * generated obstacle sequence always has a physically dodgeable path, even after
 * the corridor has accelerated while the walls were in flight.
 */
export const FAIRNESS = {
  /** travel-time cushion demanded by the spawn-time check (seconds) */
  safety: 0.22,
  /** slack required when verifying an already-flown timeline (seconds) */
  verifySafety: 0.02,
  /** the ship is considered settled once its hull is inside the lane */
  transitionMargin: 0.16,
};

export const POWERUPS = {
  boostDuration: 4.2,
  brakeDuration: 5,
  /** seconds of shielding grace after absorbing a hit */
  postHitInvuln: 1.35,
  spawnInterval: { start: 8.5, end: 5.2 },
  orbRadius: 0.92,
  hoverHeight: 1.5,
};

export const CAMERA = {
  fov: 72,
  position: { x: 0, y: 3.35, z: 9.2 },
  lookAt: { x: 0, y: 1.35, z: -13 },
  /**
   * Lateral drift left between the camera and the ship, as a share of the
   * visible half-width at the ship's depth. The plane is endless, so the camera
   * can no longer depend on a corridor edge to keep the ship framed: it tracks
   * the ship's absolute position and only ever lags by this fraction, on any
   * viewport.
   */
  driftShare: 0.5,
  /** how far past the ship the aim point leads the drift (view leans in) */
  lookLead: 0.5,
  followY: 0.25,
  boostFovKick: 13,
};

export const COLORS = {
  cyan: 0x3ff2ff,
  cyanSoft: 0x9bf4ff,
  magenta: 0xff3fd1,
  violet: 0x8c5cff,
  red: 0xff2b45,
  gold: 0xffd24a,
  green: 0x4dffa6,
  blue: 0x3b8bff,
  hull: 0x111a2c,
  hullLight: 0x2b3d5e,
  wall: 0x1a1030,
  bg: 0x03040a,
  fog: 0x070b18,
};

export const POWERUP_TYPES = {
  boost: {
    id: 'boost',
    label: 'Speed Boost',
    hudLabel: 'Boost',
    color: COLORS.green,
    accent: COLORS.cyan,
    cssClass: 'boost',
  },
  brake: {
    id: 'brake',
    label: 'Warp Brake',
    hudLabel: 'Brake',
    color: COLORS.blue,
    accent: COLORS.violet,
    cssClass: 'brake',
  },
  shield: {
    id: 'shield',
    label: 'Shield Core',
    hudLabel: 'Shield',
    color: COLORS.gold,
    accent: 0xfff0b0,
    cssClass: 'shield',
  },
};

export const STORAGE_KEY = 'hyperdrive.best.v1';
