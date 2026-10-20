/**
 * Game — state machine + main loop that wires every subsystem together.
 *
 * States: boot → menu → playing ⇄ paused → over → (menu | playing)
 */

import * as THREE from 'three';
import {
  CAMERA,
  COLORS,
  CORRIDOR,
  DIFFICULTY,
  HORIZON,
  LANES,
  POWERUPS,
  POWERUP_TYPES,
  SHIP,
  SPEED,
  STORAGE_KEY,
  WALLS,
  laneCenterX,
  laneIndexAt,
} from './config.js';
import { AudioEngine } from './audio.js';
import { InputManager } from './input.js';
import { Environment } from './environment.js';
import { Player } from './player.js';
import { ObstacleManager } from './obstacles.js';
import { PowerUpManager } from './powerups.js';
import { BurstPool, ShockwavePool } from './vfx.js';
import { UI } from './ui.js';
import {
  baseSpeedAt,
  boxesOverlap,
  difficultyAt,
  playerBox,
  powerupIntervalAt,
  rowDistanceAt,
  solidDurationAt,
  sphereOverlap,
  tileCountAt,
  toDisplaySpeed,
  warningColorAt,
  warningDistanceAt,
  warningDurationAt,
  warningStripLengthAt,
} from './collision.js';
import { freeWithin, selectFairRow } from './fairness.js';
import { clamp, createRandom, damp, safeStorage } from './utils.js';

export const STATES = {
  BOOT: 'boot',
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  OVER: 'over',
};

const FIXED_STEP = 1 / 60;
const MAX_STEPS = 8;
const MAX_FRAME_DT = 0.1;
const MENU_SCROLL_SPEED = 26;
/** Bonus distance for shattering a barrier with an active shield. */
const SHATTER_REWARD = 25;
const SHATTER_REWARD_LANES = 6;

export class Game {
  constructor({ canvas }) {
    this.canvas = canvas;
    this.state = STATES.BOOT;
    this.storage = safeStorage();
    this.rng = createRandom();
    this.clock = { last: 0, acc: 0, frameMs: 16, fps: 60, samples: [] };
    this.quality = { pixelRatio: Math.min(window.devicePixelRatio || 1, 2), target: Math.min(window.devicePixelRatio || 1, 2) };
    this.pausedByVisibility = false;
    this.steppingPaused = false;
    this.time = 0;
    this.shake = 0;
    this.run = {};
    this._raf = 0;

    this._initRenderer();
    this._initScene();
    this._initSubsystems();
    this._initEvents();
    this._resetRun();
    this._enterMenu({ silent: true });
  }

  /* ================================================================== */
  /* bootstrapping                                                       */
  /* ================================================================== */

  _initRenderer() {
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: !isMobile,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.setClearColor(COLORS.bg, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.info.autoReset = true;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.bg);
    this.scene.fog = new THREE.Fog(COLORS.fog, 140, 370);

    this.camera = new THREE.PerspectiveCamera(
      CAMERA.fov,
      window.innerWidth / Math.max(1, window.innerHeight),
      0.1,
      2400
    );
    this.camera.position.set(CAMERA.position.x, CAMERA.position.y, CAMERA.position.z);
    this.camera.lookAt(CAMERA.lookAt.x, CAMERA.lookAt.y, CAMERA.lookAt.z);
    this.cameraBase = this.camera.position.clone();
  }

  _initSubsystems() {
    this.environment = new Environment(this.scene);
    this.player = new Player(this.scene);
    this.burstPool = new BurstPool(this.scene, { count: 900 });
    this.shockwavePool = new ShockwavePool(this.scene, { count: 8 });
    this.powerupManager = new PowerUpManager(this.scene, {
      burstPool: this.burstPool,
      shockwavePool: this.shockwavePool,
    });
    this.obstacles = new ObstacleManager(this.scene, {
      burstPool: this.burstPool,
      shockwavePool: this.shockwavePool,
      onWarning: (wall, meta) => this._onWallWarning(wall, meta),
      onMaterialise: () => {},
    });

    this.audio = new AudioEngine();
    this.ui = new UI({
      start: () => this.startRun(),
      resume: () => this.resume(),
      restart: () => this.startRun(),
      menu: () => this.toMenu(),
    });
    this.input = new InputManager({
      canvas: this.canvas,
      buttons: {
        left: document.getElementById('btn-left'),
        right: document.getElementById('btn-right'),
        pause: document.getElementById('btn-pause'),
        mute: document.getElementById('btn-mute'),
      },
      onAction: (action) => this._onAction(action),
    });
  }

  _initEvents() {
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);

    const unlockAudio = () => {
      this.audio.init();
      if (this.state === STATES.PLAYING) this.audio.startEngine();
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === STATES.PLAYING) {
        this.pausedByVisibility = true;
        this.pause();
      } else if (!document.hidden && this.pausedByVisibility) {
        this.pausedByVisibility = false;
      }
    });

    window.addEventListener('blur', () => {
      if (this.state === STATES.PLAYING) this.pause();
    });
  }

  /* ================================================================== */
  /* run lifecycle                                                       */
  /* ================================================================== */

  _blankRun() {
    return {
      distance: 0,
      elapsed: 0,
      topSpeed: 0,
      powerups: 0,
      wallsDestroyed: 0,
      shieldsUsed: 0,
      warnings: 0,
    };
  }

  _resetRun() {
    this.run = this._blankRun();
    this.speed = SPEED.base;
    this.speedNorm = 0;
    this.boostTimer = 0;
    this.brakeTimer = 0;
    this.invulnTimer = 0;
    this.shieldCharges = 0;
    this.spawnDistance = WALLS.spacing.start * 0.55;
    this.spawnDistances = [];
    this.powerupTimer = 4.5;
    this._lastSwooshSign = 0;
    this.fairnessRelaxations = 0;
    this.lastRowVerdict = null;
    this.alarmCooldown = 0;
    this.shake = 0;
    this.spawningEnabled = true;
    this.rng = createRandom();
    this.difficulty = 0;
    this.obstacles.reset();
    this.powerupManager.reset();
    this.burstPool.reset();
    this.shockwavePool.reset();
    this.environment.reset();
    this.player.reset();
    this.player.setShield(0);
    this.ui.boostOverlay(false);
    this.ui.clearAlert();
  }

  _enterMenu({ silent = false } = {}) {
    this.state = STATES.MENU;
    this._resetRun();
    this.ui.setHudVisible(false);
    this.ui.setModal('start');
    this.ui.showStartStats(this._best().distance);
    this.audio.stopEngine(0.4);
    if (!silent) this.audio.click(false);
  }

  toMenu() {
    this._enterMenu();
  }

  startRun() {
    this.audio.init();
    this._resetRun();
    this.state = STATES.PLAYING;
    this.ui.setModal(null);
    this.ui.setHudVisible(true);
    this.ui.toast('Run engaged — read the red lattice', 'info');
    this.audio.setEnabled(this.audio.enabled);
    this.audio.startEngine();
    this.audio.launch();
    this.canvas?.focus?.();
  }

  restart() {
    this.startRun();
  }

  pause() {
    if (this.state !== STATES.PLAYING) return;
    this.state = STATES.PAUSED;
    this.ui.showPauseStats({
      distance: this.run.distance,
      topSpeed: this.run.topSpeed,
      timeAlive: this.run.elapsed,
    });
    this.ui.setModal('pause');
    this.audio.stopEngine(0.25);
    this.audio.suspend();
    this.input.releaseAll();
  }

  resume() {
    if (this.state !== STATES.PAUSED) return;
    this.state = STATES.PLAYING;
    this.ui.setModal(null);
    this.ui.setHudVisible(true);
    this.audio.resume();
    this.audio.startEngine();
    this.ui.toast('Run resumed', 'info');
  }

  togglePause() {
    if (this.state === STATES.PLAYING) this.pause();
    else if (this.state === STATES.PAUSED) this.resume();
  }

  _fatal() {
    if (this.state === STATES.OVER) return;
    this.state = STATES.OVER;
    this.audio.crash();
    this.audio.stopEngine(0.35);
    this.ui.glitch();
    this.ui.damageFlash();
    this.ui.boostOverlay(false);
    this.ui.clearAlert();
    this.shake = 1.6;

    const p = this.player.position;
    const shipCentre = new THREE.Vector3(p.x, p.y, p.z);
    this.burstPool.spawn(shipCentre, {
      amount: 120,
      speed: 26,
      life: 1.5,
      size: 1.6,
      color: 0xff8a3d,
      colorVariance: 0.7,
      spread: 0.8,
      drag: 1.1,
    });
    this.burstPool.spawn(shipCentre, {
      amount: 70,
      speed: 14,
      life: 1.9,
      size: 2.4,
      color: COLORS.red,
      colorVariance: 0.4,
      spread: 1.2,
      drag: 1.6,
    });
    this.shockwavePool.fire(shipCentre, { color: 0xffb347, size: 26, life: 0.7 });
    this.shockwavePool.fire(shipCentre, { color: COLORS.red, size: 40, life: 0.9 });
    this.player.visual.visible = false;

    const best = this._best();
    const newRecord = this.run.distance > best.distance;
    this._saveBest();
    this.ui.showGameOver({
      distance: this.run.distance,
      topSpeed: this.run.topSpeed,
      powerups: this.run.powerups,
      timeAlive: this.run.elapsed,
      wallsDestroyed: this.run.wallsDestroyed,
      shieldsUsed: this.run.shieldsUsed,
      newRecord,
    });
    this.ui.setModal('over');
    this.input.releaseAll();
  }

  _best() {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return { distance: 0, topSpeed: 0 };
      const parsed = JSON.parse(raw);
      return {
        distance: Number(parsed.distance) || 0,
        topSpeed: Number(parsed.topSpeed) || 0,
      };
    } catch (err) {
      return { distance: 0, topSpeed: 0 };
    }
  }

  _saveBest() {
    const best = this._best();
    const next = {
      distance: Math.max(best.distance, Math.round(this.run.distance)),
      topSpeed: Math.max(best.topSpeed, Math.round(this.run.topSpeed)),
    };
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (err) {
      /* storage unavailable — best score simply won't persist */
    }
  }

  /* ================================================================== */
  /* input actions                                                       */
  /* ================================================================== */

  _onAction(action) {
    switch (action) {
      case 'pause':
        if (this.state === STATES.PLAYING || this.state === STATES.PAUSED) this.togglePause();
        break;
      case 'restart':
        if (this.state !== STATES.MENU) this.restart();
        break;
      case 'confirm':
        if (this.state === STATES.MENU) this.startRun();
        else if (this.state === STATES.OVER) this.restart();
        else if (this.state === STATES.PAUSED) this.resume();
        break;
      case 'mute': {
        this.audio.init();
        const on = this.audio.toggle();
        this.ui.setMuteLabel(!on);
        this.ui.toast(on ? 'Audio online' : 'Audio muted', 'info');
        break;
      }
      case 'pointerdown':
        this.audio.init();
        break;
      default:
        break;
    }
  }

  /* ================================================================== */
  /* spawning                                                            */
  /* ================================================================== */

  /** Lane the ship is flying in right now (unbounded lane space). */
  _shipLane() {
    return laneIndexAt(this.player.position.x);
  }

  /**
   * Lane the ship will be flying in when a row spawned now turns solid.
   *
   * Rows are anchored here rather than on the current lane: a barrier that spans
   * the play area but is centred behind a hard strafe would just be outraced, and
   * holding a direction would be an exploit again.
   */
  _predictedLane(flight) {
    const p = this.player.position;
    return laneIndexAt(p.x + this.player.velocityX * flight);
  }

  _onWallWarning(wall, { row }) {
    this.run.warnings += 1;
    const shipLane = this._shipLane();
    // A row is described by the lanes its tiles stand on, relative to the ship.
    const lanes = row.blocked || [];
    const offsets = lanes.map((lane) => lane - shipLane);
    const label = offsets.map((o) => (o > 0 ? `+${o}` : `${o}`)).join(',');
    const holds = offsets.includes(0) ? ' ⚠ in your lane' : '';
    this.ui.alert(
      `⚠ Wall inbound · ${lanes.length} tile${lanes.length > 1 ? 's' : ''} at lane${offsets.length > 1 ? 's' : ''} ${label}${holds}`,
      'warn',
      Math.min(1.8, wall.warnDuration + 0.4)
    );
    this.audio.alarm();
  }

  /**
   * Spawn one wall cluster.
   *
   * A row is one to `WALLS.maxTiles` tiles standing side by side (never more than
   * five), placed near the lane the ship is *predicted* to hold when the tiles
   * turn solid. The width is drawn per row and the placement alternates between
   * threats, near misses and reward-friendly offsets, so no two rows read alike.
   * Every candidate is validated with the shared fairness model before it ships.
   */
  _spawnWall() {
    const difficulty = this.difficulty;
    const speed = Math.max(20, this.speed);
    const warnDuration = warningDurationAt(difficulty, speed);
    const solidDuration = solidDurationAt(difficulty);
    const flight = warnDuration + solidDuration;
    const warnLength = warningStripLengthAt(speed);
    const anchorLane = this._predictedLane(flight);

    // everything still ahead of the ship, expressed in seconds from now
    const inFlight = this.obstacles.walls
      .filter((wall) => wall.active)
      .map((wall) => {
        const arrivalIn = Math.max(0, -wall.group.position.z / speed);
        return {
          free: freeWithin(wall.blockedLanes || [], anchorLane),
          materialiseIn: Math.max(0, arrivalIn - wall.solidDuration),
          arrivalIn,
        };
      })
      .sort((a, b) => a.materialiseIn - b.materialiseIn);

    // if a power-up is in flight, bias the cluster to one side so the reward lane
    // stays open on the way in
    const orb = this.powerupManager.orbs.find((o) => o.active && o.group.position.z < 0);

    const picked = selectFairRow({
      rand: this.rng,
      difficulty,
      inFlight,
      warnDuration,
      solidDuration,
      anchorLane,
      preferLane: orb ? laneIndexAt(orb.group.position.x) : null,
    });

    if (picked.fallback) this.fairnessRelaxations = (this.fairnessRelaxations || 0) + 1;
    this.lastRowVerdict = picked;
    this.lastLayout = {
      anchorLane,
      shipLane: this._shipLane(),
      tiles: picked.row.span,
      maxTiles: WALLS.maxTiles,
      segments: picked.row.segments || [],
      blockedLanes: picked.row.blocked ? picked.row.blocked.length : 0,
      width: picked.row.span * LANES.width,
      coverage: picked.row.blocked
        ? {
            left: anchorLane - Math.min(...picked.row.blocked),
            right: Math.max(...picked.row.blocked) - anchorLane,
          }
        : null,
      fallback: Boolean(picked.fallback),
      verdict: picked.verdict ? picked.verdict.feasible : null,
    };
    this.obstacles.spawnRow(picked.row, {
      difficulty,
      speed,
      warnDuration,
      solidDuration,
      warnLength,
    });
  }

  /** The open lane beside the nearest incoming cluster — where a reward can sit. */
  _openLaneAhead() {
    const rows = this.obstacles.walls
      .filter((w) => w.active && w.phase === 'warn' && w.freeLanes && w.freeLanes.length)
      .sort((a, b) => b.group.position.z - a.group.position.z);
    if (!rows.length) return null;
    const free = rows[0].freeLanes;
    const shipLane = this._shipLane();
    return free.reduce(
      (best, lane) => (Math.abs(lane - shipLane) < Math.abs(best - shipLane) ? lane : best),
      free[0]
    );
  }

  _spawnPowerup() {
    // Orbs drop in the open lane beside the next cluster, so threading the row is
    // also the line that collects the reward.
    const lane = this._openLaneAhead() ?? this._predictedLane(2);
    // never drop an orb straight into a wall that is already in flight
    const blocked = this.obstacles.walls.some(
      (w) => w.active && (w.blockedLanes || []).includes(lane)
    );
    const type =
      this.shieldCharges > 0 && this.rng() > 0.45
        ? 'boost'
        : this.rng() < 0.4
          ? 'boost'
          : this.rng() < 0.72
            ? 'brake'
            : 'shield';

    if (blocked) return;
    this.powerupManager.spawn(type, lane, CORRIDOR.spawnZ + 60);
  }

  /* ================================================================== */
  /* collisions                                                          */
  /* ================================================================== */

  _collisions() {
    const p = this.player.position;
    const box = playerBox(p.x, p.y, p.z);

    // a barrier is one box per slab, so the gap really is flyable
    for (const wall of this.obstacles.collidable()) {
      const hit = this.obstacles.boxesFor(wall).some((part) => boxesOverlap(box, part));
      if (hit) {
        this._handleWallHit(wall);
        if (this.state !== STATES.PLAYING) return;
      }
    }

    for (const orb of this.powerupManager.nearPlayer(4.5)) {
      const op = orb.group.position;
      if (sphereOverlap(p.x, p.y, p.z, SHIP.radius, op.x, op.y, op.z, POWERUPS.orbRadius)) {
        const result = this.powerupManager.collect(orb);
        if (result) this._applyPowerup(result.type, result.position);
      }
    }
  }

  _handleWallHit(wall) {
    const p = this.player.position;
    const impact = new THREE.Vector3(p.x, 1.1, p.z + 1);

    if (this.invulnTimer > 0) {
      this.obstacles.destroy(wall, { color: COLORS.green });
      this.run.wallsDestroyed += 1;
      // bars are wide now, so the reward is capped rather than span-scaled
      const reward = SHATTER_REWARD * Math.min(SHATTER_REWARD_LANES, wall.laneSpan);
      this.run.distance += reward;
      this.audio.shieldBreak();
      this.ui.toast(`Wall shattered · +${reward} m`, 'boost');
      this.shake = Math.min(1.2, this.shake + 0.35);
      return;
    }

    if (this.shieldCharges > 0) {
      this.shieldCharges = 0;
      this.player.setShield(0);
      this.run.shieldsUsed += 1;
      this.invulnTimer = POWERUPS.postHitInvuln;
      this.obstacles.destroy(wall, { color: COLORS.gold });
      this.player.flashHit();
      this.audio.shieldBreak();
      this.audio.crash();
      this.ui.damageFlash();
      this.ui.toast('Shield core shattered — fly clear', 'hit');
      this.burstPool.spawn(impact, {
        amount: 55,
        speed: 18,
        life: 0.9,
        size: 1.5,
        color: COLORS.gold,
        colorVariance: 0.5,
        spread: 0.7,
        drag: 1.5,
      });
      this.shake = 1.1;
      return;
    }

    this._fatal();
  }

  _applyPowerup(type, position) {
    const meta = POWERUP_TYPES[type];
    this.run.powerups += 1;
    this.audio.chime(type);

    switch (type) {
      case 'boost':
        this.boostTimer = POWERUPS.boostDuration;
        this.invulnTimer = Math.max(this.invulnTimer, POWERUPS.boostDuration);
        this.audio.boost();
        this.ui.alert('Warp burst engaged', 'boost', 1.1);
        this.ui.toast('Speed boost · invincible', 'boost');
        this.ui.boostOverlay(true);
        break;
      case 'brake':
        this.brakeTimer = POWERUPS.brakeDuration;
        this.audio.brake();
        this.ui.alert('Time dilation', 'info', 1.1);
        this.ui.toast('Warp brake · world slowed', 'brake');
        break;
      case 'shield':
      default:
        this.shieldCharges = 1;
        this.player.setShield(1);
        this.ui.alert('Shield core online', 'info', 1.1);
        this.ui.toast('Shield core · absorbs one impact', 'shield');
        break;
    }

    this.burstPool.spawn(position, {
      amount: 26,
      speed: 9,
      life: 0.7,
      size: 1.2,
      color: meta.color,
      spread: 0.3,
      drag: 2.4,
    });
  }

  /* ================================================================== */
  /* loop                                                                */
  /* ================================================================== */

  start() {
    this.state = STATES.MENU;
    this.clock.last = performance.now();
    const frame = (t) => {
      this._raf = requestAnimationFrame(frame);
      this._frame(t);
    };
    this._raf = requestAnimationFrame(frame);
  }

  _frame(t) {
    const now = t || performance.now();
    let dt = (now - this.clock.last) / 1000;
    this.clock.last = now;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    dt = Math.min(dt, MAX_FRAME_DT);

    // fps tracking
    const frameMs = dt * 1000;
    this.clock.samples.push(frameMs);
    if (this.clock.samples.length > 60) this.clock.samples.shift();
    const avg = this.clock.samples.reduce((a, b) => a + b, 0) / this.clock.samples.length;
    this.clock.frameMs = avg;
    this.clock.fps = 1000 / Math.max(1, avg);
    this._adaptQuality(avg);

    if (this.steppingPaused) {
      // test / tooling hook: render only, advance game time explicitly
      this.clock.acc = 0;
    } else if (this.state === STATES.PLAYING || this.state === STATES.MENU) {
      this.clock.acc += dt;
      let steps = 0;
      while (this.clock.acc >= FIXED_STEP && steps < MAX_STEPS) {
        this._step(FIXED_STEP);
        this.clock.acc -= FIXED_STEP;
        steps += 1;
      }
      if (steps === MAX_STEPS) this.clock.acc = 0;
    } else {
      this.clock.acc = 0;
      this._step(0);
    }

    this.renderer.render(this.scene, this.camera);
  }

  _adaptQuality(avgFrameMs) {
    const { quality } = this;
    if (avgFrameMs > 22 && quality.pixelRatio > 0.75) {
      quality.pixelRatio = Math.max(0.75, quality.pixelRatio - 0.15);
      this._applyPixelRatio();
    } else if (avgFrameMs < 13.5 && quality.pixelRatio < quality.target - 0.01) {
      quality.pixelRatio = Math.min(quality.target, quality.pixelRatio + 0.1);
      this._applyPixelRatio();
    }
  }

  _applyPixelRatio() {
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.environment.setPixelRatio(this.quality.pixelRatio);
    this.player.setPixelRatio(this.quality.pixelRatio);
    this.burstPool.setPixelRatio(this.quality.pixelRatio);
  }

  _step(dt) {
    const playing = this.state === STATES.PLAYING;
    const menuIdle = this.state === STATES.MENU;
    this.time += dt;

    /* --- input + steering ------------------------------------------- */
    const axis = dt > 0 ? this.input.update(dt) : this.input.axis;
    if (menuIdle) {
      const idleAxis = Math.sin(this.time * 0.28) * 0.55;
      this.player.update(dt, {
        axis: idleAxis,
        speed: MENU_SCROLL_SPEED,
        speedNorm: 0.18,
        boost: 0,
        invuln: 0,
        shieldCharges: 0,
        idle: true,
      });
      this.environment.update(dt, {
        speed: MENU_SCROLL_SPEED,
        speedNorm: 0.18,
        boost: 0,
        danger: 0,
      });
      this.burstPool.update(dt);
      this.shockwavePool.update(dt);
      this._updateCamera(dt, idleAxis, 0.18);
      this.player.visual.visible = true;
      if (this.ui) this.ui.tick(dt);
      return;
    }

    if (!playing) {
      if (this.state === STATES.OVER) {
        this.burstPool.update(dt * 0.6);
        this.shockwavePool.update(dt * 0.6);
        this.environment.update(dt * 0.35, {
          speed: MENU_SCROLL_SPEED * 0.4,
          speedNorm: 0.1,
          boost: 0,
          danger: 0,
        });
        this._updateCamera(dt, 0, 0.1);
      } else {
        this.shockwavePool.update(dt);
      }
      return;
    }

    /* --- difficulty + speed ----------------------------------------- */
    this.run.elapsed += dt;
    const difficulty = difficultyAt(this.run.distance);
    this.difficulty = difficulty;

    const worldScale = this.brakeTimer > 0 ? SPEED.timeDilation : 1;
    const base = baseSpeedAt(this.run.elapsed, difficulty);
    const target = base * (this.boostTimer > 0 ? SPEED.boostMultiplier : 1);
    this.speed = damp(this.speed, target, this.boostTimer > 0 ? 2.4 : 3.4, dt);

    const worldDt = dt * worldScale;
    const boostNorm = this.boostTimer > 0 ? clamp(this.boostTimer / POWERUPS.boostDuration, 0, 1) : 0;
    const speedNorm = clamp(this.speed / SPEED.max, 0, 1.65);
    this.speedNorm = speedNorm;

    const travel = this.speed * worldDt;
    this.run.distance += travel;
    const displaySpeed = toDisplaySpeed(this.speed);
    this.run.topSpeed = Math.max(this.run.topSpeed, displaySpeed);

    /* --- spawns ------------------------------------------------------ */
    if (this.spawningEnabled) {
      // rows are laid down by *distance travelled*, not by a timer: the spacing is
      // a chaotic draw (burst / jitter / breather), so it is never a metronome
      this.spawnDistance -= travel;
      if (this.spawnDistance <= 0) {
        this._spawnWall();
        this.spawnDistance = rowDistanceAt(difficulty, this.rng);
        this.spawnDistances.push(Math.round(this.spawnDistance));
        if (this.spawnDistances.length > 64) this.spawnDistances.shift();
      }

      this.powerupTimer -= dt;
      if (this.powerupTimer <= 0) {
        this._spawnPowerup();
        this.powerupTimer = powerupIntervalAt(difficulty, this.rng);
      }
    }

    /* --- world ------------------------------------------------------- */
    const danger = this.obstacles.warningActive
      ? 0.25 + 0.75 * this.obstacles.warningProgress
      : 0;
    this.environment.update(worldDt, {
      speed: this.speed,
      speedNorm,
      boost: boostNorm,
      danger,
    });
    this.obstacles.update(worldDt, { travel, speed: this.speed });
    this.powerupManager.update(worldDt, { travel });
    this.burstPool.update(worldDt);
    this.shockwavePool.update(worldDt);

    this.player.update(dt, {
      axis,
      speed: this.speed,
      speedNorm,
      boost: boostNorm,
      dilating: this.brakeTimer > 0,
      invuln: this.invulnTimer,
      shieldCharges: this.shieldCharges,
    });
    this.player.visual.visible = true;

    /* --- audio + camera --------------------------------------------- */
    this.audio.update(dt, {
      speedNorm,
      boosting: this.boostTimer > 0,
      dilating: this.brakeTimer > 0,
      active: true,
    });
    this._updateCamera(dt, axis, speedNorm, boostNorm);

    if (Math.abs(axis) > 0.72 && Math.sign(axis) !== this._lastSwooshSign) {
      this._lastSwooshSign = Math.sign(axis);
      this.audio.swoosh(axis, clamp(Math.abs(axis), 0.4, 1));
    } else if (Math.abs(axis) < 0.3) {
      this._lastSwooshSign = 0;
    }

    /* --- timers ------------------------------------------------------ */
    if (this.boostTimer > 0) {
      this.boostTimer = Math.max(0, this.boostTimer - dt);
      if (this.boostTimer === 0) this.ui.boostOverlay(false);
    }
    if (this.brakeTimer > 0) this.brakeTimer = Math.max(0, this.brakeTimer - dt);
    if (this.invulnTimer > 0) this.invulnTimer = Math.max(0, this.invulnTimer - dt);

    /* --- repeated klaxon while a warning is live -------------------- */
    this.alarmCooldown -= dt;
    if (this.obstacles.warningActive && this.alarmCooldown <= 0) {
      this.alarmCooldown = 0.9;
      this.audio.alarm();
    }

    /* --- collisions -------------------------------------------------- */
    this._collisions();

    /* --- HUD --------------------------------------------------------- */
    const powerups = [];
    if (this.boostTimer > 0) {
      powerups.push({ id: 'boost', ratio: this.boostTimer / POWERUPS.boostDuration });
    }
    if (this.brakeTimer > 0) {
      powerups.push({ id: 'brake', ratio: this.brakeTimer / POWERUPS.brakeDuration });
    }
    if (this.shieldCharges > 0) powerups.push({ id: 'shield', ratio: 1, count: 1 });
    if (this.invulnTimer > 0 && this.boostTimer <= 0) {
      powerups.push({ id: 'invuln', ratio: clamp(this.invulnTimer / POWERUPS.postHitInvuln, 0, 1) });
    }

    this.ui.update({
      score: this.run.distance,
      speedKmh: displaySpeed,
      speedNorm,
      boosting: this.boostTimer > 0,
      dilating: this.brakeTimer > 0,
      best: this._best().distance,
      fps: this.clock.fps,
      powerups,
      muted: !this.audio.enabled,
    });
    this.ui.tick(dt);
  }

  /** Screen-space position of the ship (normalised device coords). */
  _projectShip() {
    this._ndc = this._ndc || new THREE.Vector3();
    this.camera.updateMatrixWorld(true);
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    this._ndc.copy(this.player.position).project(this.camera);
    return {
      x: Number(this._ndc.x.toFixed(3)),
      y: Number(this._ndc.y.toFixed(3)),
      onScreen: Math.abs(this._ndc.x) <= 1 && Math.abs(this._ndc.y) <= 1,
    };
  }

  _updateCamera(dt, axis, speedNorm, boostNorm = 0) {
    const p = this.player.position;
    const base = this.cameraBase;
    const shake = this.shake;
    if (shake > 0) this.shake = Math.max(0, shake - dt * 2.6);

    const shakeX = (Math.random() - 0.5) * shake * 0.85;
    const shakeY = (Math.random() - 0.5) * shake * 0.6;

    // The plane stretches forever, so the camera tracks the ship's absolute
    // position and only leaves a bounded lateral drift behind it. Small dodges
    // still slide across the screen (the drift fills up first), while long
    // strafes keep the ship framed instead of running off the edge. The drift
    // is a share of the visible half-width, so it scales with any viewport.
    const depth = Math.max(1, this.camera.position.z - p.z);
    const halfWidth =
      depth * Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect;
    const driftMax = CAMERA.driftShare * halfWidth;
    const drift = clamp(p.x - base.x, -driftMax, driftMax);
    const targetX = p.x - drift;
    const targetY = base.y + p.y * CAMERA.followY;
    const fovTarget = CAMERA.fov + boostNorm * CAMERA.boostFovKick + speedNorm * 3;

    this.camera.position.x = damp(this.camera.position.x, targetX, 7, dt) + shakeX;
    this.camera.position.y = damp(this.camera.position.y, targetY, 6, dt) + shakeY;
    this.camera.position.z = damp(this.camera.position.z, base.z - boostNorm * 0.9, 5, dt);
    this.camera.fov += (fovTarget - this.camera.fov) * Math.min(1, dt * 4);
    this.camera.updateProjectionMatrix();

    // aim slightly past the ship so the view leans into long strafes
    const lookX = p.x - drift * CAMERA.lookLead;
    const lookY = CAMERA.lookAt.y + p.y * 0.2;
    this.camera.lookAt(lookX, lookY, CAMERA.lookAt.z);
    this.camera.rotation.z += -this.player.roll * 0.14 + (Math.random() - 0.5) * shake * 0.02;

    this.environment.setCameraZ(this.camera.position.z);
    this.environment.followCamera(this.camera.position.x, this.camera.position.y, this.camera);
    void axis;
  }

  /* ================================================================== */
  /* misc                                                                */
  /* ================================================================== */

  resize() {
    const w = window.innerWidth;
    const h = Math.max(1, window.innerHeight);
    this.camera.aspect = w / h;
    // keep the corridor framed on tall/narrow screens
    const aspectBoost = clamp(1.25 / Math.max(0.6, this.camera.aspect), 1, 1.55);
    this.camera.fov = CAMERA.fov * aspectBoost;
    if (aspectBoost > 1) this.camera.position.setX(CAMERA.position.x);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.environment.setCameraZ(this.camera.position.z);
    this.environment.followCamera(this.camera.position.x, this.camera.position.y, this.camera);
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    this.input.dispose();
    this.renderer.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* debug / test surface                                                */
  /* ------------------------------------------------------------------ */

  snapshot() {
    return {
      state: this.state,
      distance: Math.round(this.run.distance),
      speedKmh: Math.round(toDisplaySpeed(this.speed)),
      topSpeedKmh: Math.round(this.run.topSpeed),
      difficulty: Number(this.difficulty.toFixed(3)),
      warnings: this.run.warnings,
      powerups: this.run.powerups,
      wallsDestroyed: this.run.wallsDestroyed,
      shieldsUsed: this.run.shieldsUsed,
      elapsed: Number(this.run.elapsed.toFixed(2)),
      shieldCharges: this.shieldCharges,
      invuln: Number(this.invulnTimer.toFixed(2)),
      boost: Number(this.boostTimer.toFixed(2)),
      brake: Number(this.brakeTimer.toFixed(2)),
      fairnessRelaxations: this.fairnessRelaxations || 0,
      shipX: Number(this.player.position.x.toFixed(3)),
      shipLane: this._shipLane(),
      shipY: Number(this.player.position.y.toFixed(3)),
      // the endless-world bookkeeping: everything tracks the camera laterally
      worldFollow: {
        cameraX: Number(this.camera.position.x.toFixed(3)),
        floorX: Number(this.environment.floorMesh.position.x.toFixed(3)),
        starX: Number(this.environment.deepPoints.position.x.toFixed(3)),
        backdropX: Number(this.environment.backdrop.position.x.toFixed(3)),
      },
      shipCameraOffset: Number((this.player.position.x - this.camera.position.x).toFixed(3)),
      screen: this._projectShip(),
      shipRoll: Number(this.player.roll.toFixed(3)),
      shipVisible: this.player.visual.visible,
      walls: this.obstacles.walls.length,
      wallPhases: this.obstacles.walls.map((w) => w.phase),
      wallZ: this.obstacles.walls.map((w) => Number(w.group.position.z.toFixed(2))),
      solidAhead: this.obstacles.walls.some((w) => w.phase === 'solid' && w.group.position.z < -1.5),
      warningActive: this.obstacles.warningActive,
      warningProgress: Number(this.obstacles.warningProgress.toFixed(3)),
      orbs: this.powerupManager.orbs.filter((o) => o.active).length,
      particles: this.burstPool.alive + this.player.trailAlpha.filter((a) => a > 0).length,
      fps: Number(this.clock.fps.toFixed(1)),
      frameMs: Number(this.clock.frameMs.toFixed(2)),
      pixelRatio: this.quality.pixelRatio,
      canvas: {
        width: this.canvas.width,
        height: this.canvas.height,
        cssWidth: this.canvas.clientWidth,
        cssHeight: this.canvas.clientHeight,
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      renderer: {
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
      },
    };
  }

  debug = {
    /** Absolute lane indices (lane 0 = world axis); lanes extend both ways. */
    spawnWall: (lanes = [0]) => {
      const blocked = [...lanes].sort((a, b) => a - b);
      const start = blocked[0];
      const span = blocked[blocked.length - 1] - start + 1;
      this.obstacles.spawnRow(
        { start, span, blocked, free: freeWithin(blocked, this._shipLane()) },
        {
          difficulty: this.difficulty,
          speed: Math.max(20, this.speed),
          warnDuration: 0.4,
          solidDuration: 0.45,
        }
      );
    },
    grant: (type = 'boost') => {
      const orb = this.powerupManager.spawn(type, this._shipLane(), 4);
      orb.group.position.x = 0;
      const result = this.powerupManager.collect(orb);
      if (result) this._applyPowerup(result.type, result.position);
      return result;
    },
    setShield: () => {
      this.shieldCharges = 1;
      this.player.setShield(1);
    },
    hitNow: () => {
      const wall = this.obstacles.collidable()[0];
      if (!wall) return false;
      this._handleWallHit(wall);
      return true;
    },
    clearField: () => {
      this.obstacles.reset();
      this.powerupManager.reset();
      this.spawnDistance = WALLS.spacing.start;
      this.powerupTimer = 6;
    },
    /** Toggle the procedural spawner (verification + cinematic capture). */
    setSpawning: (on = true) => {
      this.spawningEnabled = Boolean(on);
      return this.spawningEnabled;
    },
    setShipX: (x = 0) => {
      this.player.position.x = x;
      this.player.velocityX = 0;
      return this.player.position.x;
    },
    shipLane: () => this._shipLane(),
    laneCentre: (index) => laneCenterX(index),
    /** Suspend the real-time loop so tooling can advance time deterministically. */
    freeze: () => {
      this.steppingPaused = true;
      this.clock.acc = 0;
      return true;
    },
    unfreeze: () => {
      this.steppingPaused = false;
      this.clock.last = performance.now();
      return true;
    },
    /** Deterministic time stepping — used by the automated verification suite. */
    advance: (seconds = 1) => {
      const steps = Math.min(3600, Math.max(1, Math.round(seconds / FIXED_STEP)));
      for (let i = 0; i < steps; i += 1) this._step(FIXED_STEP);
      return steps;
    },
    /** CPU cost of one logic step and one render pass (GPU-side cost proxy). */
    benchmark: (samples = 240) => {
      const t0 = performance.now();
      for (let i = 0; i < samples; i += 1) this._step(FIXED_STEP);
      const stepMs = (performance.now() - t0) / samples;

      const t1 = performance.now();
      const renders = 8;
      for (let i = 0; i < renders; i += 1) this.renderer.render(this.scene, this.camera);
      const renderMs = (performance.now() - t1) / renders;

      return {
        stepMs: Number(stepMs.toFixed(3)),
        renderMs: Number(renderMs.toFixed(2)),
        samples,
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        pixelRatio: this.quality.pixelRatio,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    },
    /** Drops a solid wall `laneOffset` lanes from the ship, dead ahead. */
    placeWallAtShip: (laneOffset = 0) => {
      const laneIndex = this._shipLane() + laneOffset;
      const wall = this.obstacles.spawnRow(
        { start: laneIndex, span: 1, blocked: [laneIndex], free: freeWithin([laneIndex], this._shipLane()) },
        { difficulty: 0, speed: 1000, warnDuration: 0.01, solidDuration: 0.01 }
      );
      wall.group.position.z = 0;
      wall.prevZ = 0;
      this._forceSolid(wall);
      return true;
    },
    placeOrb: (type = 'shield', laneOffset = 0) =>
      this.powerupManager.spawn(type, this._shipLane() + laneOffset, 0.5),
    /**
     * Spawn one procedural row through the real spawner and report the cluster it
     * built: how many tiles, where they stand, and the boxes a collision tests.
     */
    spawnProceduralRow: () => {
      const before = this.obstacles.walls.length;
      this._spawnWall();
      const wall = this.obstacles.walls[this.obstacles.walls.length - 1];
      if (!wall || this.obstacles.walls.length === before) return null;
      return {
        ...this.lastLayout,
        laneStart: wall.laneStart,
        laneSpan: wall.laneSpan,
        blockedLanes: wall.blockedLanes.slice(),
        freeLanes: (wall.freeLanes || []).slice(),
        warnDuration: wall.warnDuration,
        solidDuration: wall.solidDuration,
        warnLength: wall.warnLength,
        width: wall.width,
        z: wall.group.position.z,
        boxes: this.obstacles.boxesFor(wall),
      };
    },
    /**
     * The hazard geometry the spawner would use right now, without spawning: how
     * many tiles a row may stand, how wide it can get, and how far ahead the
     * warning reaches.
     */
    wallTuning: (speed = Math.max(20, this.speed), difficulty = this.difficulty) => {
      const warnDuration = warningDurationAt(difficulty, speed);
      const solidDuration = solidDurationAt(difficulty);
      return {
        speed: Number(speed.toFixed(2)),
        difficulty: Number(difficulty.toFixed(3)),
        warnDuration: Number(warnDuration.toFixed(3)),
        solidDuration: Number(solidDuration.toFixed(3)),
        lookahead: Number(warningDistanceAt(difficulty, speed).toFixed(1)),
        maxTiles: WALLS.maxTiles,
        tiles: [tileCountAt(difficulty, () => 0), tileCountAt(difficulty, () => 0.999)],
        maxWidth: WALLS.maxTiles * LANES.width,
        rowDistance: Number(rowDistanceAt(difficulty, () => 0.5).toFixed(1)),
        burstDistance: Number(rowDistanceAt(difficulty, () => 0.1).toFixed(1)),
        breatherDistance: Number(rowDistanceAt(difficulty, () => 0.3).toFixed(1)),
        stripLength: Number(warningStripLengthAt(speed).toFixed(1)),
        spawnZ: Number((-(warnDuration + solidDuration) * speed).toFixed(1)),
      };
    },
    /** The world gaps the live spawner drew between its most recent rows. */
    spawnDistances: () => this.spawnDistances.slice(),
    /** The light-red → dark-red warning ramp, sampled for verification. */
    warningRamp: (samples = 5) =>
      Array.from({ length: samples + 1 }, (_, i) => {
        const p = i / samples;
        const rgb = warningColorAt(p);
        const hex = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
        return {
          progress: Number(p.toFixed(3)),
          hex: `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`,
          rgb: [Number(rgb.r.toFixed(4)), Number(rgb.g.toFixed(4)), Number(rgb.b.toFixed(4))],
        };
      }),
    /** Live warning indicator state: what colour and length is on screen now. */
    warningState: () =>
      this.obstacles.walls
        .filter((w) => w.active && w.phase === 'warn')
        .map((w) => ({
          progress: Number(this.obstacles.warningProgress.toFixed(3)),
          rgb: [w.warningColor?.r ?? -1, w.warningColor?.g ?? -1, w.warningColor?.b ?? -1],
          strip: w.warn.stripMaterial.uniforms.uColor.value.getHexString(),
          laser: w.warn.laserMaterial.color.getHexString(),
          stripLength: Number(w.warnLength.toFixed(2)),
          slots: w.segments.map((s) => ({ start: s.start, span: s.span })),
          tiles: w.tiles.filter((t) => t.active).length,
          visible: w.warn.group.visible ? 1 : 0,
        })),
    /** Slab boxes of the barriers a collision would test, for the gap test. */
    wallBoxes: () =>
      this.obstacles.walls.map((w) => ({
        phase: w.phase,
        z: Number(w.group.position.z.toFixed(2)),
        blockedLanes: (w.blockedLanes || []).slice(),
        laneStart: w.laneStart,
        laneSpan: w.laneSpan,
        tiles: w.tiles.filter((t) => t.active).length,
        popT: Number((w.popT || 0).toFixed(3)),
        slabScaleZ: Number((w.tiles[0].slab.scale.z || 1).toFixed(3)),
        boxes: this.obstacles.boxesFor(w).map((b) => ({
          cx: Number(b.cx.toFixed(3)),
          hx: Number(b.hx.toFixed(3)),
          laneStart: b.laneStart,
          laneSpan: b.laneSpan,
        })),
      })),
    /** Active power-up orbs and the lanes they occupy. */
    orbsAhead: () =>
      this.powerupManager.orbs
        .filter((o) => o.active)
        .map((o) => ({
          lane: laneIndexAt(o.group.position.x),
          z: Number(o.group.position.z.toFixed(2)),
        })),
    /** The celestial horizon: state plus where it lands on screen. */
    horizon: () => {
      const h = this.environment.horizon;
      if (!h) return null;
      this.scene.updateMatrixWorld(true);
      const world = new THREE.Vector3();
      h.core.getWorldPosition(world);
      const ndc = world.clone().project(this.camera);
      const layers = [h.rays, h.glow, h.core];
      return {
        ndc: { x: Number(ndc.x.toFixed(3)), y: Number(ndc.y.toFixed(3)) },
        renderOrder: Math.min(...layers.map((l) => l.renderOrder)),
        depthTest: layers.every((l) => l.material.depthTest === false),
        opacity: Number(h.glow.material.opacity.toFixed(3)),
        distance: HORIZON.distance,
        worldX: Number(world.x.toFixed(2)),
        cameraX: Number(this.camera.position.x.toFixed(2)),
        rays: Boolean(h.rays),
        rayOpacity: Number(h.rayMat.uniforms.uOpacity.value.toFixed(3)),
      };
    },
    config: { SHIP, LANES, SPEED, POWERUPS, WALLS, HORIZON },
  };

  /** Switch a pooled barrier straight to its solid phase (verification hook). */
  _forceSolid(wall) {
    wall.phase = 'solid';
    wall.popT = 0;
    wall.warn.group.visible = false;
    for (const tile of wall.tiles) {
      if (!tile.active) continue;
      tile.slab.visible = true;
      tile.faces.forEach((f) => {
        f.visible = true;
      });
    }
    wall.edgeMaterial.opacity = 0.75;
  }
}
