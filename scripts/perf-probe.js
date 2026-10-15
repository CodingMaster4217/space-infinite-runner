#!/usr/bin/env node
/**
 * Frame-time probe: measures real rAF pacing in the served page and then
 * re-measures with individual layers disabled, so the dominant cost is obvious.
 *
 *   node scripts/perf-probe.js [--port 3000] [--width 1440] [--height 900] [--frames 60]
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const depsDir = path.join(process.env.HOME || '', '.local/chromium-deps/usr/lib/x86_64-linux-gnu');
if (fs.existsSync(depsDir)) {
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? `${depsDir}:${process.env.LD_LIBRARY_PATH}`
    : depsDir;
}

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 3000;
const WIDTH = Number(args[args.indexOf('--width') + 1]) || 1440;
const HEIGHT = Number(args[args.indexOf('--height') + 1]) || 900;
const MOBILE = args.includes('--mobile');
const FRAMES = Number(args[args.indexOf('--frames') + 1]) || 60;

const measure = (page, frames = 60) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const times = [];
        let last = performance.now();
        const tick = (t) => {
          times.push(t - last);
          last = t;
          if (times.length < n) requestAnimationFrame(tick);
          else {
            const sorted = [...times].sort((a, b) => a - b);
            resolve({
              avg: times.reduce((x, y) => x + y, 0) / times.length,
              p50: sorted[Math.floor(sorted.length / 2)],
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    frames
  );

const row = (label, m) =>
  process.stdout.write(
    `  ${label.padEnd(38)} ${m.avg.toFixed(1).padStart(7)} ms avg   ${(1000 / m.avg).toFixed(1).padStart(5)} fps\n`
  );

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--no-sandbox',
    ],
  });
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: MOBILE ? 2 : 1,
    hasTouch: MOBILE,
    isMobile: MOBILE,
    userAgent: MOBILE
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : undefined,
  });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__HYPERDRIVE__));
  await page.click('#btn-start');
  await page.evaluate(() => window.__HYPERDRIVE__.debug.advance(6));
  await new Promise((r) => setTimeout(r, 500));

  const env = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    dpr: window.devicePixelRatio,
    narrow: window.matchMedia('(max-width: 560px)').matches,
    coarse: window.matchMedia('(hover: none) and (pointer: coarse)').matches,
    hudBackdrop: getComputedStyle(document.querySelector('.hud-card')).backdropFilter,
  }));
  process.stdout.write(
    `HYPERDRIVE frame probe @ ${WIDTH}x${HEIGHT}${MOBILE ? ' (mobile profile)' : ''} — software rasteriser, no GPU\n`
  );
  process.stdout.write(
    `  layout: innerWidth=${env.innerWidth} dpr=${env.dpr} narrowQuery=${env.narrow} ` +
      `coarseQuery=${env.coarse} hudBackdropFilter=${env.hudBackdrop}\n`
  );
  const baseline = await measure(page, FRAMES);
  row('baseline (full scene + HUD)', baseline);

  await page.addStyleTag({
    content: '.hud-card{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  });
  await new Promise((r) => setTimeout(r, 250));
  row('HUD cards: backdrop-filter off', await measure(page, FRAMES));

  await page.addStyleTag({ content: '.fx-layer{display:none !important;}' });
  await new Promise((r) => setTimeout(r, 250));
  row('full-screen FX overlays off', await measure(page, FRAMES));

  await page.addStyleTag({ content: '.hud{display:none !important;}' });
  await new Promise((r) => setTimeout(r, 250));
  row('all DOM overlays off', await measure(page, FRAMES));

  await page.evaluate(() => {
    window.__HYPERDRIVE__.game.environment.nebula.forEach((n) => {
      n.mesh.visible = false;
    });
  });
  await new Promise((r) => setTimeout(r, 250));
  row('+ nebula backdrop off', await measure(page, FRAMES));

  await page.evaluate(() => {
    const h = window.__HYPERDRIVE__.game.environment.horizon;
    if (h) h.group.visible = false;
  });
  await new Promise((r) => setTimeout(r, 250));
  row('+ celestial horizon off', await measure(page, FRAMES));

  await page.evaluate(() => {
    window.__HYPERDRIVE__.game.environment.floorMesh.visible = false;
  });
  await new Promise((r) => setTimeout(r, 250));
  row('+ endless ground plane off', await measure(page, FRAMES));

  await page.evaluate(() => {
    window.__HYPERDRIVE__.game.environment.pylonBars.visible = false;
    window.__HYPERDRIVE__.game.environment.pylons.visible = false;
  });
  await new Promise((r) => setTimeout(r, 250));
  row('+ pylons off', await measure(page, FRAMES));

  const half = await page.evaluate(() => {
    const g = window.__HYPERDRIVE__.game;
    g.quality.target = 0.5;
    g.quality.pixelRatio = 0.5;
    g._applyPixelRatio();
    return g.quality.pixelRatio;
  });
  await new Promise((r) => setTimeout(r, 250));
  row(`everything back on, pixelRatio ${half}`, await measure(page, FRAMES));

  await browser.close();
}

main().catch((err) => {
  process.stdout.write(`probe failed: ${err}\n`);
  process.exit(1);
});
