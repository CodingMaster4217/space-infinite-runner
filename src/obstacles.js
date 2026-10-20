/**
 * Obstacles — clusters of wall tiles that sweep down the corridor.
 *
 * A row is a *cluster*: one tile per lane, at most `WALLS.maxTiles` of them
 * standing side by side, laid down near the lane the ship is heading for. Every
 * row goes through two phases:
 *   1. WARN  — a pulsing red lattice is painted on the exact lane path the cluster
 *              will occupy (floor strip + laser edges + vertical warning grid).
 *              The tiles themselves are only faint wireframe ghosts. No collision.
 *   2. SOLID — the tiles materialise and collide until they pass the ship.
 *
 * Warning length, row width, spawn cadence and travel speed are all difficulty
 * driven, and the row width and spacing are drawn chaotically per row.
 */

import * as THREE from 'three';
import { COLORS, CORRIDOR, DIFFICULTY, LANES, WALLS, laneCenterX } from './config.js';
import { warningColorAt } from './collision.js';
import { clamp } from './utils.js';

/** Slab profile — one source of truth for the mesh and the collision sweep. */
const WALL_HEIGHT = WALLS.size.height;
const WALL_THICKNESS = WALLS.size.thickness;
const STRIP_LENGTH = 30;
const STRIP_OFFSET = 1.2; // strip starts just in front of the wall faces
/** A row never stands more than this many tiles side by side. */
const MAX_TILES = WALLS.maxTiles;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CURTAIN_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uProgress;
  uniform vec3 uColor;
  varying vec2 vUv;

  float lineMask(float u, float count, float width) {
    float f = fract(u * count);
    float d = min(f, 1.0 - f);
    return 1.0 - smoothstep(0.0, width, d);
  }

  void main() {
    float gx = lineMask(vUv.x, 6.0, 0.05);
    float gy = lineMask(vUv.y - uTime * 0.42, 4.0, 0.07);
    float grid = max(gx, gy);
    float scanY = fract(vUv.y * 2.0 - uTime * 1.15);
    float scan = pow(1.0 - scanY, 6.0);
    float pulse = 0.5 + 0.5 * sin(uTime * (7.0 + uProgress * 11.0));
    float edgeFade = smoothstep(0.0, 0.12, vUv.x) * (1.0 - smoothstep(0.88, 1.0, vUv.x));
    float alpha = (grid * 0.55 + scan * 0.5 + 0.06) * (0.35 + 0.65 * pulse) * (0.4 + 0.6 * uProgress) * edgeFade;
    gl_FragColor = vec4(uColor * (0.85 + pulse * 0.8), clamp(alpha, 0.0, 1.0));
  }
`;

const STRIP_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uProgress;
  uniform vec3 uColor;
  varying vec2 vUv;

  void main() {
    float b = fract(vUv.y * 7.0 + uTime * 2.1 * (0.5 + uProgress));
    float band = pow(1.0 - b, 5.0);
    float side = smoothstep(0.44, 0.5, abs(vUv.x - 0.5));
    float centre = 1.0 - smoothstep(0.0, 0.035, abs(vUv.x - 0.5));
    float along = smoothstep(0.0, 0.28, vUv.y);
    float pulse = 0.4 + 0.6 * sin(uTime * (8.0 + uProgress * 12.0));
    float alpha = (band * 0.5 + side * 0.8 + centre * 0.55) * (0.35 + 0.65 * pulse) * along * (0.4 + 0.6 * uProgress);
    gl_FragColor = vec4(uColor * (0.9 + pulse * 0.7), clamp(alpha, 0.0, 1.0));
  }
`;

const HAZARD_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform vec3 uColorB;
  varying vec2 vUv;

  float lineMask(float u, float count, float width) {
    float f = fract(u * count);
    float d = min(f, 1.0 - f);
    return 1.0 - smoothstep(0.0, width, d);
  }

  void main() {
    float stripe = step(0.5, fract((vUv.x * 1.6 + vUv.y) * 5.0));
    float grid = max(lineMask(vUv.x, 3.0, 0.05), lineMask(vUv.y, 3.0, 0.05));
    float sweep = pow(1.0 - fract(vUv.y * 1.5 - uTime * 0.8), 4.0);
    vec3 col = mix(uColor, uColorB, stripe * 0.65) + grid * 0.9 + sweep * 0.6;
    float alpha = 0.34 + grid * 0.4 + sweep * 0.3 + stripe * 0.1;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`;

export class ObstacleManager {
  constructor(scene, { burstPool, shockwavePool, onWarning = () => {}, onMaterialise = () => {} } = {}) {
    this.scene = scene;
    this.burstPool = burstPool;
    this.shockwavePool = shockwavePool;
    this.onWarning = onWarning;
    this.onMaterialise = onMaterialise;

    this.group = new THREE.Group();
    scene.add(this.group);

    this.pool = [];
    this.walls = [];
    this.time = 0;
    this.warningActive = false;
    this.warningProgress = 0;

    this._slabGeo = new THREE.BoxGeometry(1, WALL_HEIGHT, WALL_THICKNESS);
    this._faceGeo = new THREE.PlaneGeometry(1, WALL_HEIGHT);
    this._stripGeo = new THREE.PlaneGeometry(1, STRIP_LENGTH);
    this._curtainGeo = new THREE.PlaneGeometry(1, WALL_HEIGHT + 1);
    this._laserGeo = new THREE.BoxGeometry(0.14, WALL_HEIGHT + 1, STRIP_LENGTH);
  }

  /* ------------------------------------------------------------------ */
  /* pooled wall construction                                            */
  /* ------------------------------------------------------------------ */

  /**
   * A row: `MAX_TILES` pooled tiles (only the active ones are shown) sharing one
   * set of materials, plus the single warning indicator that spans the cluster.
   */
  _createWall() {
    const group = new THREE.Group();

    // shared per wall: a cluster is one object to the renderer, however many
    // tiles stand in it
    const slabMaterial = new THREE.MeshStandardMaterial({
      color: COLORS.wall,
      emissive: 0x4a0d28,
      emissiveIntensity: 0.9,
      metalness: 0.72,
      roughness: 0.42,
      transparent: true,
      opacity: 0.96,
    });
    const hazardMaterial = this._hazardMaterial();

    const wall = {
      group,
      tiles: [],
      segments: [],
      blockedLanes: [],
      freeLanes: null,
      active: false,
      destroyed: false,
      passed: false,
      phase: 'idle',
      laneStart: 0,
      laneSpan: 1,
      width: LANES.width,
      warnDuration: 1,
      solidDuration: 1,
      warnLength: STRIP_LENGTH,
      popT: 0,
      ttImpact: 0,
      alarmRepeat: 0,
      slabMaterial,
      hazardMaterial,
    };

    for (let i = 0; i < MAX_TILES; i += 1) {
      const tile = this._createTile(wall);
      wall.tiles.push(tile);
      group.add(tile.group);
    }

    wall.warn = this._createWarning();
    group.add(wall.warn.group);
    return wall;
  }

  /** One lane-wide wall tile (the unit the "at most five side by side" cap counts). */
  _createTile(wall) {
    const group = new THREE.Group();

    const slab = new THREE.Mesh(this._slabGeo, wall.slabMaterial);
    slab.position.y = WALL_HEIGHT / 2;
    group.add(slab);

    const faceFront = new THREE.Mesh(this._faceGeo, wall.hazardMaterial);
    faceFront.position.set(0, WALL_HEIGHT / 2, WALL_THICKNESS / 2 + 0.03);
    group.add(faceFront);

    const faceBack = new THREE.Mesh(this._faceGeo, wall.hazardMaterial);
    faceBack.position.set(0, WALL_HEIGHT / 2, -WALL_THICKNESS / 2 - 0.03);
    faceBack.rotation.y = Math.PI;
    group.add(faceBack);

    return {
      group,
      slab,
      faces: [faceFront, faceBack],
      lane: 0,
      width: LANES.width,
      active: false,
    };
  }

  /** The warning indicator: floor strip, curtain grid and the two edge lasers. */
  _createWarning() {
    const group = new THREE.Group();

    const stripMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uProgress: { value: 0 },
        uColor: { value: new THREE.Color(COLORS.red) },
      },
      vertexShader: VERT,
      fragmentShader: STRIP_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const strip = new THREE.Mesh(this._stripGeo, stripMaterial);
    strip.rotation.x = -Math.PI / 2;
    strip.rotation.z = Math.PI;
    strip.position.set(0, 0.04, STRIP_OFFSET + STRIP_LENGTH / 2);
    group.add(strip);

    const curtainMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uProgress: { value: 0 },
        uColor: { value: new THREE.Color(COLORS.red) },
      },
      vertexShader: VERT,
      fragmentShader: CURTAIN_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const curtain = new THREE.Mesh(this._curtainGeo, curtainMaterial);
    curtain.position.set(0, (WALL_HEIGHT + 1) / 2, 0.06);
    group.add(curtain);

    const laserMaterial = new THREE.MeshBasicMaterial({
      color: COLORS.red,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const lasers = [-1, 1].map((dir) => {
      const laser = new THREE.Mesh(this._laserGeo, laserMaterial);
      laser.position.set(dir * 2, (WALL_HEIGHT + 1) / 2, STRIP_OFFSET + STRIP_LENGTH / 2);
      group.add(laser);
      return laser;
    });

    return {
      group,
      strip,
      stripMaterial,
      curtain,
      curtainMaterial,
      lasers,
      laserMaterial,
    };
  }

  _hazardMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(COLORS.red) },
        uColorB: { value: new THREE.Color(COLORS.magenta) },
      },
      vertexShader: VERT,
      fragmentShader: HAZARD_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  }

  /**
   * Lay a cluster out on the lane line: one visible tile per lane (each shrunk by
   * `WALLS.seam` so neighbours read as separate walls) and one warning indicator
   * spanning the whole row.
   */
  _layout(wall, segment, warnLength) {
    const span = clamp(Math.round(segment.span), 1, MAX_TILES);
    const start = Math.round(segment.start);
    const rowWidth = span * LANES.width;
    const tileWidth = Math.max(0.5, LANES.width - WALLS.seam);

    wall.tiles.forEach((tile, i) => {
      const active = i < span;
      tile.active = active;
      tile.group.visible = active;
      if (!active) return;
      tile.lane = start + i;
      tile.width = tileWidth;
      tile.group.position.x = laneCenterX(start + i);
      tile.slab.scale.set(tileWidth, 1, 1);
      tile.faces.forEach((f) => {
        f.scale.x = tileWidth;
      });
    });

    const warn = wall.warn;
    warn.group.position.x = laneCenterX(start + (span - 1) / 2);
    warn.strip.scale.x = rowWidth;
    warn.strip.scale.y = warnLength / STRIP_LENGTH;
    warn.strip.position.z = STRIP_OFFSET + warnLength / 2;
    warn.curtain.scale.x = rowWidth;
    warn.lasers[0].position.x = -rowWidth / 2 - 0.08;
    warn.lasers[1].position.x = rowWidth / 2 + 0.08;
    warn.lasers.forEach((laser) => {
      laser.scale.z = warnLength / STRIP_LENGTH;
      laser.position.z = STRIP_OFFSET + warnLength / 2;
    });
  }

  /* ------------------------------------------------------------------ */
  /* spawning                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * @param {object} row      result of pickTileRow() / selectFairRow().row
   * @param {object} options  { difficulty, speed, warnDuration, solidDuration }
   */
  spawnRow(row, { difficulty, speed, warnDuration, solidDuration, warnLength = null }) {
    const wall = this.pool.pop() || this._createWall();
    this.group.add(wall.group);

    const segment =
      row.segments && row.segments.length ? row.segments[0] : { start: row.start, span: row.span };
    const blocked =
      row.blocked && row.blocked.length
        ? row.blocked
        : Array.from({ length: segment.span }, (_, i) => segment.start + i);

    wall.active = true;
    wall.destroyed = false;
    wall.passed = false;
    wall.phase = 'warn';
    wall.segments = [segment];
    wall.blockedLanes = blocked.slice();
    wall.freeLanes = row.free ? row.free.slice() : null;
    wall.laneStart = segment.start;
    wall.laneSpan = segment.span;
    wall.width = segment.span * LANES.width;
    wall.warnDuration = warnDuration;
    wall.solidDuration = solidDuration;
    wall.warnLength = warnLength ?? STRIP_LENGTH;
    wall.popT = 0;
    wall.alarmRepeat = 0;

    // the cluster group stays on the world axis; each tile carries its own x
    wall.group.position.set(0, 0, -(warnDuration + solidDuration) * speed);
    wall.prevZ = wall.group.position.z;
    this._layout(wall, segment, wall.warnLength);

    wall.warn.group.visible = true;
    for (const tile of wall.tiles) {
      tile.slab.visible = false;
      tile.slab.scale.z = 1;
      tile.faces.forEach((f) => {
        f.visible = false;
      });
    }

    this.walls.push(wall);
    this.onWarning(wall, { difficulty, row });
    return wall;
  }

  /* ------------------------------------------------------------------ */

  consumeWarningEvent(wall, amount = 0.9) {
    wall.alarmRepeat -= amount;
    if (wall.alarmRepeat <= 0) {
      wall.alarmRepeat = 0.85;
      return true;
    }
    return false;
  }

  update(dt, { travel = 0, speed = 1 } = {}) {
    this.time += dt;
    let warningActive = false;
    let warningProgress = 0;

    for (const wall of this.walls) {
      if (!wall.active) continue;
      wall.prevZ = wall.group.position.z;
      wall.group.position.z += travel;
      const z = wall.group.position.z;
      wall.ttImpact = Math.max(0, -z / Math.max(speed, 1));

      if (wall.phase === 'warn') {
        const p = clamp(1 - (wall.ttImpact - wall.solidDuration) / Math.max(0.05, wall.warnDuration), 0, 1);
        // Light red eases into dark red and finally deepest red as the cluster
        // lands, so the indicator tells the player how long is left without
        // having to read the timing.
        const rgb = warningColorAt(p);
        wall.warningColor = rgb;

        const warn = wall.warn;
        warn.stripMaterial.uniforms.uTime.value = this.time;
        warn.stripMaterial.uniforms.uProgress.value = p;
        warn.stripMaterial.uniforms.uColor.value.setRGB(rgb.r, rgb.g, rgb.b);
        warn.curtainMaterial.uniforms.uTime.value = this.time;
        warn.curtainMaterial.uniforms.uProgress.value = p;
        warn.curtainMaterial.uniforms.uColor.value.setRGB(rgb.r, rgb.g, rgb.b);
        warn.laserMaterial.color.setRGB(Math.min(1, rgb.r + 0.12 * p), rgb.g, rgb.b);
        warn.laserMaterial.opacity = 0.35 + 0.55 * p;
        warn.group.visible = true;
        warn.lasers.forEach((l) => {
          l.scale.y = 1 + Math.sin(this.time * (9 + p * 12)) * 0.04;
        });

        for (const tile of wall.tiles) {
          if (!tile.active) continue;
          tile.slab.visible = false;
          tile.faces.forEach((f) => {
            f.visible = false;
          });
        }

        warningActive = true;
        warningProgress = Math.max(warningProgress, p);

        if (wall.ttImpact <= wall.solidDuration) {
          this._materialise(wall);
        }
      } else if (wall.phase === 'solid') {
        if (wall.popT > 0) wall.popT = Math.max(0, wall.popT - dt);
        const pop = wall.popT / WALLS.pop; // 1 → 0 across the burst
        wall.slabMaterial.emissiveIntensity = 0.8 + Math.sin(this.time * 6) * 0.18 + pop * 3.4;
        wall.hazardMaterial.uniforms.uTime.value = this.time;
        for (const tile of wall.tiles) {
          if (!tile.active) continue;
          // brief swell on impact: the cluster visually "pops" solid and then
          // settles back to its resting depth
          tile.slab.scale.z = 1 + pop * 0.55;
        }

        if (z > CORRIDOR.despawnZ) {
          this._release(wall);
          continue;
        }
        if (z > 3.5) wall.passed = true;
      }
    }

    this.warningActive = warningActive;
    this.warningProgress = warningProgress;
  }

  _materialise(wall) {
    wall.phase = 'solid';
    wall.popT = WALLS.pop;
    wall.warn.group.visible = false;

    const z = wall.group.position.z;
    for (const tile of wall.tiles) {
      if (!tile.active) continue;
      tile.slab.visible = true;
      // start the pop on the very frame the tile lands
      tile.slab.scale.z = 1.55;
      tile.faces.forEach((f) => {
        f.visible = true;
      });
      if (this.burstPool) {
        this.burstPool.spawn(
          new THREE.Vector3(laneCenterX(tile.lane), WALL_HEIGHT / 2, z + WALL_THICKNESS / 2),
          {
            amount: 8,
            speed: 10,
            life: 0.3,
            size: 1.1,
            color: 0xffdede,
            colorVariance: 0.4,
            spread: 0.5,
            drag: 2.2,
          }
        );
      }
    }

    // one shockwave per cluster, not per tile: the row lands as one obstacle
    if (this.shockwavePool) {
      this.shockwavePool.fire(
        new THREE.Vector3(laneCenterX(wall.laneStart + (wall.laneSpan - 1) / 2), WALL_HEIGHT / 2, z + WALL_THICKNESS / 2),
        { color: COLORS.red, size: 12, life: 0.45 }
      );
    }
    this.onMaterialise(wall);
  }

  /** Shatter a wall (used when the player is invincible). */
  destroy(wall, { color = COLORS.cyan } = {}) {
    if (!wall.active || wall.destroyed) return;
    wall.destroyed = true;
    const p = wall.group.position;

    if (this.burstPool) {
      for (const tile of wall.tiles) {
        if (!tile.active) continue;
        const cx = laneCenterX(tile.lane);
        for (let i = 0; i < 2; i += 1) {
          this.burstPool.spawn(
            new THREE.Vector3(
              cx + (Math.random() - 0.5) * tile.width,
              0.4 + Math.random() * WALL_HEIGHT,
              p.z + (Math.random() - 0.5) * WALL_THICKNESS
            ),
            {
              amount: 9,
              speed: 16,
              life: 0.9,
              size: 1.2,
              color: i % 2 === 0 ? color : COLORS.magenta,
              colorVariance: 0.5,
              spread: 0.5,
              drag: 1.4,
            }
          );
        }
      }
    }
    if (this.shockwavePool) {
      this.shockwavePool.fire(
        new THREE.Vector3(laneCenterX(wall.laneStart + (wall.laneSpan - 1) / 2), WALL_HEIGHT / 2, p.z),
        { color, size: 16, life: 0.5 }
      );
    }
    this._release(wall);
  }

  _release(wall) {
    wall.active = false;
    wall.phase = 'idle';
    this.group.remove(wall.group);
    this.pool.push(wall);
    const i = this.walls.indexOf(wall);
    if (i >= 0) this.walls.splice(i, 1);
  }

  /** Walls that can currently collide with the player. */
  collidable() {
    return this.walls.filter(
      (w) =>
        w.active &&
        w.phase === 'solid' &&
        !w.destroyed &&
        (Math.abs(w.group.position.z) < 6 || Math.abs(w.prevZ ?? w.group.position.z) < 6)
    );
  }

  /**
   * Axis-aligned collision boxes for a cluster — one per visible tile, so the
   * space beside the row really is open.
   */
  boxesFor(wall) {
    const z = wall.group.position.z;
    const prevZ = wall.prevZ ?? z;
    // Swept box: a row moving several units per frame (a boosted run covers over
    // 6 world units per step) must not pass through the ship between frames, or a
    // shielded or invincible player would slip through untouched.
    const travel = Math.abs(z - prevZ);
    const cz = (z + prevZ) / 2;
    const boxes = [];
    for (const tile of wall.tiles) {
      if (!tile.active) continue;
      boxes.push({
        cx: laneCenterX(tile.lane),
        cy: WALL_HEIGHT / 2,
        cz,
        hx: tile.width / 2,
        hy: WALL_HEIGHT / 2,
        hz: WALL_THICKNESS / 2 + travel / 2,
        laneStart: tile.lane,
        laneSpan: 1,
      });
    }
    return boxes;
  }

  reset() {
    for (const wall of [...this.walls]) this._release(wall);
    this.walls.length = 0;
    this.time = 0;
    this.warningActive = false;
    this.warningProgress = 0;
  }

  /** Highest difficulty multiplier applied to warning/spawn timings. */
  static timings(difficulty) {
    return {
      warn: DIFFICULTY.warning.start - (DIFFICULTY.warning.start - DIFFICULTY.warning.end) * Math.pow(difficulty, 0.85),
      solid: 0.8 - 0.26 * difficulty,
    };
  }
}
