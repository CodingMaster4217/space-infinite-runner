/**
 * main.js — entry point.
 * Boots the Game, wires resize handling and exposes a small debug surface
 * (window.__HYPERDRIVE__) for tooling and manual probing from the console.
 */

import { Game, STATES } from './game.js';

const canvas = document.getElementById('game-canvas');
const boot = document.getElementById('boot');
const fatal = document.getElementById('fatal');
const fatalMsg = document.getElementById('fatal-msg');

function showFatal(message) {
  if (fatal) fatal.classList.remove('is-hidden');
  if (fatalMsg) fatalMsg.textContent = message;
  boot?.classList.add('is-done');
  // eslint-disable-next-line no-console
  console.error('[HYPERDRIVE]', message);
}

function supportsWebGL() {
  try {
    const probe = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext &&
        (probe.getContext('webgl2') || probe.getContext('webgl') || probe.getContext('experimental-webgl'))
    );
  } catch (err) {
    return false;
  }
}

function bootGame() {
  if (!supportsWebGL()) {
    showFatal('This browser or GPU does not expose WebGL, which HYPERDRIVE needs to render.');
    return;
  }

  let game;
  try {
    game = new Game({ canvas });
  } catch (err) {
    showFatal(`Failed to initialise the renderer: ${err && err.message ? err.message : err}`);
    return;
  }

  window.addEventListener('resize', () => game.resize());
  game.resize();
  game.start();
  game.ui.hideBoot();

  canvas?.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    game.pause();
    showFatal('The GPU context was lost. Reload the page to continue.');
  });

  window.addEventListener('error', (e) => {
    // surface unexpected runtime errors instead of failing silently
    // eslint-disable-next-line no-console
    console.warn('[HYPERDRIVE] runtime error:', e.message);
  });

  window.__HYPERDRIVE__ = {
    game,
    STATES,
    snapshot: () => game.snapshot(),
    start: () => game.startRun(),
    pause: () => game.pause(),
    resume: () => game.resume(),
    menu: () => game.toMenu(),
    kill: () => game._fatal(),
    debug: game.debug,
  };
}

bootGame();
