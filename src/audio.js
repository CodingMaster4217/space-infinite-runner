/**
 * AudioEngine — every sound effect in the game is synthesised at runtime with
 * the Web Audio API. No external audio files are loaded.
 */

import { clamp } from './utils.js';
import { POWERUP_TYPES } from './config.js';

const NOISE_SECONDS = 2;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this.engineOn = false;
    this.lastSwoosh = -1;
    this.lastAlarm = -1;
    this.intensity = 0;
    this._nodes = {};
    this._time = 0;
  }

  /** Must be triggered from a user gesture (click / keydown). */
  init() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      this.ctx = new Ctx({ latencyHint: 'interactive' });
    } catch (err) {
      return;
    }

    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.85 : 0;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 24;
    comp.ratio.value = 3.4;
    comp.attack.value = 0.005;
    comp.release.value = 0.22;

    this.master.connect(comp);
    comp.connect(ctx.destination);

    // reusable white-noise buffer
    const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;

    this._buildEngineHum();
    this.ready = true;
  }

  /* ------------------------------------------------------------------ */
  /* graph construction                                                  */
  /* ------------------------------------------------------------------ */

  _buildEngineHum() {
    const ctx = this.ctx;

    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.master);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    filter.Q.value = 6;
    filter.connect(bus);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 34;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.55;
    sub.connect(subGain).connect(filter);

    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = 68;
    saw.detune.value = -6;
    const sawGain = ctx.createGain();
    sawGain.gain.value = 0.22;
    saw.connect(sawGain).connect(filter);

    const howl = ctx.createOscillator();
    howl.type = 'triangle';
    howl.frequency.value = 136;
    howl.detune.value = 9;
    const howlGain = ctx.createGain();
    howlGain.gain.value = 0.09;
    howl.connect(howlGain).connect(filter);

    // slow wobble for a living reactor feel
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.22;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.035;
    lfo.connect(lfoGain).connect(bus.gain);

    // wind / thruster rush
    const wind = ctx.createBufferSource();
    wind.buffer = this.noiseBuffer;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 620;
    windFilter.Q.value = 0.75;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    wind.connect(windFilter).connect(windGain).connect(this.master);

    sub.start();
    saw.start();
    howl.start();
    lfo.start();
    wind.start();

    this._nodes.engine = { bus, filter, sub, saw, howl, windFilter, windGain, subGain, sawGain, howlGain };
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  get time() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  _noiseSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    return src;
  }

  _shaper(amount = 8) {
    const shaper = this.ctx.createWaveShaper();
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
    }
    shaper.curve = curve;
    return shaper;
  }

  _env(node, { attack = 0.005, decay = 0.2, peak = 0.2, sustain = 0, hold = 0 }) {
    const now = this.time;
    const g = node.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0.0001, now);
    g.linearRampToValueAtTime(peak, now + attack);
    if (hold > 0) g.setValueAtTime(peak, now + attack + hold);
    g.exponentialRampToValueAtTime(0.0001, now + attack + hold + decay);
    if (sustain > 0) {
      g.setValueAtTime(0.0001, now + attack + hold + decay);
      g.linearRampToValueAtTime(sustain, now + attack + hold + decay + 0.02);
    }
    return now + attack + hold + decay + 0.05;
  }

  /* ------------------------------------------------------------------ */
  /* engine hum                                                          */
  /* ------------------------------------------------------------------ */

  startEngine() {
    if (!this.ready) return;
    this.engineOn = true;
    const { bus } = this._nodes.engine;
    bus.gain.cancelScheduledValues(this.time);
    bus.gain.setTargetAtTime(0.16, this.time, 0.5);
  }

  stopEngine(fade = 0.5) {
    if (!this.ready || !this.engineOn) return;
    this.engineOn = false;
    const { bus, windGain } = this._nodes.engine;
    bus.gain.setTargetAtTime(0, this.time, fade);
    windGain.gain.setTargetAtTime(0, this.time, fade);
  }

  /** Drive the hum from the current gameplay state. */
  update(dt, { speedNorm = 0, boosting = false, dilating = false, active = true } = {}) {
    if (!this.ready) return;
    this._time += dt;
    const n = this._nodes.engine;
    const target = clamp(speedNorm, 0, 1.6);
    this.intensity += (target - this.intensity) * Math.min(1, dt * 3.2);

    const t = this.time;
    const i = this.intensity;
    const base = 30 + i * 46 + (boosting ? 22 : 0);
    n.sub.frequency.setTargetAtTime(base, t, 0.12);
    n.saw.frequency.setTargetAtTime(base * 2.02, t, 0.12);
    n.howl.frequency.setTargetAtTime(base * 4.1 * (dilating ? 0.82 : 1), t, 0.16);
    n.filter.frequency.setTargetAtTime(240 + i * 900 + (boosting ? 700 : 0), t, 0.15);
    n.subGain.gain.setTargetAtTime(0.5 + i * 0.2, t, 0.2);
    n.sawGain.gain.setTargetAtTime(0.16 + i * 0.22, t, 0.2);
    n.howlGain.gain.setTargetAtTime(0.05 + i * 0.14, t, 0.2);
    n.windFilter.frequency.setTargetAtTime(420 + i * 1500 + (boosting ? 900 : 0), t, 0.2);
    n.windGain.gain.setTargetAtTime(
      active ? 0.02 + i * 0.11 + (boosting ? 0.09 : 0) : 0,
      t,
      0.25
    );
    if (this.engineOn) {
      n.bus.gain.setTargetAtTime(active ? 0.13 + i * 0.07 : 0.05, t, 0.3);
    }
  }

  /* ------------------------------------------------------------------ */
  /* one-shots                                                           */
  /* ------------------------------------------------------------------ */

  /** Lateral thruster whoosh when steering hard. */
  swoosh(direction = 0, power = 1) {
    if (!this.ready || !this.enabled) return;
    const t = this.time;
    if (t - this.lastSwoosh < 0.16) return;
    this.lastSwoosh = t;

    const ctx = this.ctx;
    const src = this._noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.1;
    const startF = 520 + direction * 180;
    bp.frequency.setValueAtTime(startF, t);
    bp.frequency.exponentialRampToValueAtTime(startF * 2.9, t + 0.12);
    bp.frequency.exponentialRampToValueAtTime(startF * 0.7, t + 0.34);

    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    src.connect(bp).connect(gain);
    if (pan) {
      pan.pan.value = clamp(direction, -1, 1) * 0.7;
      gain.connect(pan).connect(this.master);
    } else {
      gain.connect(this.master);
    }
    this._env(gain, { attack: 0.02, decay: 0.32, peak: 0.19 * power });
    src.start(t);
    src.stop(t + 0.42);
  }

  /** High pitched pulse chime for a pickup. */
  chime(type = 'boost') {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = this.time;
    const meta = POWERUP_TYPES[type] || POWERUP_TYPES.boost;
    const base = type === 'brake' ? 720 : type === 'shield' ? 620 : 880;
    const ratios = type === 'brake' ? [1, 0.75, 0.5] : type === 'shield' ? [1, 1.5, 2.5] : [1, 1.5, 2];

    ratios.forEach((r, idx) => {
      const osc = ctx.createOscillator();
      osc.type = type === 'brake' ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(base * r, t + idx * 0.055);
      const gain = ctx.createGain();
      osc.connect(gain).connect(this.master);
      this._env(gain, {
        attack: 0.006,
        decay: 0.42 - idx * 0.08,
        peak: 0.16 / (1 + idx * 0.5),
      });
      osc.start(t + idx * 0.055);
      osc.stop(t + idx * 0.055 + 0.6);
    });

    // sparkle top end
    const shimmer = ctx.createOscillator();
    shimmer.type = 'sine';
    shimmer.frequency.setValueAtTime(base * 5, t);
    shimmer.frequency.exponentialRampToValueAtTime(base * 8, t + 0.25);
    const shimGain = ctx.createGain();
    shimmer.connect(shimGain).connect(this.master);
    this._env(shimGain, { attack: 0.004, decay: 0.3, peak: 0.05 });
    shimmer.start(t);
    shimmer.stop(t + 0.4);
    void meta;
  }

  /** Warning klaxon for an incoming wall row. */
  alarm() {
    if (!this.ready || !this.enabled) return;
    const t = this.time;
    if (t - this.lastAlarm < 0.28) return;
    this.lastAlarm = t;

    const ctx = this.ctx;
    [0, 0.13].forEach((offset, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      const f = i === 0 ? 720 : 980;
      osc.frequency.setValueAtTime(f, t + offset);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2600;
      const gain = ctx.createGain();
      osc.connect(lp).connect(gain).connect(this.master);
      this._env(gain, { attack: 0.006, decay: 0.1, peak: 0.085 });
      osc.start(t + offset);
      osc.stop(t + offset + 0.15);
    });
  }

  /** Fatal impact: noise slam + descending sub. */
  crash() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = this.time;

    const noise = this._noiseSource();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(160, t + 0.85);
    const shaper = this._shaper(6);
    const gain = ctx.createGain();
    noise.connect(lp).connect(shaper).connect(gain).connect(this.master);
    this._env(gain, { attack: 0.004, decay: 0.95, peak: 0.7 });
    noise.start(t);
    noise.stop(t + 1.1);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(180, t);
    sub.frequency.exponentialRampToValueAtTime(34, t + 0.9);
    const subGain = ctx.createGain();
    sub.connect(subGain).connect(this.master);
    this._env(subGain, { attack: 0.006, decay: 0.9, peak: 0.55 });
    sub.start(t);
    sub.stop(t + 1);

    const debris = this._noiseSource();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2400;
    const debrisGain = ctx.createGain();
    debris.connect(hp).connect(debrisGain).connect(this.master);
    this._env(debrisGain, { attack: 0.01, decay: 0.5, peak: 0.22 });
    debris.start(t + 0.05);
    debris.stop(t + 0.7);
  }

  /** Shield absorbing a hit — metallic ring. */
  shieldBreak() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = this.time;
    [1240, 1860, 2480].forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 0.72, t + 0.4);
      const gain = ctx.createGain();
      osc.connect(gain).connect(this.master);
      this._env(gain, { attack: 0.003, decay: 0.45 + i * 0.1, peak: 0.14 / (1 + i) });
      osc.start(t);
      osc.stop(t + 0.9);
    });
    const src = this._noiseSource();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3200;
    const gain = ctx.createGain();
    src.connect(hp).connect(gain).connect(this.master);
    this._env(gain, { attack: 0.003, decay: 0.3, peak: 0.16 });
    src.start(t);
    src.stop(t + 0.45);
  }

  /** Warp burst ignition. */
  boost() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = this.time;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(920, t + 0.45);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.4;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + 0.5);
    const gain = ctx.createGain();
    osc.connect(bp).connect(gain).connect(this.master);
    this._env(gain, { attack: 0.02, decay: 0.6, peak: 0.24 });
    osc.start(t);
    osc.stop(t + 0.75);

    const src = this._noiseSource();
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.Q.value = 0.9;
    nf.frequency.setValueAtTime(400, t);
    nf.frequency.exponentialRampToValueAtTime(3200, t + 0.5);
    const nGain = ctx.createGain();
    src.connect(nf).connect(nGain).connect(this.master);
    this._env(nGain, { attack: 0.03, decay: 0.6, peak: 0.22 });
    src.start(t);
    src.stop(t + 0.8);
  }

  /** Warp brake — time dilation downshift. */
  brake() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = this.time;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.75);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(420, t + 0.8);
    const gain = ctx.createGain();
    osc.connect(lp).connect(gain).connect(this.master);
    this._env(gain, { attack: 0.02, decay: 0.85, peak: 0.24 });
    osc.start(t);
    osc.stop(t + 1);
  }

  /** UI blip. */
  click(up = true) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = this.time;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(up ? 660 : 420, t);
    osc.frequency.exponentialRampToValueAtTime(up ? 1180 : 260, t + 0.09);
    const gain = ctx.createGain();
    osc.connect(gain).connect(this.master);
    this._env(gain, { attack: 0.003, decay: 0.1, peak: 0.07 });
    osc.start(t);
    osc.stop(t + 0.16);
  }

  /** Countdown / launch swell. */
  launch() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = this.time;
    const src = this._noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(180, t);
    bp.frequency.exponentialRampToValueAtTime(2400, t + 1.1);
    const gain = ctx.createGain();
    src.connect(bp).connect(gain).connect(this.master);
    this._env(gain, { attack: 0.35, decay: 0.75, peak: 0.26 });
    src.start(t);
    src.stop(t + 1.3);
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  setEnabled(on) {
    this.enabled = on;
    if (!this.ready) return;
    this.master.gain.setTargetAtTime(on ? 0.85 : 0, this.time, 0.08);
    if (!on) this.stopEngine(0.2);
  }

  toggle() {
    this.setEnabled(!this.enabled);
    this.click(this.enabled);
    return this.enabled;
  }

  suspend() {
    if (this.ready && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  resume() {
    if (this.ready && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }
}
