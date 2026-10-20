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
 * A row is a *cluster of wall tiles* — one tile per lane, at most
 * `maxTiles` of them standing side by side — placed near the lane the ship is
 * heading for. The ship flies around a cluster instead of threading a hole in a
 * field-wide barrier, so a row is a local obstacle, not a wall across the screen.
 *
 * Both the size and the cadence are chaotic on purpose: the row width is drawn
 * per row, and rows are laid down every *distance* (not every N seconds) with a
 * three-way draw that mixes tight bursts, ordinary gaps and long breathers.
 */
export const WALLS = {
  /** Hard cap: no row ever stands more than five tiles side by side. */
  maxTiles: 5,
  /** tiles per row, eased from `start` (sparse) to `end` (dense), inclusive */
  tiles: { start: { min: 1, max: 2 }, end: { min: 2, max: 5 } },
  /** world units shaved off each tile so neighbours read as separate walls */
  seam: 0.34,
  /**
   * Slab profile of a single tile, in world units. Deliberately small: a tile is
   * barely taller than the hull and one lane wide, so a five-tile row is still a
   * cluster the player can read and fly around at speed.
   */
  size: { height: 2.05, thickness: 1.25 },
  /**
   * World distance between rows, in units travelled — the spawner is driven by
   * distance, not a timer, so the spacing is regular only if this function is.
   * A three-way draw (burst / jitter / breather) keeps it from ever reading as a
   * metronome: `burst` and `breather` are multipliers on the base gap, `jitter`
   * is the half-width of the ordinary draw.
   */
  spacing: { start: 108, end: 176, burst: 0.6, jitter: 0.5, breather: 1.85 },
  /** share of rows placed to block the lane the ship is heading for */
  threatShare: 0.78,
  /**
   * World-space lookahead the warning phase must extend down the track. It grows
   * with speed, so the faster the run the further ahead the barrier is announced.
   */
  lookahead: { base: 62, gain: 0.85, max: 215 },
  /** floor strip drawn under the incoming wall, in world units (speed-scaled) */
  strip: { base: 26, perSpeed: 0.22, max: 74 },
  /** how strongly the reaction cushion grows with speed (fraction per ×base) */
  speedWarningGain: 0.55,
  /**
   * Ceiling on that stretch, in seconds. The warning *distance* still grows with
   * speed; this only caps how long a cluster hangs in the air before it lands, so
   * the screen never fills with more than a couple of warnings at once.
   */
  warningStretchCap: 2.2,
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
  /** reaction window on the warning, eased from `start` (easy) to `end` (hard) */
  warning: { start: 1.8, end: 0.55 },
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
