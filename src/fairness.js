/**
 * Fairness model — guarantees that the spawner never produces an obstacle
 * sequence the ship cannot physically dodge.
 *
 * A wall row is only dangerous while it is *solid*: from the moment it
 * materialises until it sweeps past the ship. During that window the ship must
 * sit in a lane the row leaves open, and it cannot cross a lane the row blocks.
 *
 * Timeline model
 * --------------
 * Split the timeline into phases in which the set of solid rows is constant.
 * Inside a phase the free lanes are those open for *every* solid row; adjacent
 * free lanes form a "pocket" the ship may move around inside without crossing a
 * blocked band. Between two phases the ship has a gap (which can be zero) to
 * travel between pockets.
 *
 * This is deliberately conservative: if a sequence is feasible here, it is
 * definitely flyable in the game.
 */

import { FAIRNESS, LANES, SHIP, laneCenterX } from './config.js';
import { pickTileRow, tileRow } from './collision.js';
import { clamp } from './utils.js';

export const LANE_COUNT = LANES.count;
export const LANE_TRANSITION_MARGIN = FAIRNESS.transitionMargin;

/** Seconds for the hull to travel from one lane centre to another, from rest. */
export function transitionSeconds(fromLane, toLane) {
  const fromX = laneCenterX(fromLane);
  const toX = laneCenterX(toLane);
  const distance = Math.abs(toX - fromX);
  if (distance < 1e-6) return 0;

  const dt = 0.01;
  const dir = Math.sign(toX - fromX);
  const cruise = SHIP.maxLateralSpeed;
  let x = fromX;
  let v = 0;
  let t = 0;
  while (Math.abs(toX - x) > LANE_TRANSITION_MARGIN && t < 8) {
    v += clamp(dir * cruise - v, -SHIP.lateralAccel * dt, SHIP.lateralAccel * dt);
    x += v * dt;
    t += dt;
  }
  return t;
}

/** 5×5 matrix of lane-to-lane travel times (lane 0..4). */
export const TRANSITION = Array.from({ length: LANE_COUNT }, (_, a) =>
  Array.from({ length: LANE_COUNT }, (_, b) => transitionSeconds(a, b))
);

/**
 * Travel time between two unbounded lane indices.
 *
 * Lane centres are evenly spaced, so the cost depends only on the lane delta
 * and is memoised per delta. This is what lets the model reason about lanes far
 * outside the old 5-lane corridor (there is no corridor any more).
 */
const transitCache = new Map([[0, 0]]);
export function transit(fromLane, toLane) {
  const delta = Math.abs(toLane - fromLane);
  let t = transitCache.get(delta);
  if (t === undefined) {
    t = transitionSeconds(0, delta);
    transitCache.set(delta, t);
  }
  return t;
}

/**
 * Lanes within `radius` of `centre` that `blocked` leaves open.
 *
 * Rows are described by the lanes they block and evaluated against a
 * neighbourhood of the ship, because the lane space has no boundaries.
 */
export function freeWithin(blocked, centre, radius = LANES.reach) {
  const out = [];
  for (let lane = centre - radius; lane <= centre + radius; lane += 1) {
    if (!blocked.includes(lane)) out.push(lane);
  }
  return out;
}

/** Maximal runs of adjacent lanes (each run is a space the ship can move around in). */
export function pocketsOf(laneList) {
  const runs = [];
  let run = [];
  for (const lane of laneList) {
    if (run.length === 0 || lane === run[run.length - 1] + 1) run.push(lane);
    else {
      runs.push(run);
      run = [lane];
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

/** Lanes left open by every free list (works for unbounded lane indices). */
export const lanesFreeForAll = (frees) => {
  if (frees.length === 0) return [];
  return frees[0].filter((lane) => frees.every((free) => free.includes(lane)));
};

export const lacksFreeLane = (free) => free.length === 0;

/**
 * @param {Array<{free:number[], materialiseIn:number, arrivalIn:number}>} rows
 *   Rows in chronological order, times in seconds relative to "now".
 * @param {{safety?:number, startPockets?:number[][]|null}} options
 * @returns {{feasible:boolean, reason:string, tightest:object|null, pockets:number[][]}}
 */
export function sequenceFeasible(rows, options = {}) {
  const safety = options.safety ?? FAIRNESS.safety;
  const result = { feasible: true, reason: 'ok', tightest: null, pockets: [], failure: null };

  const live = rows
    .filter((row) => row.arrivalIn > 0 && row.free.length > 0)
    .map((row) => ({
      free: row.free,
      start: Math.max(0, row.materialiseIn),
      end: Math.max(0, row.arrivalIn),
    }))
    .filter((row) => row.end > row.start);

  if (live.length === 0) return result;

  /* --- phases with a constant set of solid rows --------------------- */
  const events = [];
  live.forEach((row, index) => {
    events.push({ t: row.start, kind: 'start', index });
    events.push({ t: row.end, kind: 'end', index });
  });
  events.sort((a, b) => a.t - b.t || (a.kind === 'end' ? -1 : 1));

  const phases = [];
  const solid = new Set();
  let cursor = Math.max(0, events[0].t);
  for (const ev of events) {
    if (ev.t > cursor && solid.size > 0) {
      phases.push({ start: cursor, end: ev.t, solid: [...solid] });
    }
    cursor = Math.max(cursor, ev.t);
    if (ev.kind === 'start') solid.add(ev.index);
    else solid.delete(ev.index);
  }

  /* --- pocket dynamic program --------------------------------------- */
  // The player's safe pocket is fixed by history (pockets are separated by solid
  // walls), so a sequence only counts as fair when it is survivable from *every*
  // pocket the ship could legally be sitting in.
  const firstLegal = phases.length
    ? lanesFreeForAll(phases[0].solid.map((i) => live[i].free))
    : [];
  const firstPockets = phases.length ? pocketsOf(firstLegal) : [];

  const starts = options.startPockets
    ? [options.startPockets]
    : options.requireAllStartPockets && firstPockets.length
      ? firstPockets.map((pocket) => [pocket])
      : [null];

  let best = null;
  for (const start of starts) {
    const outcome = runDp(phases, live, start, safety);
    if (!outcome.feasible) {
      result.feasible = false;
      result.reason = outcome.reason;
      result.failure = outcome.failure;
      result.pockets = [];
      result.startPocket = start ? [...start[0]] : null;
      return result;
    }
    if (!best || (outcome.tightest && best.tightest && outcome.tightest.slack < best.tightest.slack)) {
      best = outcome;
    }
  }

  result.tightest = best ? best.tightest : null;
  result.pockets = best ? best.pockets : [];
  return result;
}

/** One DP pass from a given (possibly unknown) starting pocket. */
function runDp(phases, live, initialStates, safety) {
  const result = { feasible: true, reason: 'ok', tightest: null, pockets: [], failure: null };
  let states = initialStates; // null → the ship may be anywhere legal right now
  let prevEnd = 0;

  for (const phase of phases) {
    const legal = lanesFreeForAll(phase.solid.map((i) => live[i].free));
    const pools = pocketsOf(legal);
    if (pools.length === 0) {
      result.feasible = false;
      result.reason = 'no lane stays open for all walls that are solid simultaneously';
      result.failure = {
        at: phase.start,
        blockedLanes: phase.solid.map((i) => live[i].free),
        solidCount: phase.solid.length,
      };
      result.pockets = [];
      return result;
    }

    const gap = Math.max(0, phase.start - prevEnd);
    const reachable = [];
    let tightest = null;

    for (const pocket of pools) {
      let need = null;
      if (states === null) {
        need = 0; // the ship may already be anywhere legal right now
      } else {
        for (const prev of states) {
          const shared = prev.some((lane) => pocket.includes(lane));
          const candidate = shared
            ? 0
            : Math.min(...prev.flatMap((a) => pocket.map((b) => transit(a, b))));
          if (need === null || candidate < need) need = candidate;
        }
      }
      if (need === null) continue;
      // Holding a shared lane costs no time at all, so it is legal even when the
      // two phases touch (gap 0). Only actual movement needs a gap + safety.
      const slack = need === 0 ? gap : gap - need - safety;
      if (need === 0 ? gap >= 0 : need <= gap - safety) {
        reachable.push(pocket);
        if (!tightest || slack < tightest.slack) {
          tightest = { slack, need, gap, lane: pocket[0], at: phase.start };
        }
      }
    }

    if (reachable.length === 0) {
      result.feasible = false;
      result.reason = 'no safe pocket can be reached before the next wall turns solid';
      result.failure = {
        at: phase.start,
        gap,
        openLanes: legal,
        solidCount: phase.solid.length,
        needed: Math.min(
          ...(states ?? [[0]]).flatMap((prev) =>
            pools.flatMap((pocket) =>
              prev.some((lane) => pocket.includes(lane))
                ? [0]
                : prev.flatMap((a) => pocket.map((b) => transit(a, b)))
            )
          )
        ),
      };
      result.pockets = [];
      return result;
    }

    if (tightest && (!result.tightest || tightest.slack < result.tightest.slack)) {
      result.tightest = tightest;
    }
    states = reachable;
    prevEnd = phase.end;
  }

  result.pockets = states ?? [];
  return result;
}

/** Lanes left open by a contiguous blocked block. */
export function freeLanes(start, span, laneCount = LANE_COUNT) {
  const blocked = [];
  for (let i = 0; i < span; i += 1) blocked.push(start + i);
  return Array.from({ length: laneCount }, (_, l) => l).filter((l) => !blocked.includes(l));
}

/**
 * A row blocking `span` contiguous lanes from `start`, expressed in absolute
 * (unbounded) lane indices. `free` covers the neighbourhood of `centre` — the
 * lanes the ship could physically reach while the row is solid.
 */
export function blockRow(start, span, centre = start, radius = LANES.reach) {
  const blocked = [];
  for (let i = 0; i < span; i += 1) blocked.push(start + i);
  return { start, span, blocked, free: freeWithin(blocked, centre, radius) };
}

/** A single-lane wall row. */
export function singleLaneRow(lane, centre = lane, radius = LANES.reach) {
  return blockRow(lane, 1, centre, radius);
}

/**
 * Last-resort patterns: single-lane walls that leave every lane of `pocket`
 * open, so the ship can hold its safe corridor with zero lateral movement.
 */
export function candidatesKeepingPocket(pocket, centre = pocket[0] ?? 0) {
  const sorted = [...pocket].sort((a, b) => a - b);
  const left = sorted[0];
  const right = sorted[sorted.length - 1];
  const rows = [];
  for (let span = 1; span <= 3; span += 1) {
    rows.push(blockRow(right + 1, span, centre));
    rows.push(blockRow(left - span, span, centre));
  }
  return rows;
}

/**
 * Pick a wall cluster that is guaranteed dodgeable given everything already in
 * flight.
 *
 * A row is at most `WALLS.maxTiles` tiles wide and is placed near the lane the
 * ship is heading for (see `chooseTileStart`), so it is a local obstacle the ship
 * flies around rather than a barrier with a hole. Every candidate is checked with
 * the shared fairness model: the ship has to be able to sit in a lane that is
 * open for every row solid at that moment, and to reach it in the time available.
 *
 * If the difficulty-scaled placements cannot be made safe, the fallbacks park the
 * cluster just outside the ship's own safe pocket, which by definition leaves a
 * ship that is already flying legally untouched.
 */
export function selectFairRow({
  rand,
  difficulty,
  inFlight = [],
  warnDuration,
  solidDuration,
  /** lane the ship will be flying in when this row turns solid */
  anchorLane = 0,
  attempts = 16,
  safety = FAIRNESS.safety,
  /** absolute lane a reward is sitting in; the cluster is biased to leave it open */
  preferLane = null,
  radius = LANES.reach,
}) {
  const candidateArrival = warnDuration + solidDuration;
  const candidate = {
    materialiseIn: candidateArrival - solidDuration,
    arrivalIn: candidateArrival,
  };

  const feasible = (row, extraAttempts) => {
    const verdict = sequenceFeasible([...inFlight, { ...candidate, free: row.free }], {
      safety,
      requireAllStartPockets: true,
    });
    return verdict.feasible
      ? { row, attempts: extraAttempts, fallback: false, verdict }
      : verdict;
  };

  const place = (row) => {
    row.anchorLane = anchorLane;
    row.free = freeWithin(row.blocked, anchorLane, radius);
    return row;
  };

  let lastVerdict = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = place(pickTileRow(rand, difficulty, { anchorLane, preferLane }));
    const outcome = feasible(row, attempt + 1);
    if (outcome.row) return outcome;
    lastVerdict = outcome;
  }

  const openNow = sequenceFeasible(inFlight, { safety, requireAllStartPockets: true });
  const pocket = openNow.pockets.length ? openNow.pockets[0] : freeWithin([], anchorLane, radius);
  const options = candidatesKeepingPocket(pocket, anchorLane);
  for (let i = 0; i < options.length; i += 1) {
    const row = place(options[i]);
    row.tiles = row.span;
    row.segments = [{ start: row.start, span: row.span }];
    const outcome = feasible(row, attempts + i + 1);
    if (outcome.row) return { ...outcome, fallback: true };
    lastVerdict = outcome;
  }

  // last resort: one tile parked beyond the modelled band, which cannot trap a
  // ship holding its own lane
  const parked = place(tileRow(anchorLane + radius, 1));
  return {
    row: parked,
    attempts: attempts + options.length + 1,
    fallback: true,
    verdict: lastVerdict,
  };
}
