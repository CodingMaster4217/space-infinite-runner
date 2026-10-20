#!/usr/bin/env node
/**
 * End-to-end verification of HYPERDRIVE in a real browser, against the served
 * page (http://127.0.0.1:3000). Verifies module loading, WebGL rendering, HUD,
 * steering, warning indicators, power-ups, collisions, pause/restart flow,
 * responsive layout and frame pacing.
 *
 * Game time is advanced deterministically through the debug stepping API so the
 * assertions do not depend on how fast this machine can rasterise in software.
 *
 *   node scripts/e2e.js [--headed] [--port 3000] [--shots]
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Headless Chromium on a bare container needs a handful of shared libraries.
// scripts/setup-browser-deps.sh drops them in $HOME/.local/chromium-deps; wire
// that directory up here so the browser can start without root access.
const depsDir = path.join(process.env.HOME || '', '.local/chromium-deps/usr/lib/x86_64-linux-gnu');
if (fs.existsSync(depsDir)) {
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? `${depsDir}:${process.env.LD_LIBRARY_PATH}`
    : depsDir;
}

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 3000;
const SHOTS = args.includes('--shots');
const HEADED = args.includes('--headed');
const BASE = `http://127.0.0.1:${PORT}/`;
const SHOT_DIR = path.join(ROOT, 'artifacts');

const results = [];
const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
const failedRequests = [];

function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
  process.stdout.write(`${condition ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 10000, interval = 80, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(interval);
  }
}

const snap = (page) => page.evaluate(() => window.__HYPERDRIVE__.snapshot());
const advance = (page, seconds) =>
  page.evaluate((s) => window.__HYPERDRIVE__.debug.advance(s), seconds);
const debugCall = (page, fn, ...callArgs) =>
  page.evaluate(([name, a]) => window.__HYPERDRIVE__.debug[name](...a), [fn, callArgs]);

async function shoot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // let in-flight CSS transitions (modal entrance, flashes) settle first — this
  // box renders at a few frames per second, so an immediate grab catches them
  await sleep(900);
  await page.screenshot({ path: path.join(SHOT_DIR, name) });
}

/** Make sure a phase starts from live gameplay so failures do not cascade. */
async function recover(page) {
  const state = (await snap(page)).state;
  if (state === 'over') {
    await page.click('#btn-restart');
    await advance(page, 0.2);
  } else if (state === 'paused') {
    await page.keyboard.press('KeyP');
    await advance(page, 0.1);
  } else if (state === 'menu') {
    await page.click('#btn-start');
    await advance(page, 0.1);
  }
  if (state !== 'playing') await debugCall(page, 'setSpawning', false);
  return (await snap(page)).state;
}

async function main() {
  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--no-sandbox',
    ],
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
    else if (msg.type() === 'warning') consoleWarnings.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('requestfailed', (req) => failedRequests.push(`${req.url()} :: ${req.failure()?.errorText}`));

  /* ================= load / boot ================= */
  const response = await page.goto(BASE, { waitUntil: 'load', timeout: 30000 });
  check('index.html served with 200', response?.status() === 200, `status ${response?.status()}`);
  check('assets resolve (no failed requests)',
    failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '));

  const fatalVisible = await page.evaluate(() => {
    const node = document.getElementById('fatal');
    return Boolean(node && !node.classList.contains('is-hidden'));
  });
  check('WebGL context created (no fatal overlay)', !fatalVisible);

  await waitFor(() => page.evaluate(() => Boolean(window.__HYPERDRIVE__)), { label: 'bootstrap' });
  check('game bootstrapped', true);
  // Deterministic time: the render loop keeps drawing, but game time is only
  // advanced by the explicit debug.advance() calls below. This is required on a
  // GPU-less box where software rasterisation runs at a few frames per second.
  await debugCall(page, 'freeze');
  check('deterministic stepping hook available', true);
  check('no uncaught errors during boot', pageErrors.length === 0, pageErrors.join(' | '));

  await sleep(600);
  let s = await snap(page);
  check('boots into the start menu', s.state === 'menu', `state=${s.state}`);
  check('renderer draws scene geometry', s.renderer.drawCalls > 0 && s.renderer.triangles > 0,
    `calls=${s.renderer.drawCalls} tris=${s.renderer.triangles}`);
  check('canvas fills the viewport', s.canvas.cssWidth === s.viewport.width && s.canvas.cssHeight === s.viewport.height,
    `${s.canvas.cssWidth}x${s.canvas.cssHeight}`);
  check('start modal is shown', await page.isVisible('#modal-start'));
  const hudHiddenInMenu = await page.evaluate(() => document.getElementById('hud').classList.contains('is-hidden'));
  check('HUD is hidden behind the menu', hudHiddenInMenu);
  check('menu shows the best-distance readout',
    /best distance/i.test(await page.textContent('#start-best')));
  await shoot(page, '01-menu.png');

  /* ================= launch ================= */
  await page.click('#btn-start');
  await advance(page, 0.1);
  s = await snap(page);
  check('start button launches a run', s.state === 'playing', `state=${s.state}`);
  check('HUD becomes visible in gameplay', await page.isVisible('#hud'));
  check('start modal dismissed', !(await page.isVisible('#modal-start')));

  await advance(page, 3);
  const early = await snap(page);
  check('distance accumulates while flying', early.distance > 100, `${early.distance} m`);
  check('speed exceeds the base cruise speed', early.speedKmh > 966, `${early.speedKmh} km/h`);
  check('HUD score mirrors internal distance',
    (await page.textContent('#hud-score')).replace(/,/g, '') === String(early.distance));
  check('HUD speed mirrors internal speed',
    (await page.textContent('#hud-speed')).replace(/,/g, '') === String(early.speedKmh));
  check('obstacle rows are spawning', early.warnings >= 1, `${early.warnings} warnings`);
  check('walls exist in the corridor', early.walls > 0, `${early.walls} active rows`);
  check('pre-wall warnings precede the materialised wall', early.warningActive || early.solidAhead,
    `warningActive=${early.warningActive} solidAhead=${early.solidAhead}`);
  check('renderer stays alive under load', early.renderer.drawCalls > 10, `calls=${early.renderer.drawCalls}`);
  await shoot(page, '02-gameplay.png');

  // Clusters carry a warning window, so the cadence is measured rather than
  // assumed. Flying straight is now punished by the very first row, so the pilot
  // is kept alive with a shield (topped up whenever the last one has been spent):
  // arrivals are still counted from the engine's own warning counter, so the
  // pilot's survival never distorts the measurement.
  let cadenceRows = 0;
  let cadenceSeconds = 0;
  for (let i = 0; i < 40; i += 1) {
    if (cadenceRows >= 6) break;
    let before = await snap(page);
    if (before.state !== 'playing') {
      // a death restarts the run: its dead time is skipped, not counted
      if ((await recover(page)) !== 'playing') break;
      // recover() stops the spawner so a phase can own the field; the cadence
      // measurement needs the real spawner running
      await debugCall(page, 'setSpawning', true);
      before = await snap(page);
    }
    if (before.shieldCharges === 0 && before.invuln <= 0) await debugCall(page, 'setShield');
    await advance(page, 0.5);
    const after = await snap(page);
    cadenceRows += Math.max(0, after.warnings - before.warnings);
    cadenceSeconds += 0.5;
  }
  const rowsPerSecond = cadenceRows / Math.max(0.5, cadenceSeconds);
  check('clusters keep arriving at a human-readable rhythm (0.3–1.6 per second)',
    rowsPerSecond > 0.3 && rowsPerSecond < 1.6,
    `${rowsPerSecond.toFixed(2)} rows/s (${cadenceRows} in ${cadenceSeconds.toFixed(1)}s)`);
  // The live spawner draws its spacing per row: the distance consumed between
  // arrivals is the proof that the cadence is not a fixed interval.
  const spacing = await debugCall(page, 'spawnDistances');
  const spacingSpread = spacing.length ? Math.max(...spacing) / Math.min(...spacing) : 0;
  check('row spacing is drawn per row, not run on a fixed interval',
    spacing.length >= 4 && new Set(spacing).size >= 3 && spacingSpread > 1.3,
    spacing.length
      ? `${spacing.length} draws, ${Math.min(...spacing)}–${Math.max(...spacing)} world units ` +
        `(${spacingSpread.toFixed(2)}× spread)`
      : 'no spacing samples recorded');
  const afterCadence = await snap(page);
  process.stdout.write(
    `  note: shielded straight flight survived ${cadenceSeconds.toFixed(1)}s of barriers ` +
    `(state=${afterCadence.state}, ${cadenceRows} barriers crossed)\n`
  );

  /* ================= audio synthesis ================= */
  const audioReport = await page.evaluate(() => {
    const audio = window.__HYPERDRIVE__.game.audio;
    audio.init();
    const results = {};
    const probes = ['swoosh', 'chime', 'alarm', 'crash', 'boost', 'brake', 'shieldBreak', 'launch', 'click'];
    for (const name of probes) {
      try {
        audio[name](name === 'chime' ? 'boost' : 0);
        results[name] = 'ok';
      } catch (err) {
        results[name] = `threw: ${err.message}`;
      }
    }
    return {
      ready: audio.ready,
      state: audio.ctx ? audio.ctx.state : 'no-context',
      sampleRate: audio.ctx ? audio.ctx.sampleRate : 0,
      noiseSamples: audio.noiseBuffer ? audio.noiseBuffer.length : 0,
      engineNodes: Boolean(audio._nodes && audio._nodes.engine),
      results,
    };
  });
  check('audio engine builds a real Web Audio graph',
    audioReport.ready && audioReport.sampleRate > 0 && audioReport.engineNodes,
    `state=${audioReport.state} rate=${audioReport.sampleRate}Hz`);
  check('all synthesised SFX run without throwing',
    Object.values(audioReport.results).every((v) => v === 'ok'),
    JSON.stringify(audioReport.results));
  check('sounds are generated in code (no audio files requested)',
    audioReport.noiseSamples > 0 && failedRequests.every((u) => !/\.(mp3|ogg|wav|m4a|aac)/i.test(u)),
    `${audioReport.noiseSamples} noise samples buffered`);

  /* ================= scripted phases (random spawner disabled) ================= */
  await debugCall(page, 'setSpawning', false);

  /* ================= warning indicator + dodge ================= */
  check('phase starts alive', (await recover(page)) === 'playing');
  await debugCall(page, 'clearField');
  await debugCall(page, 'setShipX', 0);
  await advance(page, 0.2);
  // absolute lanes: the ship sits in lane 0, so block its lane and both flanks
  await debugCall(page, 'spawnWall', [-1, 0, 1]);

  let warningSeen = null;
  let solidWhileAhead = false;
  let warningLanes = null;
  for (let i = 0; i < 8; i += 1) {
    await advance(page, 0.03);
    const step = await snap(page);
    if (step.warningActive) {
      warningSeen = warningSeen || step;
      warningLanes = await page.textContent('#hud-alert');
      if (!SHOTS) break;
      break;
    }
  }
  await shoot(page, '03-warning.png');
  check('warning indicator pulses on the blocked lane path before impact', Boolean(warningSeen),
    warningSeen ? `progress=${warningSeen.warningProgress}` : 'never activated');
  check('warning names the threatened lanes', /lane/i.test(warningLanes || ''),
    (warningLanes || '').trim());
  check('warning progress sweeps 0 → 1 during the dodge window',
    Boolean(warningSeen) && warningSeen.warningProgress >= 0 && warningSeen.warningProgress < 1,
    warningSeen ? `p=${warningSeen.warningProgress}` : '');

  // dodge out of the warned lanes and confirm the materialised wall is cleared
  await page.keyboard.down('ArrowRight');
  let cleared = false;
  for (let i = 0; i < 30; i += 1) {
    await advance(page, 0.05);
    const step = await snap(page);
    if (step.solidAhead) solidWhileAhead = true;
    if (solidWhileAhead && step.walls === 0) {
      cleared = true;
      break;
    }
  }
  await page.keyboard.up('ArrowRight');
  const dodged = await snap(page);
  check('wall materialises while still ahead of the ship (reaction time exists)', solidWhileAhead);
  check('dodging laterally into a free corridor clears the wall',
    cleared && dodged.state === 'playing' && dodged.shipX > 8.5,
    `cleared=${cleared} state=${dodged.state} x=${dodged.shipX} (wall edge 7.2 + hull 0.82)`);

  /* ================= wall clusters (phase 5) ================= */
  check('phase starts alive before the barrier phase', (await recover(page)) === 'playing');
  await debugCall(page, 'setSpawning', false);

  const spawned = [];
  for (let i = 0; i < 24; i += 1) {
    await debugCall(page, 'clearField');
    await debugCall(page, 'setShipX', i % 2 === 0 ? 0 : 26 + i * 7);
    await advance(page, 0.12);
    const row = await debugCall(page, 'spawnProceduralRow');
    if (row) spawned.push(row);
  }
  const tileCap = spawned[0].maxTiles;
  const oversize = spawned.filter((r) => r.laneSpan > tileCap || r.blockedLanes.length > tileCap);
  const contiguous = spawned.filter((r) =>
    r.segments.length === 1 &&
    r.segments[0].span === r.laneSpan &&
    r.blockedLanes.every((lane, i) => lane === r.blockedLanes[0] + i));
  const wide = spawned.filter((r) => r.width > tileCap * 4.8);
  const boxPerTile = spawned.filter(
    (r) => r.boxes.length === r.laneSpan && r.boxes.every((b) => b.laneSpan === 1));
  const blockedShipLane = spawned.filter((r) => r.blockedLanes.includes(r.anchorLane)).length;
  const nearMiss = spawned.filter((r) => !r.blockedLanes.includes(r.anchorLane));
  const nearestMiss = nearMiss.filter(
    (r) => r.laneStart === r.anchorLane + 1 || r.laneStart + r.laneSpan - 1 === r.anchorLane - 1
  ).length;
  const farFromAxis = spawned.filter((r) => Math.abs(r.anchorLane) > 5);
  const trailsShip = farFromAxis.filter((r) =>
    r.blockedLanes.every((lane) => Math.abs(lane - r.anchorLane) <= tileCap));
  const widths = new Set(spawned.map((r) => r.laneSpan));
  const widest = spawned.reduce((best, r) => (r.laneSpan > best.laneSpan ? r : best), spawned[0]);

  check('every row is built from at most five wall tiles side by side',
    spawned.length === 24 && tileCap === 5 && oversize.length === 0,
    `${oversize.length} oversize rows, widest ${widest.laneSpan} of ${tileCap}`);
  check('the tiles stand in one contiguous run, never scattered',
    contiguous.length === spawned.length,
    `${contiguous.length}/${spawned.length} contiguous`);
  check('a row is only a few lanes wide (~24 world units at most)',
    wide.length === 0 && widest.width <= tileCap * 4.8,
    `widest ${widest.width.toFixed(1)} world units (${widest.laneSpan} lanes)`);
  check('collision boxes are one per tile, so the space beside a row is open',
    boxPerTile.length === spawned.length,
    `${boxPerTile.length}/${spawned.length} rows boxed per tile`);
  check('the spawner regularly drops a cluster on the ship\'s lane',
    blockedShipLane >= 12,
    `${blockedShipLane}/${spawned.length} rows block the anchor lane`);
  check('near-miss rows slide past the ship instead of blocking it',
    nearMiss.length > 0 && nearestMiss >= Math.ceil(nearMiss.length / 2),
    `${nearMiss.length} near misses, ${nearestMiss} exactly one lane clear`);
  check('cluster width really varies from row to row',
    widths.size >= 2, `widths ${[...widths].sort((a, b) => a - b).join(', ')} tiles`);
  check('clusters follow the ship off the world axis',
    farFromAxis.length >= 8 && trailsShip.length === farFromAxis.length,
    `${farFromAxis.length} rows spawned past lane 5, all within ${tileCap} lanes of the ship`);

  /* --- the barrier is anchored on the lane the ship is *predicted* to hold --- */
  await debugCall(page, 'clearField');
  await debugCall(page, 'setShipX', 0);
  await advance(page, 0.1);
  await page.keyboard.down('ArrowLeft');
  await advance(page, 0.6);
  const strafing = await snap(page);
  const predicted = await debugCall(page, 'spawnProceduralRow');
  await page.keyboard.up('ArrowLeft');
  const strafeLane = Math.round(strafing.shipX / 4.8);
  check('a barrier spawned mid-strafe is anchored where the ship is going, not where it is',
    predicted && predicted.anchorLane < strafeLane - 1,
    `ship lane ${strafeLane} → barrier anchored lane ${predicted && predicted.anchorLane}`);

  /* --- warning colour ramp: light red → dark red, then the pop ---------- */
  check('phase starts alive before the warning-colour phase', (await recover(page)) === 'playing');
  await debugCall(page, 'clearField');
  await debugCall(page, 'setShipX', 0);
  const ramp = await debugCall(page, 'warningRamp', 10);
  const rampSum = (s) => s.rgb[0] + s.rgb[1] + s.rgb[2];
  check('the warning ramp starts light red (#ff8888)', ramp[0].hex === '#ff8888', ramp[0].hex);
  check('the warning ramp passes through dark red (#880000)',
    ramp.some((s) => s.hex === '#880000'), ramp.map((s) => s.hex).join(' '));
  check('the warning ramp ends deepest red (#440000)',
    ramp[ramp.length - 1].hex === '#440000', ramp[ramp.length - 1].hex);
  check('the warning only ever darkens as it counts down',
    ramp.every((s, i) => i === 0 || rampSum(s) < rampSum(ramp[i - 1])));

  // a live barrier, clear of the ship, watched from warning to solid
  await debugCall(page, 'spawnWall', [-7, -6, -5, -4, -3]);
  const tones = [];
  let popSeen = null;
  for (let i = 0; i < 40; i += 1) {
    await advance(page, 0.02);
    const state = await debugCall(page, 'warningState');
    if (state.length) tones.push(state[0]);
    if (!popSeen) {
      const boxes = await debugCall(page, 'wallBoxes');
      const solid = boxes.find((b) => b.phase === 'solid');
      if (solid) popSeen = solid;
    }
  }
  const firstTone = tones[0];
  const lastTone = tones[tones.length - 1];
  const toneSum = (t) => t.rgb[0] + t.rgb[1] + t.rgb[2];
  check('the live indicator sweeps light red → dark red',
    tones.length > 4 && toneSum(firstTone) > toneSum(lastTone) && firstTone.rgb[0] > lastTone.rgb[0],
    `${firstTone && firstTone.rgb.map((v) => v.toFixed(2)).join('/')} → ${lastTone && lastTone.rgb.map((v) => v.toFixed(2)).join('/')}`);
  check('one warning indicator marks the whole row, tile for tile',
    tones.every((t) => t.visible === 1 && t.tiles === t.slots[0].span) && firstTone.tiles >= 1,
    `${firstTone.tiles} tile(s) lit by ${firstTone.visible} indicator`);
  check('the indicator laser is tinted by the same ramp',
    tones.some((t) => /^[89a-f]/.test(t.laser)), `laser ${lastTone.laser}`);
  check('the warning length is set from the current speed',
    firstTone.stripLength > 0 && firstTone.stripLength <= 74,
    `${firstTone.stripLength} world units`);
  check('the barrier pops when it solidifies',
    Boolean(popSeen) && popSeen.popT > 0 && popSeen.slabScaleZ > 1,
    popSeen ? `pop ${popSeen.popT}s, slab depth ×${popSeen.slabScaleZ}` : 'never solidified');

  /* --- speed-scaled warning distance ---------------------------------- */
  const slowTune = await debugCall(page, 'wallTuning', 46, 0.5);
  const fastTune = await debugCall(page, 'wallTuning', 205, 0.5);
  check('the warning lookahead grows with speed',
    fastTune.lookahead > slowTune.lookahead && fastTune.spawnZ < slowTune.spawnZ,
    `${slowTune.lookahead} → ${fastTune.lookahead} world units ahead ` +
      `(spawn z ${slowTune.spawnZ} → ${fastTune.spawnZ})`);
  check('the warning window stretches back out at speed',
    fastTune.warnDuration > slowTune.warnDuration,
    `${slowTune.warnDuration}s → ${fastTune.warnDuration}s`);
  check('the floor warning strip lengthens with speed',
    fastTune.stripLength > slowTune.stripLength,
    `${slowTune.stripLength} → ${fastTune.stripLength} world units`);
  check('a row is capped at five tiles at any speed and difficulty',
    slowTune.maxTiles === 5 && fastTune.maxTiles === 5 &&
      slowTune.tiles.every((n) => n >= 1 && n <= 5) &&
      fastTune.tiles.every((n) => n >= 1 && n <= 5) &&
      fastTune.maxWidth === 5 * 4.8,
    `cap ${fastTune.maxTiles} tiles (${fastTune.maxWidth} world units), ` +
      `draws ${slowTune.tiles.join('–')} early → ${fastTune.tiles.join('–')} late`);
  check('the drawn row spacing tightens in seconds as difficulty climbs',
    fastTune.rowDistance / 205 < (slowTune.rowDistance / 46) * 0.6 &&
      fastTune.burstDistance < fastTune.breatherDistance * 0.5,
    `${(slowTune.rowDistance / 46).toFixed(2)}s apart at cruise → ` +
      `${(fastTune.rowDistance / 205).toFixed(2)}s at full speed ` +
      `(burst ${fastTune.burstDistance} vs breather ${fastTune.breatherDistance} units)`);

  // a real procedural barrier, caught mid-warning
  await debugCall(page, 'clearField');
  await debugCall(page, 'setShipX', 0);
  const shotRow = await debugCall(page, 'spawnProceduralRow');
  await advance(page, 0.5);
  check('a procedural barrier is on screen for the capture', Boolean(shotRow));
  await shoot(page, '09-barrier.png');

  /* ================= perimeter probe: hold a direction ================= */
  check('phase starts alive before the perimeter probe', (await recover(page)) === 'playing');
  await debugCall(page, 'clearField');
  await debugCall(page, 'setShipX', 0);
  await debugCall(page, 'setSpawning', true);
  await page.keyboard.down('ArrowLeft');
  let held = 0;
  for (let i = 0; i < 60; i += 1) {
    await advance(page, 0.5);
    held += 0.5;
    if ((await snap(page)).state === 'over') break;
  }
  await page.keyboard.up('ArrowLeft');
  const probe = await snap(page);
  check('holding one direction for ever is punished by the barriers',
    probe.state === 'over',
    `state=${probe.state} after ${held.toFixed(1)}s of holding left, ship x=${probe.shipX}`);
  await shoot(page, '10-wall-impact.png');

  await debugCall(page, 'setSpawning', false);
  check('phase restarts after the perimeter probe', (await recover(page)) === 'playing');
  await debugCall(page, 'clearField');
  await debugCall(page, 'setShipX', 0);
  await debugCall(page, 'setSpawning', true);
  let idle = 0;
  for (let i = 0; i < 40; i += 1) {
    await advance(page, 0.5);
    idle += 0.5;
    if ((await snap(page)).state === 'over') break;
  }
  const idleProbe = await snap(page);
  check('never steering at all is punished too', idleProbe.state === 'over',
    `state=${idleProbe.state} after ${idle.toFixed(1)}s without steering`);
  await debugCall(page, 'setSpawning', false);

  /* ================= celestial horizon ================= */
  check('phase starts alive before the horizon phase', (await recover(page)) === 'playing');
  await debugCall(page, 'clearField');
  await debugCall(page, 'setShipX', 0);
  await advance(page, 0.4);
  const horizonA = await debugCall(page, 'horizon');
  const shipNdc = (await snap(page)).screen;
  check('a celestial core sits on the flight axis at the horizon',
    Boolean(horizonA) && Math.abs(horizonA.ndc.x) < 0.05,
    horizonA ? `ndc x=${horizonA.ndc.x}` : 'no horizon body');
  check('the core sits above the flight path (lane warnings stay readable)',
    horizonA.ndc.y > 0.15 && Math.abs(shipNdc.y - horizonA.ndc.y) > 0.3,
    `core ndc y=${horizonA.ndc.y}, ship ndc y=${shipNdc.y}`);
  check('the horizon is drawn behind the gameplay layer',
    horizonA.renderOrder < 0 && horizonA.opacity > 0.1,
    `renderOrder=${horizonA.renderOrder} opacity=${horizonA.opacity}`);
  check('light rays converge on the core', horizonA.rays === true && horizonA.worldX !== undefined);
  await debugCall(page, 'setShipX', -260);
  await advance(page, 0.5);
  const horizonB = await debugCall(page, 'horizon');
  check('the horizon stays locked to the vanishing point however far the ship strafes',
    Math.abs(horizonB.ndc.x) < 0.05 && Math.abs(horizonB.ndc.y - horizonA.ndc.y) < 0.03,
    `ndc (${horizonA.ndc.x}, ${horizonA.ndc.y}) → (${horizonB.ndc.x}, ${horizonB.ndc.y}) at ship x=${(await snap(page)).shipX}`);
  await shoot(page, '11-horizon.png');
  await debugCall(page, 'clearField');
  await debugCall(page, 'setShipX', 0);

  /* ================= steering ================= */
  check('phase starts alive after the dodge', (await recover(page)) === 'playing');
  await debugCall(page, 'clearField');
  await debugCall(page, 'setShipX', 0);
  await advance(page, 0.2);
  const start = await snap(page);
  await page.keyboard.down('ArrowLeft');
  await advance(page, 0.35);
  const midLeft = await snap(page);
  await advance(page, 0.9);
  const farLeft = await snap(page);

  check('holding left steers the ship left', farLeft.shipX < start.shipX - 3,
    `x ${start.shipX} → ${farLeft.shipX}`);
  check('ship banks into the left turn', midLeft.shipRoll > 0.15, `roll=${midLeft.shipRoll}`);
  check('turning is smooth, not lane-snapped',
    Math.abs(midLeft.shipX) > 0.05 && ![0, 4.8, 9.6].some((l) => Math.abs(Math.abs(midLeft.shipX) - l) < 0.05),
    `x=${midLeft.shipX} at 0.35s`);

  // keep the key down: with no lateral border the ship should just keep going
  await advance(page, 2.2);
  const deepLeft = await snap(page);
  await page.keyboard.up('ArrowLeft');
  await shoot(page, '08-far-left.png');
  check('no lateral border — the ship flies far past the old corridor edge',
    deepLeft.shipX < -40, `x=${deepLeft.shipX} (the old edge was -10.9)`);
  check('lane index keeps counting into unbounded territory',
    deepLeft.shipLane === Math.round(deepLeft.shipX / 4.8),
    `lane ${deepLeft.shipLane} at x=${deepLeft.shipX}`);
  const followError = Math.max(
    Math.abs(deepLeft.worldFollow.floorX - deepLeft.worldFollow.cameraX),
    Math.abs(deepLeft.worldFollow.starX - deepLeft.worldFollow.cameraX),
    Math.abs(deepLeft.worldFollow.backdropX - deepLeft.worldFollow.cameraX)
  );
  check('ground plane, starfield and backdrop follow the camera (endless world)',
    followError < 0.01, `max follow error ${followError.toFixed(4)} world units`);
  // drift is capped at half the visible half-width; the excess is the damped
  // follow lag that builds up while the ship is accelerating sideways
  check('the ship stays framed however far it flies',
    deepLeft.screen.onScreen && Math.abs(deepLeft.screen.x) < 0.8,
    `camera lag ${deepLeft.shipCameraOffset} u, ndc x=${deepLeft.screen.x}`);


  await advance(page, 0.6);
  const coast = await snap(page);
  check('releasing the key lets the ship coast (no snap)', coast.shipX <= deepLeft.shipX + 0.5,
    `x=${coast.shipX}`);

  await page.keyboard.down('ArrowRight');
  await advance(page, 0.6);
  const right = await snap(page);
  await page.keyboard.up('ArrowRight');
  check('right steer reverses direction', right.shipX > coast.shipX + 2, `x=${right.shipX}`);
  check('ship banks into the right turn', right.shipRoll < -0.15, `roll=${right.shipRoll}`);
  await advance(page, 0.5);

  /* ================= power-ups ================= */
  await recover(page);
  await debugCall(page, 'clearField');
  await advance(page, 0.2);
  const preBoost = await snap(page);
  await debugCall(page, 'grant', 'boost');
  await advance(page, 0.2);
  const boosted = await snap(page);
  check('speed-boost orb grants a warp burst',
    boosted.boost > 0 && boosted.boost > preBoost.boost, `boost=${boosted.boost}s`);
  check('speed-boost orb grants temporary invincibility', boosted.invuln > 0, `invuln=${boosted.invuln}s`);
  check('power-up counter increments', boosted.powerups === preBoost.powerups + 1,
    `${preBoost.powerups} → ${boosted.powerups}`);
  check('HUD lists the active power-up', /boost/i.test(await page.textContent('#hud-powerups')),
    (await page.textContent('#hud-powerups')).trim());
  await advance(page, 1.2);
  const boosting = await snap(page);
  check('boost accelerates the ship beyond cruise', boosting.speedKmh > boosted.speedKmh + 200,
    `${boosted.speedKmh} → ${boosting.speedKmh} km/h`);
  await shoot(page, '04-boost.png');

  const beforePlough = await snap(page);
  await debugCall(page, 'placeWallAtShip', 0);
  await advance(page, 0.2);
  const ploughed = await snap(page);
  check('invincible ship shatters walls instead of dying',
    ploughed.state === 'playing' && ploughed.wallsDestroyed >= 1,
    `state=${ploughed.state} destroyed=${ploughed.wallsDestroyed}`);
  check('shattering a wall awards bonus distance', ploughed.distance > beforePlough.distance + 20,
    `+${ploughed.distance - beforePlough.distance} m`);

  // wait out the boost, then measure the warp brake
  await recover(page);
  await debugCall(page, 'clearField');
  await advance(page, 6);
  const preBrake = await snap(page);
  await advance(page, 1);
  const cruiseDistance = (await snap(page)).distance - preBrake.distance;
  await debugCall(page, 'grant', 'brake');
  await advance(page, 0.2);
  const braked = await snap(page);
  check('warp-brake orb starts time dilation', braked.brake > 0, `brake=${braked.brake}s`);
  const brakeStart = await snap(page);
  await advance(page, 1);
  const brakeDistance = (await snap(page)).distance - brakeStart.distance;
  check('time dilation slows the world noticeably',
    brakeDistance < cruiseDistance * 0.65,
    `${brakeDistance.toFixed(0)} m/s dilated vs ${cruiseDistance.toFixed(0)} m/s normal`);
  await advance(page, 5.5);
  check('dilation expires', (await snap(page)).brake === 0);

  await recover(page);
  await debugCall(page, 'clearField');
  await debugCall(page, 'setShipX', 0);
  await debugCall(page, 'grant', 'shield');
  await advance(page, 0.2);
  const shielded = await snap(page);
  check('shield core equips a single-use charge', shielded.shieldCharges === 1,
    `charges=${shielded.shieldCharges}`);
  check('HUD lists the shield', /shield/i.test(await page.textContent('#hud-powerups')));

  await debugCall(page, 'placeWallAtShip', 0);
  await advance(page, 0.2);
  const absorbed = await snap(page);
  check('shield absorbs exactly one impact and the run continues',
    absorbed.state === 'playing' && absorbed.shieldsUsed === 1 && absorbed.shieldCharges === 0,
    `state=${absorbed.state} used=${absorbed.shieldsUsed} charges=${absorbed.shieldCharges}`);
  check('absorbing a hit grants a short post-hit grace period', absorbed.invuln > 0,
    `${absorbed.invuln}s invulnerable`);
  await shoot(page, '05-shield-break.png');
  await advance(page, 2);
  check('grace period expires back to vulnerable', (await snap(page)).invuln === 0);

  /* ================= pause + freeze ================= */
  check('phase starts alive before pausing', (await recover(page)) === 'playing');
  await page.click('#btn-pause');
  await sleep(120);
  const paused = await snap(page);
  check('pause button enters the paused state', paused.state === 'paused', `state=${paused.state}`);
  check('pause modal shows run stats', await page.isVisible('#modal-pause'));
  check('pause stats list distance + top speed',
    /distance/i.test(await page.textContent('#pause-stats')) &&
      /top speed/i.test(await page.textContent('#pause-stats')));
  await advance(page, 1);
  const stillPaused = await snap(page);
  check('gameplay is frozen while paused', stillPaused.distance === paused.distance,
    `${paused.distance} → ${stillPaused.distance} m`);
  await page.click('#btn-resume');
  await advance(page, 0.2);
  check('resume returns to gameplay', (await snap(page)).state === 'playing');
  await advance(page, 0.5);
  check('distance advances again after resume',
    (await snap(page)).distance > stillPaused.distance, `+${(await snap(page)).distance - stillPaused.distance} m`);
  await page.keyboard.press('KeyP');
  await sleep(120);
  check('keyboard shortcut pauses too', (await snap(page)).state === 'paused');
  await page.keyboard.press('KeyP');
  await advance(page, 0.2);
  check('keyboard shortcut resumes', (await snap(page)).state === 'playing');

  /* ================= fatal impact + game over ================= */
  check('phase starts alive before the fatal impact', (await recover(page)) === 'playing');
  await debugCall(page, 'clearField');
  await debugCall(page, 'setShipX', 0);
  await advance(page, 0.2);
  const beforeDeath = await snap(page);
  check('the ship is unprotected before the fatal impact',
    beforeDeath.shieldCharges === 0 && beforeDeath.invuln === 0,
    `charges=${beforeDeath.shieldCharges} invuln=${beforeDeath.invuln}`);
  await page.evaluate(() => { window.__noReloadMarker = 'alive'; });
  await debugCall(page, 'placeWallAtShip', 0);
  await advance(page, 0.3);
  const dead = await snap(page);
  check('an unprotected wall impact ends the run', dead.state === 'over', `state=${dead.state}`);
  check('the already-spent shield does not absorb a second hit', dead.shieldsUsed === 1,
    `shieldsUsed=${dead.shieldsUsed}`);
  check('game-over modal is displayed', await page.isVisible('#modal-over'));
  const overScore = Number((await page.textContent('#over-score')).replace(/,/g, ''));
  check('game over reports the final distance', overScore === dead.distance,
    `modal=${overScore} final=${dead.distance}`);
  const overStats = (await page.textContent('#over-stats')).replace(/\s+/g, ' ').trim();
  check('game over lists top speed, survival time, power-ups and shields',
    /top speed/i.test(overStats) && /survived/i.test(overStats) &&
      /power-ups/i.test(overStats) && /shields burned/i.test(overStats),
    overStats.slice(0, 110));
  check('the ship mesh is destroyed on impact', dead.shipVisible === false);
  check('camera shake / explosion particles were spawned', dead.particles > 40, `${dead.particles} particles`);
  await shoot(page, '06-gameover.png');

  /* ================= instant restart ================= */
  await page.click('#btn-restart');
  await advance(page, 0.2);
  const restarted = await snap(page);
  check('restart begins a fresh run', restarted.state === 'playing' && restarted.powerups === 0,
    `state=${restarted.state} powerups=${restarted.powerups}`);
  check('restart resets distance', restarted.distance < 300, `${restarted.distance} m`);
  check('restart restores the ship mesh', restarted.shipVisible === true);
  check('restart cleared power-up state', restarted.shieldCharges === 0 && restarted.boost === 0);
  const marker = await page.evaluate(() => window.__noReloadMarker);
  check('restart happened without a page reload', marker === 'alive', `marker=${marker}`);
  const noOldWalls = (await snap(page)).warnings === 0;
  check('restart clears the previous obstacle field', noOldWalls);
  await debugCall(page, 'setSpawning', true);
  await advance(page, 1.5);
  check('a restarted run spawns obstacles again', (await snap(page)).warnings > 0);

  /* ================= keyboard restart shortcut ================= */
  await page.keyboard.press('KeyR');
  await advance(page, 0.2);
  check('R restarts instantly', (await snap(page)).state === 'playing');

  /* ================= responsive layout ================= */
  const viewports = [
    { width: 390, height: 844, label: 'phone portrait 390×844' },
    { width: 844, height: 390, label: 'phone landscape 844×390' },
    { width: 768, height: 1024, label: 'tablet 768×1024' },
    { width: 1920, height: 1080, label: 'desktop 1920×1080' },
  ];
  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await sleep(400);
    const st = await snap(page);
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - window.innerWidth,
      y: document.documentElement.scrollHeight - window.innerHeight,
    }));
    check(`layout fits ${vp.label}`,
      st.canvas.cssWidth === vp.width && st.canvas.cssHeight === vp.height && overflow.x <= 1 && overflow.y <= 1,
      `canvas=${st.canvas.cssWidth}x${st.canvas.cssHeight} overflow=${overflow.x}x${overflow.y}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(400);
  check('touch steer buttons are exposed for mobile',
    (await page.isVisible('#btn-left')) && (await page.isVisible('#btn-right')));
  const tap = await page.evaluate(() => {
    const btn = document.getElementById('btn-right');
    const rect = btn.getBoundingClientRect();
    return { w: rect.width, h: rect.height };
  });
  check('touch targets are finger sized (>= 44px)', tap.w >= 44 && tap.h >= 44,
    `${Math.round(tap.w)}×${Math.round(tap.h)}px`);
  await page.dispatchEvent('#btn-right', 'pointerdown', { pointerId: 1, pointerType: 'touch' });
  await advance(page, 0.5);
  const tapped = await snap(page);
  await page.dispatchEvent('#btn-right', 'pointerup', { pointerId: 1, pointerType: 'touch' });
  check('on-screen button steers the ship', tapped.shipX > 1, `x=${tapped.shipX}`);
  await shoot(page, '07-mobile.png');
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(300);

  /* ================= performance ================= */
  const bench = await page.evaluate(() => window.__HYPERDRIVE__.debug.benchmark(300));
  check('logic step stays well inside the 16.7 ms frame budget', bench.stepMs < 4,
    `${bench.stepMs} ms/step`);
  check('draw call count stays modest', bench.drawCalls < 160, `${bench.drawCalls} draw calls`);
  check('triangle count stays modest', bench.triangles < 250000, `${bench.triangles} triangles`);

  const pacing = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const times = [];
        let last = performance.now();
        const tick = (t) => {
          times.push(t - last);
          last = t;
          if (times.length < 120) requestAnimationFrame(tick);
          else {
            const sorted = [...times].sort((a, b) => a - b);
            resolve({
              avg: times.reduce((x, y) => x + y, 0) / times.length,
              p95: sorted[Math.floor(sorted.length * 0.95)],
              worst: sorted[sorted.length - 1],
            });
          }
        };
        requestAnimationFrame(tick);
      })
  );
  const live = await snap(page);
  check('render loop never stalls (frames keep arriving)', pacing.avg > 0 && pacing.avg < 1000,
    `avg ${pacing.avg.toFixed(1)} ms (p95 ${pacing.p95.toFixed(1)} ms)`);
  check('resolution scaling stays within its designed bounds',
    live.pixelRatio >= 0.7 && live.pixelRatio <= 2, `pixelRatio=${live.pixelRatio}`);

  // Fill-rate probe: if the frame time collapses when the raster load shrinks,
  // the bottleneck here is this box's software rasteriser, not the game loop.
  await page.setViewportSize({ width: 480, height: 300 });
  await sleep(400);
  const smallPacing = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const times = [];
        let last = performance.now();
        const tick = (t) => {
          times.push(t - last);
          last = t;
          if (times.length < 90) requestAnimationFrame(tick);
          else resolve(times.reduce((x, y) => x + y, 0) / times.length);
        };
        requestAnimationFrame(tick);
      })
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(300);

  /* ================= console hygiene ================= */
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('no failed network requests', failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '));
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} browser checks passed.\n`);
  process.stdout.write(
    `software-rendered pacing @1440x900: avg ${pacing.avg.toFixed(2)} ms (${(1000 / pacing.avg).toFixed(1)} fps), ` +
      `p95 ${pacing.p95.toFixed(2)} ms, worst ${pacing.worst.toFixed(2)} ms\n`
  );
  process.stdout.write(
    `software-rendered pacing @480x300: avg ${smallPacing.toFixed(2)} ms (${(1000 / smallPacing).toFixed(1)} fps)\n`
  );
  process.stdout.write(
    `logic step: ${bench.stepMs} ms/step · render pass: ${bench.renderMs} ms @ ` +
      `${bench.viewport.width}x${bench.viewport.height} pixelRatio ${bench.pixelRatio} · ` +
      `${bench.drawCalls} draw calls · ${bench.triangles} triangles\n`
  );
  if (consoleWarnings.length) {
    process.stdout.write(`console warnings (${consoleWarnings.length}): ${consoleWarnings.slice(0, 4).join(' | ')}\n`);
  }
  if (failed.length) {
    process.stdout.write('\nFAILED CHECKS:\n');
    failed.forEach((f) => process.stdout.write(` - ${f.name}${f.detail ? ` (${f.detail})` : ''}\n`));
    process.exit(1);
  }
}

main().catch((err) => {
  process.stdout.write(`\nE2E RUN ABORTED: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});
