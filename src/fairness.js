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
import { fullWidthRow, gapLanesAt, pickWallRow } from './collision.js';
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
 * Lift a window-relative row onto the unbounded lane line.
 *
 * The window is `laneCount` lanes wide and centred on the ship's lane, so the
 * barrier always brackets the ship wherever it is flying.
 */
export function liftRow(lifted, windowBase, anchorLane, radius = LANES.reach) {
  const blocked = lifted.blocked.map((lane) => windowBase + lane);
  const segments = lifted.segments.map((s) => ({ start: windowBase + s.start, span: s.span }));
  const last = segments.length ? segments[segments.length - 1] : { start: windowBase, span: 1 };
  return {
    ...lifted,
    start: segments.length ? segments[0].start : windowBase,
    span: last.start + last.span - (segments.length ? segments[0].start : windowBase),
    blocked,
    segments,
    gap: (lifted.gap || []).map((lane) => windowBase + lane),
    free: freeWithin(blocked, anchorLane, radius),
  };
}

/** A full-width row whose gap sits at `gapStart` (absolute lanes). */
export function gapRow({
  gapStart,
  gapWidth,
  windowBase,
  laneCount,
  anchorLane,
  radius = LANES.reach,
}) {
  const local = fullWidthRow(gapStart - windowBase, gapWidth, laneCount);
  return liftRow(local, windowBase, anchorLane, radius);
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
 * Fallback gaps: keep the ship's own pocket open. Widening the gap to the whole
 * pocket means a ship already inside it survives without moving at all, which is
 * exactly the guarantee the spawner must never lose.
 */
export function pocketGapRows(pocket, anchorLane, { windowBase, laneCount, gapWidth, radius = LANES.reach }) {
  const sorted = [...pocket].sort((a, b) => a - b);
  const spans = new Set([gapWidth, 2, 3]);
  const anchors = new Set([anchorLane]);
  if (sorted.length) {
    anchors.add(sorted[0]);
    anchors.add(sorted[sorted.length - 1]);
    // the ship can be anywhere in its pocket, so keep the whole pocket open
    spans.add(Math.min(sorted.length, 3));
  }
  const rows = [];
  for (const span of spans) {
    if (span < 1) continue;
    for (const anchor of anchors) {
      if (sorted.length && !sorted.some((lane) => lane >= anchor - span + 1 && lane <= anchor + span - 1)) continue;
      rows.push(
        gapRow({
          gapStart: anchor - Math.min(span - 1, Math.floor(span / 2)),
          gapWidth: span,
          windowBase,
          laneCount,
          anchorLane,
          radius,
        })
      );
    }
  }
  return rows;
}

/**
 * Pick an obstacle row that is guaranteed dodgeable given everything already in
 * flight.
 *
 * The row spans the full play area around the ship (see `wallHalfLanes`) so it
 * cannot be escaped by holding a direction, and is validated with the shared
 * fairness model. If the difficulty-scaled patterns cannot be made safe, the
 * fallbacks keep the ship's own pocket open, which is dodgeable by definition.
 */
export function selectFairRow({
  rand,
  difficulty,
  inFlight = [],
  previousFree = null,
  warnDuration,
  solidDuration,
  /** lane the ship will be flying in when this row turns solid */
  anchorLane = 0,
  attempts = 14,
  safety = FAIRNESS.safety,
  laneCount = LANE_COUNT,
  gapWidth = null,
  /** absolute lane the gap should favour (a power-up the player should reach) */
  preferLane = null,
  radius = LANES.reach,
}) {
  const count = Math.max(3, Math.round(laneCount));
  const gap = clamp(Math.round(gapWidth ?? gapLanesAt(difficulty)), 1, count - 2);
  const windowBase = anchorLane - Math.floor(count / 2);
  const candidateArrival = warnDuration + solidDuration;
  const candidate = {
    materialiseIn: candidateArrival - solidDuration,
    arrivalIn: candidateArrival,
  };

  const windowPattern = (free) =>
    free ? free.map((lane) => lane - windowBase).filter((l) => l >= 0 && l < count) : null;
  const prefer = preferLane === null ? null : preferLane - windowBase;

  const feasible = (row, extraAttempts) => {
    const verdict = sequenceFeasible([...inFlight, { ...candidate, free: row.free }], {
      safety,
      requireAllStartPockets: true,
    });
    return verdict.feasible
      ? { row, attempts: extraAttempts, fallback: false, verdict }
      : verdict;
  };

  let lastVerdict = null;
  let pattern = previousFree;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const picked = pickWallRow(rand, difficulty, windowPattern(pattern), difficulty > 0.35, count, gap, prefer);
    const row = liftRow(picked, windowBase, anchorLane, radius);
    row.reach = picked.reach;
    const outcome = feasible(row, attempt + 1);
    if (outcome.row) return outcome;
    lastVerdict = outcome;
    pattern = row.free;
  }

  const openNow = sequenceFeasible(inFlight, { safety, requireAllStartPockets: true });
  const pocket = openNow.pockets.length ? openNow.pockets[0] : freeWithin([], anchorLane, radius);
  const options = pocketGapRows(pocket, anchorLane, { windowBase, laneCount: count, gapWidth: gap, radius });
  for (let i = 0; i < options.length; i += 1) {
    const outcome = feasible(options[i], attempts + i + 1);
    if (outcome.row) return { ...outcome, fallback: true };
    lastVerdict = outcome;
  }

  // extreme fallback: the barrier covers everything except the lane the ship is
  // holding, so a ship that keeps its heading always survives this row
  const held = gapRow({
    gapStart: anchorLane - Math.min(gap - 1, Math.floor(gap / 2)),
    gapWidth: gap,
    windowBase,
    laneCount: count,
    anchorLane,
    radius,
  });
  return {
    row: held,
    attempts: attempts + options.length + 1,
    fallback: true,
    verdict: lastVerdict,
  };
}
