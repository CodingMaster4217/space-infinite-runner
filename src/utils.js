/** Tiny math / DOM helpers shared across the game modules. */

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

export const lerp = (a, b, t) => a + (b - a) * t;

/** Framerate independent exponential smoothing. */
export const damp = (current, target, lambda, dt) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt));

export const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Deterministic-ish 1D hash used for per-particle variation. */
export const hash1 = (n) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
};

export const randRange = (rand, min, max) => min + rand() * (max - min);

export const pick = (rand, arr) => arr[Math.floor(rand() * arr.length) % arr.length];

/** Mulberry32 – tiny seeded PRNG so runs can be reproduced when debugging. */
export function createRandom(seed = Date.now() >>> 0) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const now = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

export const formatInt = (n) => Math.round(n).toLocaleString('en-US');

export function safeStorage() {
  try {
    const probe = '__hd_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch (err) {
    const memory = new Map();
    return {
      getItem: (k) => (memory.has(k) ? memory.get(k) : null),
      setItem: (k, v) => memory.set(k, String(v)),
      removeItem: (k) => memory.delete(k),
    };
  }
}
