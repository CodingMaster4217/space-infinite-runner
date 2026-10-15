/**
 * Obstacles — futuristic wall barriers that sweep down the corridor.
 *
 * Every row goes through two phases:
 *   1. WARN  — a pulsing red lattice is painted on the exact lane path the wall
 *              will occupy (floor strip + laser edges + vertical warning grid).
 *              The wall itself is only a faint wireframe ghost. No collision.
 *   2. SOLID — the wall materialises and collides until it passes the ship.
 *
 * Warning length, spawn cadence and travel speed are all difficulty driven.
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
/** A barrier is at most two slabs: everything left of the gap, and right of it. */
const SLOT_COUNT = 2;

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
    float grid = max(lineMask(vUv.x, 8.0, 0.035), lineMask(vUv.y, 3.0, 0.05));
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
    this._edgeGeo = new THREE.EdgesGeometry(this._slabGeo);
    this._faceGeo = new THREE.PlaneGeometry(1, WALL_HEIGHT);
    this._stripGeo = new THREE.PlaneGeometry(1, STRIP_LENGTH);
    this._curtainGeo = new THREE.PlaneGeometry(1, WALL_HEIGHT + 1);
    this._laserGeo = new THREE.BoxGeometry(0.14, WALL_HEIGHT + 1, STRIP_LENGTH);
  }

  /* ------------------------------------------------------------------ */
  /* pooled wall construction                                            */
  /* ------------------------------------------------------------------ */

  /**
   * A barrier: up to two contiguous slabs sharing one arrival, plus the group
   * the pool keeps. The gap between the slabs is the only way through.
   */
  _createWall() {
    const group = new THREE.Group();
    const wall = {
      group,
      slots: [],
      segments: [],
      blockedLanes: [],
      gap: null,
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
    };
    for (let i = 0; i < SLOT_COUNT; i += 1) {
      const slot = this._createSlot();
      wall.slots.push(slot);
      group.add(slot.group);
    }
    return wall;
  }

  /** One contiguous slab of a barrier with its own warning indicator. */
  _createSlot() {
    const group = new THREE.Group();

    const slabMaterial = new THREE.MeshStandardMaterial({
      color: COLORS.wall,
      emissive: 0x4a0d28,
      emissiveIntensity: 0.9,
      metalness: 0.72,
      roughness: 0.42,
      transparent: true,
      opacity: 0.96,
    });
    const slab = new THREE.Mesh(this._slabGeo, slabMaterial);
    slab.position.y = WALL_HEIGHT / 2;
    group.add(slab);

    const edgeMaterial = new THREE.LineBasicMaterial({
      color: COLORS.magenta,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const edges = new THREE.LineSegments(this._edgeGeo, edgeMaterial);
    edges.position.y = WALL_HEIGHT / 2;
    group.add(edges);

    const faceFront = new THREE.Mesh(this._faceGeo, this._hazardMaterial());
    faceFront.position.set(0, WALL_HEIGHT / 2, WALL_THICKNESS / 2 + 0.03);
    group.add(faceFront);

    const faceBack = new THREE.Mesh(this._faceGeo, this._hazardMaterial());
    faceBack.position.set(0, WALL_HEIGHT / 2, -WALL_THICKNESS / 2 - 0.03);
    faceBack.rotation.y = Math.PI;
    group.add(faceBack);

    /* ---- warning indicator group ---- */
    const warn = new THREE.Group();

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
    warn.add(strip);

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
    warn.add(curtain);

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
      warn.add(laser);
      return laser;
    });

    group.add(warn);

    return {
      group,
      slab,
      slabMaterial,
      edges,
      edgeMaterial,
      faces: [faceFront, faceBack],
      warn,
      strip,
      stripMaterial,
      curtain,
      curtainMaterial,
      lasers,
      laserMaterial,
      start: 0,
      span: 1,
      width: LANES.width,
      active: true,
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
   * Place one slab on the lane line and size its warning indicator.
   * `warnLength` is the world length of the pre-wall marker, which grows with
   * speed so the warning zone reaches further down the track as the run speeds up.
   */
  _setSlot(slot, segment, warnLength) {
    const width = segment.span * LANES.width;
    slot.start = segment.start;
    slot.span = segment.span;
    slot.width = width;
    // lane n is centred at n * LANES.width, so a span starting at `start` sits at
    // the midpoint of its first and last lane
    slot.group.position.x = laneCenterX(segment.start + (segment.span - 1) / 2);
    slot.slab.scale.x = width;
    slot.slab.scale.z = 1;
    slot.edges.scale.x = width;
    slot.edges.scale.z = 1;
    slot.faces.forEach((f) => {
      f.scale.x = width;
    });
    slot.strip.scale.x = width;
    slot.strip.scale.y = warnLength / STRIP_LENGTH;
    slot.strip.position.z = STRIP_OFFSET + warnLength / 2;
    slot.curtain.scale.x = width;
    slot.lasers[0].position.x = -width / 2 - 0.08;
    slot.lasers[1].position.x = width / 2 + 0.08;
    slot.lasers.forEach((laser) => {
      laser.scale.z = warnLength / STRIP_LENGTH;
      laser.position.z = STRIP_OFFSET + warnLength / 2;
    });
  }

  /** Show the first `segments.length` slabs and hide the rest. */
  _setSegments(wall, segments, warnLength) {
    wall.segments = segments;
    wall.slots.forEach((slot, i) => {
      const segment = segments[i];
      slot.active = Boolean(segment);
      slot.group.visible = slot.active;
      if (segment) this._setSlot(slot, segment, warnLength);
    });
  }

  /* ------------------------------------------------------------------ */
  /* spawning                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * @param {object} row      result of pickWallRow()
   * @param {object} options  { difficulty, speed, warnDuration, solidDuration }
   */
  spawnRow(row, { difficulty, speed, warnDuration, solidDuration, warnLength = null }) {
    const wall = this.pool.pop() || this._createWall();
    this.group.add(wall.group);

    const segments =
      row.segments && row.segments.length
        ? row.segments
        : [{ start: row.start, span: row.span }];
    const blocked =
      row.blocked && row.blocked.length
        ? row.blocked
        : segments.flatMap((s) => Array.from({ length: s.span }, (_, i) => s.start + i));

    wall.active = true;
    wall.destroyed = false;
    wall.passed = false;
    wall.phase = 'warn';
    wall.segments = segments;
    wall.blockedLanes = blocked;
    wall.gap = row.gap || null;
    wall.laneStart = segments[0].start;
    wall.laneSpan = segments[segments.length - 1].start + segments[segments.length - 1].span - segments[0].start;
    wall.width = wall.laneSpan * LANES.width;
    wall.freeLanes = row.free;
    wall.warnDuration = warnDuration;
    wall.solidDuration = solidDuration;
    wall.warnLength = warnLength ?? STRIP_LENGTH;
    wall.popT = 0;
    wall.alarmRepeat = 0;

    // the barrier group stays on the world axis; each slab carries its own x
    wall.group.position.set(0, 0, -(warnDuration + solidDuration) * speed);
    wall.prevZ = wall.group.position.z;
    this._setSegments(wall, segments, wall.warnLength);

    for (const slot of wall.slots) {
      slot.warn.visible = slot.active;
      slot.slab.visible = false;
      slot.lasers.forEach((l) => {
        l.visible = true;
      });
      slot.faces.forEach((f) => {
        f.visible = false;
      });
      slot.edgeMaterial.opacity = 0.3;
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
        // Light red eases into dark red and finally deepest red as the barrier
        // lands, so the indicator tells the player how long is left without
        // having to read the timing.
        const rgb = warningColorAt(p);
        wall.warningColor = rgb;
        for (const slot of wall.slots) {
          if (!slot.active) continue;
          slot.stripMaterial.uniforms.uTime.value = this.time;
          slot.stripMaterial.uniforms.uProgress.value = p;
          slot.stripMaterial.uniforms.uColor.value.setRGB(rgb.r, rgb.g, rgb.b);
          slot.curtainMaterial.uniforms.uTime.value = this.time;
          slot.curtainMaterial.uniforms.uProgress.value = p;
          slot.curtainMaterial.uniforms.uColor.value.setRGB(rgb.r, rgb.g, rgb.b);
          slot.edgeMaterial.color.setRGB(rgb.r, rgb.g, rgb.b);
          slot.edgeMaterial.opacity = 0.22 + p * 0.24;
          slot.laserMaterial.color.setRGB(
            Math.min(1, rgb.r + 0.12 * p),
            rgb.g,
            rgb.b
          );
          slot.laserMaterial.opacity = 0.35 + 0.55 * p;
          slot.warn.visible = true;
          slot.slab.visible = false;
          slot.faces.forEach((f) => {
            f.visible = false;
          });
          slot.lasers.forEach((l) => {
            l.scale.y = 1 + Math.sin(this.time * (9 + p * 12)) * 0.04;
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
        for (const slot of wall.slots) {
          if (!slot.active) continue;
          slot.faces.forEach((f) => {
            f.material.uniforms.uTime.value = this.time;
          });
          slot.slabMaterial.emissiveIntensity = 0.8 + Math.sin(this.time * 6) * 0.18 + pop * 3.4;
          // brief swell on impact: the barrier visually "pops" solid, its edges
          // flashing white-hot before cooling back to the neon outline
          slot.slab.scale.z = 1 + pop * 0.55;
          slot.edges.scale.z = 1 + pop * 0.55;
          slot.edgeMaterial.color.setRGB(1, 0.247 + 0.753 * pop, 0.82 + 0.18 * pop);
          slot.edgeMaterial.opacity = 0.75 + 0.2 * pop;
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
    for (const slot of wall.slots) {
      if (!slot.active) continue;
      slot.warn.visible = false;
      slot.slab.visible = true;
      // start the pop on the very frame the slab lands
      slot.slab.scale.z = 1 + 0.55;
      slot.edges.scale.z = 1.55;
      slot.faces.forEach((f) => {
        f.visible = true;
      });
      slot.edgeMaterial.color.setRGB(1, 1, 1);
      slot.edgeMaterial.opacity = 0.95;
    }
    // the pop: a hot flash + shockwave at every slab that just became solid
    const z = wall.group.position.z;
    for (const segment of wall.segments) {
      const cx = laneCenterX(segment.start + (segment.span - 1) / 2);
      const width = segment.span * LANES.width;
      if (this.shockwavePool) {
        this.shockwavePool.fire(new THREE.Vector3(cx, WALL_HEIGHT / 2, z + WALL_THICKNESS / 2), {
          color: COLORS.red,
          size: 14,
          life: 0.45,
        });
      }
      if (this.burstPool) {
        this.burstPool.spawn(new THREE.Vector3(cx, WALL_HEIGHT / 2, z + WALL_THICKNESS / 2), {
          amount: 14,
          speed: 11,
          life: 0.32,
          size: 1.3,
          color: 0xffdede,
          colorVariance: 0.4,
          spread: 0.6,
          drag: 2.2,
        });
      }
    }
    this.onMaterialise(wall);
  }

  /** Shatter a wall (used when the player is invincible). */
  destroy(wall, { color = COLORS.cyan } = {}) {
    if (!wall.active || wall.destroyed) return;
    wall.destroyed = true;
    const p = wall.group.position;
    if (this.burstPool) {
      const count = Math.max(14, wall.laneSpan * 12);
      for (const segment of wall.segments) {
        const cx = laneCenterX(segment.start + (segment.span - 1) / 2);
        const width = segment.span * LANES.width;
        for (let i = 0; i < 3; i += 1) {
          this.burstPool.spawn(
            new THREE.Vector3(
              cx + (Math.random() - 0.5) * width,
              0.4 + Math.random() * WALL_HEIGHT,
              p.z + (Math.random() - 0.5) * WALL_THICKNESS
            ),
            {
              amount: Math.max(6, Math.ceil(count / 3)),
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
      for (const segment of wall.segments) {
        const cx = laneCenterX(segment.start + (segment.span - 1) / 2);
        this.shockwavePool.fire(new THREE.Vector3(cx, WALL_HEIGHT / 2, p.z), {
          color,
          size: 18,
          life: 0.5,
        });
      }
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
   * Axis-aligned collision boxes for a wall — one per slab, so the gap really is
   * open. A full-width row with a hole in it is *not* one big box.
   */
  boxesFor(wall) {
    const z = wall.group.position.z;
    const prevZ = wall.prevZ ?? z;
    // Swept box: a barrier moving several units per frame (a boosted run covers
    // over 6 world units per step) must not pass through the ship between frames,
    // or a shielded or invincible player would slip through a wall untouched.
    const travel = Math.abs(z - prevZ);
    const cz = (z + prevZ) / 2;
    const boxes = [];
    for (const slot of wall.slots) {
      if (!slot.active) continue;
      boxes.push({
        cx: slot.group.position.x,
        cy: WALL_HEIGHT / 2,
        cz,
        hx: slot.width / 2,
        hy: WALL_HEIGHT / 2,
        hz: WALL_THICKNESS / 2 + travel / 2,
        laneStart: slot.start,
        laneSpan: slot.span,
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
      solid: 1.05 - 0.35 * difficulty,
    };
  }
}
