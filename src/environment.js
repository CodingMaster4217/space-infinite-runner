/**
 * Environment — the Rift itself: deep starfield, streak field, nebula backdrop
 * and the endless scrolling ground plane (world-space lane grid, drifting debris
 * field). There are no left/right borders: the plane, the starfields and the
 * backdrop all follow the camera, so the world has no edges in any direction.
 */

import * as THREE from 'three';
import { COLORS, CORRIDOR, HORIZON, LANES } from './config.js';
import { clamp } from './utils.js';
import { makeGlowTexture, makeSprite } from './vfx.js';

const STAR_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlpha;
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha * uOpacity;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const STAR_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(vColor, vAlpha);
  }
`;

const POINT_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlpha;
  attribute float aSize;
  uniform float uPixelRatio;
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha * uOpacity;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.0, aSize * uPixelRatio * (300.0 / max(1.0, -mv.z)));
  }
`;

const POINT_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.08, d);
    gl_FragColor = vec4(vColor, a * vAlpha);
  }
`;

const FLOOR_FRAG = /* glsl */ `
  uniform float uOffset;
  uniform float uTime;
  uniform float uLaneWidth;
  uniform float uSpeedNorm;
  uniform float uBoost;
  uniform float uCamZ;
  uniform vec3 uGridColor;
  uniform vec3 uLaneColor;
  uniform vec3 uDangerColor;
  uniform float uDanger;
  varying vec3 vWorld;

  float lineMask(float coord, float period, float width) {
    float d = abs(fract(coord / period) - 0.5) * period;
    return 1.0 - smoothstep(0.0, width, d);
  }

  void main() {
    float x = vWorld.x;
    float relZ = vWorld.z - uCamZ;
    float along = vWorld.z - uOffset;

    float gz = lineMask(along, 8.0, 0.18);
    float gx = lineMask(x, uLaneWidth, 0.045);
    float grid = clamp(gz * 0.5 + gx * 0.28, 0.0, 1.0);

    // Lane guides run forever in both directions: no corridor edge exists, the
    // pattern is evaluated in world space so the plane can be re-centred on the
    // camera without the lines ever sliding.
    float laneMask = lineMask(x + uLaneWidth * 0.5, uLaneWidth, 0.075);

    float pulse = 0.84 + 0.16 * sin(uTime * 2.4 - vWorld.z * 0.06);
    vec3 laneColour = mix(uLaneColor, uDangerColor, uDanger);

    vec3 col = uGridColor * grid + laneColour * laneMask * 0.9 * pulse;

    float fade = (1.0 - smoothstep(170.0, 330.0, abs(relZ))) * smoothstep(0.0, 30.0, abs(relZ) + 8.0);
    float alpha = (grid * 0.32 + laneMask * 0.5) * fade;
    alpha *= 0.85 + uSpeedNorm * 0.4 + uBoost * 0.35 + uDanger * 0.4;
    col *= 0.9 + uSpeedNorm * 0.45 + uBoost * 0.45;

    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`;

const FLOOR_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const VERT_UV = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The horizon target: light rays fanning out of the core, tightening corona
 * rings and a soft halo. Every ray passes through the centre, so the whole field
 * reads as converging on the point the ship is flying towards.
 */
const HORIZON_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uPulse;
  uniform float uOpacity;
  uniform vec3 uCoreColor;
  uniform vec3 uRayColor;
  varying vec2 vUv;

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    p.y *= 0.62;
    float r = clamp(length(p), 0.0, 1.0);
    float ang = atan(p.y, p.x);

    // slow-rotating spokes, all radiating from the core
    float spokes = sin(ang * 9.0 + uTime * 0.22);
    float ray = pow(max(0.0, spokes), 6.0) * pow(1.0 - r, 2.2);

    float rings = 0.0;
    for (int i = 0; i < 3; i++) {
      float rr = 0.15 + float(i) * 0.105 + sin(uTime * 0.9 + float(i) * 1.7) * 0.012;
      float w = 0.006 + float(i) * 0.004;
      rings += (1.0 - smoothstep(0.0, w, abs(r - rr))) * (0.55 - float(i) * 0.13);
    }

    float halo = pow(1.0 - r, 3.2) * 0.55;
    float alpha = (ray * 0.45 + rings * 0.7 + halo) * (0.55 + uPulse * 0.8) * uOpacity;
    vec3 col = mix(uRayColor, uCoreColor, pow(1.0 - r, 3.0));
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * Procedural nebula cloud baked once into a canvas texture.
 * Baking keeps the backdrop at a single texture fetch per pixel instead of
 * evaluating layered noise in the fragment shader every frame.
 */
export function makeNebulaTexture({ size = 256, seed = 1, colorA = '#2a0d5e', colorB = '#ff3fd1' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const a = new THREE.Color(colorA);
  const b = new THREE.Color(colorB);

  const hash = (x, y) => {
    const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
    return s - Math.floor(s);
  };
  const noise = (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const n00 = hash(xi, yi);
    const n10 = hash(xi + 1, yi);
    const n01 = hash(xi, yi + 1);
    const n11 = hash(xi + 1, yi + 1);
    return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      let n = noise(u * 4.0, v * 4.0) * 0.6;
      n += noise(u * 9.0 + 3.1, v * 9.0 - 1.7) * 0.28;
      n += noise(u * 18.0 - 5.3, v * 18.0 + 2.3) * 0.16;
      n /= 1.04;

      const cx = (u - 0.5) * 2;
      const cy = (v - 0.5) * 2;
      const mask = Math.max(0, 1 - Math.sqrt(cx * cx * 1.0 + cy * cy * 1.9));
      const alpha = Math.pow(Math.max(0, n), 1.8) * mask * mask * 255;
      const t = Math.min(1, Math.max(0, (n - 0.18) / 0.7));

      const i = (y * size + x) * 4;
      image.data[i] = (a.r + (b.r - a.r) * t) * 255;
      image.data[i + 1] = (a.g + (b.g - a.g) * t) * 255;
      image.data[i + 2] = (a.b + (b.b - a.b) * t) * 255;
      image.data[i + 3] = alpha;
    }
  }

  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export class Environment {
  constructor(scene) {
    this.scene = scene;
    this.offset = 0;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.speedNorm = 0;
    this.boost = 0;
    this.time = 0;
    this._tmp = new THREE.Object3D();
    this._color = new THREE.Color();
    this._dir = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this.group = new THREE.Group();
    scene.add(this.group);

    // distant backdrop (nebula + glows) lives in its own group so it can follow
    // the camera laterally and stay behind the ship wherever it flies
    this.backdrop = new THREE.Group();
    this.group.add(this.backdrop);

    this._buildLights();
    this._buildStarfield();
    this._buildNebula();
    this._buildHorizon();
    this._buildCorridor();
    this._buildPylons();
  }

  /* ------------------------------------------------------------------ */

  _buildLights() {
    const ambient = new THREE.AmbientLight(0x2a4a7a, 0.75);
    this.scene.add(ambient);

    const key = new THREE.DirectionalLight(0xbfe6ff, 1.5);
    key.position.set(-6, 12, 7);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0xff5fd8, 0.8);
    rim.position.set(9, -4, -12);
    this.scene.add(rim);

    const corridorLight = new THREE.PointLight(COLORS.cyan, 260, 190, 1.7);
    corridorLight.position.set(0, 7, -26);
    this.scene.add(corridorLight);
    this.corridorLight = corridorLight;

    const abyssLight = new THREE.PointLight(COLORS.violet, 190, 150, 1.7);
    abyssLight.position.set(0, 3, -110);
    this.scene.add(abyssLight);
    this.abyssLight = abyssLight;

    this.ambient = ambient;
  }

  _buildStarfield() {
    /* --- deep round stars (Points) ------------------------------------ */
    const deepCount = 1500;
    const positions = new Float32Array(deepCount * 3);
    const colors = new Float32Array(deepCount * 3);
    const sizes = new Float32Array(deepCount);
    const alphas = new Float32Array(deepCount);
    const speeds = new Float32Array(deepCount);
    this.deepStars = { positions, speeds, count: deepCount, colors };

    const palette = [0xffffff, 0xbfe9ff, 0xffd9f6, 0xc9c2ff, 0x9df5ff];
    for (let i = 0; i < deepCount; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * 620;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 380;
      positions[i * 3 + 2] = -Math.random() * 900 + 20;
      const c = this._color.set(palette[(Math.random() * palette.length) | 0]);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
      sizes[i] = 0.6 + Math.random() * 1.9;
      alphas[i] = 0.35 + Math.random() * 0.65;
      speeds[i] = 0.4 + Math.random() * 0.45;
    }

    const deepGeo = new THREE.BufferGeometry();
    deepGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    deepGeo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    deepGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    deepGeo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    deepGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const deepMat = new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: this.pixelRatio },
        uOpacity: { value: 1 },
      },
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.deepPoints = new THREE.Points(deepGeo, deepMat);
    this.deepPoints.frustumCulled = false;
    this.group.add(this.deepPoints);

    /* --- near streak field (LineSegments) ---------------------------- */
    const streakCount = 900;
    const sPos = new Float32Array(streakCount * 6);
    const sCol = new Float32Array(streakCount * 6);
    const sAlpha = new Float32Array(streakCount * 2);
    const sSpeed = new Float32Array(streakCount);

    for (let i = 0; i < streakCount; i += 1) {
      const x = (Math.random() - 0.5) * 190;
      const y = (Math.random() - 0.5) * 120;
      const z = -Math.random() * 520 + 12;
      sPos[i * 6] = x;
      sPos[i * 6 + 1] = y;
      sPos[i * 6 + 2] = z;
      sPos[i * 6 + 3] = x;
      sPos[i * 6 + 4] = y;
      sPos[i * 6 + 5] = z - 1;
      const c = this._color.set(palette[(Math.random() * palette.length) | 0]);
      for (let v = 0; v < 2; v += 1) {
        sCol[i * 6 + v * 3] = c.r;
        sCol[i * 6 + v * 3 + 1] = c.g;
        sCol[i * 6 + v * 3 + 2] = c.b;
      }
      sAlpha[i * 2] = 0.15 + Math.random() * 0.5;
      sAlpha[i * 2 + 1] = 0.02;
      sSpeed[i] = 0.75 + Math.random() * 0.55;
    }

    const streakGeo = new THREE.BufferGeometry();
    streakGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    streakGeo.setAttribute('aColor', new THREE.BufferAttribute(sCol, 3));
    streakGeo.setAttribute('aAlpha', new THREE.BufferAttribute(sAlpha, 1));
    streakGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const streakMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 1 } },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.streaks = new THREE.LineSegments(streakGeo, streakMat);
    this.streaks.frustumCulled = false;
    this.streakData = { positions: sPos, colors: sCol, alpha: sAlpha, speeds: sSpeed, count: streakCount };
    this.group.add(this.streaks);
  }

  _buildNebula() {
    this.nebula = [];
    const configs = [
      { w: 1100, h: 700, z: -520, colorA: '#2a0d5e', colorB: '#ff3fd1', opacity: 0.5, rot: 0, seed: 11 },
      { w: 900, h: 620, z: -680, colorA: '#062b4d', colorB: '#3ff2ff', opacity: 0.44, rot: 0.6, seed: 27 },
      { w: 780, h: 560, z: -840, colorA: '#3a1250', colorB: '#8c5cff', opacity: 0.36, rot: -0.4, seed: 43 },
    ];

    for (const cfg of configs) {
      const geo = new THREE.PlaneGeometry(cfg.w, cfg.h);
      const mat = new THREE.MeshBasicMaterial({
        map: makeNebulaTexture({
          size: 192,
          seed: cfg.seed,
          colorA: cfg.colorA,
          colorB: cfg.colorB,
        }),
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        opacity: cfg.opacity,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set((Math.random() - 0.5) * 120, 10 + (Math.random() - 0.5) * 60, cfg.z);
      mesh.rotation.z = cfg.rot;
      mesh.renderOrder = -10;
      this.backdrop.add(mesh);
      this.nebula.push({
        mesh,
        mat,
        baseOpacity: cfg.opacity,
        phase: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.02,
      });
    }

    // horizon glow bloom
    const glowTex = makeGlowTexture('#ffffff', '#3ff2ff');
    const glow = makeSprite(glowTex, 0x9ff0ff, 0.5);
    glow.position.set(0, 8, -(CORRIDOR.length - 220));
    glow.scale.set(520, 260, 1);
    glow.renderOrder = -5;
    this.backdrop.add(glow);
    this.horizonGlow = glow;

    const magentaGlow = makeSprite(glowTex, 0xff5fd8, 0.38);
    magentaGlow.position.set(34, 42, -430);
    magentaGlow.scale.set(320, 200, 1);
    magentaGlow.renderOrder = -5;
    this.backdrop.add(magentaGlow);
  }

  /**
   * The celestial destination: a glowing core locked to the vanishing point of
   * the view axis, wrapped in a fan of light rays and corona rings.
   *
   * It is placed from the camera every frame (see `_placeHorizon`) rather than
   * parked at a fixed world position, so it stays pinned to the horizon when the
   * ship strafes across the endless plane, and drawn first (depths off) so the
   * gameplay layer — walls, warnings and orbs — always reads on top of it.
   */
  _buildHorizon() {
    const group = new THREE.Group();
    group.frustumCulled = false;
    this.group.add(group);

    const rayMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPulse: { value: 0.4 },
        uOpacity: { value: HORIZON.opacity },
        uCoreColor: { value: new THREE.Color(0xfff2c8) },
        uRayColor: { value: new THREE.Color(0x6fd8ff) },
      },
      vertexShader: VERT_UV,
      fragmentShader: HORIZON_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const rays = new THREE.Mesh(
      new THREE.PlaneGeometry(HORIZON.rayScale.x, HORIZON.rayScale.y),
      rayMat
    );
    rays.frustumCulled = false;
    rays.renderOrder = -20;
    group.add(rays);

    const glowTex = makeGlowTexture('#ffffff', '#ffd24a');
    const glow = makeSprite(glowTex, 0xfff0c0, HORIZON.opacity * 1.5);
    glow.scale.set(HORIZON.coreScale * 2.4, HORIZON.coreScale * 2.4, 1);
    glow.material.depthTest = false;
    glow.renderOrder = -19;
    group.add(glow);

    const core = makeSprite(glowTex, 0xffffff, 0.95);
    core.scale.set(HORIZON.coreScale * 0.42, HORIZON.coreScale * 0.42, 1);
    core.material.depthTest = false;
    core.renderOrder = -18;
    group.add(core);

    this.horizon = { group, rays, rayMat, glow, core };
  }

  _buildCorridor() {
    const floorMat = new THREE.ShaderMaterial({
      uniforms: {
        uOffset: { value: 0 },
        uTime: { value: 0 },
        uLaneWidth: { value: LANES.width },
        uSpeedNorm: { value: 0 },
        uBoost: { value: 0 },
        uDanger: { value: 0 },
        uCamZ: { value: 9 },
        uGridColor: { value: new THREE.Color(0x1d5f8a) },
        uLaneColor: { value: new THREE.Color(COLORS.cyan) },
        uDangerColor: { value: new THREE.Color(COLORS.red) },
      },
      vertexShader: FLOOR_VERT,
      fragmentShader: FLOOR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    // The plane has no side borders: it is a wide strip that is re-centred on
    // the camera every frame, while the grid itself is evaluated in world space
    // so it reads as an infinite floor stretching left and right for ever.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(CORRIDOR.planeWidth, CORRIDOR.length, 1, 1),
      floorMat
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -CORRIDOR.length / 2 + 30);
    floor.frustumCulled = false;
    floor.renderOrder = 1;
    this.group.add(floor);
    this.floorMesh = floor;
    this.floorMaterial = floorMat;
  }

  /** One debris pillar: scattered right across the plane, never a border. */
  _pylonSeed(i) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    return {
      x: dir * (26 + Math.pow(Math.random(), 1.35) * 500),
      z: 24 - (i / this.pylonCount) * CORRIDOR.length,
      height: 5 + Math.random() * 11,
      bar: Math.random() > 0.5,
    };
  }

  _buildPylons() {
    // The corridor has no edges any more, so the pylons become a wide field of
    // drifting debris instead of two neat rows flanking the track.
    this.pylonCount = 88;
    const geo = new THREE.BoxGeometry(0.5, 1, 0.5);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a1020,
      emissive: COLORS.cyan,
      emissiveIntensity: 1.1,
      metalness: 0.65,
      roughness: 0.35,
    });
    this.pylons = new THREE.InstancedMesh(geo, mat, this.pylonCount);
    this.pylons.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pylons.frustumCulled = false;

    const barGeo = new THREE.BoxGeometry(2.6, 0.22, 0.22);
    const barMat = new THREE.MeshBasicMaterial({
      color: COLORS.magenta,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.pylonBars = new THREE.InstancedMesh(barGeo, barMat, this.pylonCount);
    this.pylonBars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pylonBars.frustumCulled = false;
    this.pylonBars.renderOrder = 3;

    this.group.add(this.pylons);
    this.group.add(this.pylonBars);

    this.pylonData = [];
    for (let i = 0; i < this.pylonCount; i += 1) {
      this.pylonData.push(this._pylonSeed(i));
    }

    // give each pylon a slightly different neon tint
    for (let i = 0; i < this.pylonCount; i += 1) {
      const t = i / this.pylonCount;
      this._color.setHSL(0.5 + t * 0.22, 0.95, 0.55);
      this.pylons.setColorAt(i, this._color);
    }
    this.pylons.instanceColor.needsUpdate = true;
    this._writePylonMatrices();
  }

  _writePylonMatrices() {
    for (let i = 0; i < this.pylonCount; i += 1) {
      const p = this.pylonData[i];
      this._tmp.position.set(p.x, p.height / 2, p.z);
      this._tmp.rotation.set(0, 0, 0);
      this._tmp.scale.set(1, p.height, 1);
      this._tmp.updateMatrix();
      this.pylons.setMatrixAt(i, this._tmp.matrix);

      this._tmp.position.set(p.x, p.height * 0.72, p.z);
      this._tmp.scale.set(p.bar ? 1 : 0.001, p.bar ? 1 : 0.001, 1);
      this._tmp.updateMatrix();
      this.pylonBars.setMatrixAt(i, this._tmp.matrix);
    }
    this.pylons.instanceMatrix.needsUpdate = true;
    this.pylonBars.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ */

  setPixelRatio(pr) {
    this.pixelRatio = pr;
    this.deepPoints.material.uniforms.uPixelRatio.value = Math.min(pr, 2);
  }

  /** Called every frame by the game loop. */
  update(dt, { speed = 0, speedNorm = 0, boost = 0, danger = 0, scroll = true } = {}) {
    this.time += dt;
    const travel = scroll ? speed * dt : 0;
    this.offset += travel;
    this.speedNorm = speedNorm;
    this.boost = boost;

    /* streaks ---------------------------------------------------------- */
    const streakLength = clamp(speed * 0.055 * (1 + boost * 2.4), 1.2, 46);
    const s = this.streakData;
    for (let i = 0; i < s.count; i += 1) {
      const i6 = i * 6;
      const dz = travel * s.speeds[i];
      s.positions[i6 + 2] += dz;
      if (s.positions[i6 + 2] > 26) {
        // respawn far ahead
        const x = (Math.random() - 0.5) * 190;
        const y = (Math.random() - 0.5) * 120;
        const z = -400 - Math.random() * 180;
        s.positions[i6] = x;
        s.positions[i6 + 1] = y;
        s.positions[i6 + 2] = z;
      }
      const z0 = s.positions[i6 + 2];
      s.positions[i6 + 3] = s.positions[i6];
      s.positions[i6 + 4] = s.positions[i6 + 1];
      s.positions[i6 + 5] = z0 - streakLength;
      s.alpha[i * 2] = clamp(0.16 + boost * 0.5 + speedNorm * 0.24, 0, 1);
    }
    this.streaks.geometry.attributes.position.needsUpdate = true;
    this.streaks.geometry.attributes.aAlpha.needsUpdate = true;

    /* deep stars ------------------------------------------------------- */
    const d = this.deepStars;
    for (let i = 0; i < d.count; i += 1) {
      const i3 = i * 3;
      d.positions[i3 + 2] += travel * d.speeds[i] * 0.85;
      if (d.positions[i3 + 2] > 24) {
        d.positions[i3] = (Math.random() - 0.5) * 620;
        d.positions[i3 + 1] = (Math.random() - 0.5) * 380;
        d.positions[i3 + 2] = -900 - Math.random() * 60;
      }
    }
    this.deepPoints.geometry.attributes.position.needsUpdate = true;

    /* nebula ----------------------------------------------------------- */
    for (const n of this.nebula) {
      n.mat.opacity = n.baseOpacity * (0.88 + 0.12 * Math.sin(this.time * 0.11 + n.phase));
      n.mesh.rotation.z += n.spin * dt;
    }

    /* corridor --------------------------------------------------------- */
    const fm = this.floorMaterial.uniforms;
    fm.uOffset.value = this.offset;
    fm.uTime.value = this.time;
    fm.uSpeedNorm.value = speedNorm;
    fm.uBoost.value = boost;
    fm.uDanger.value = danger;

    /* debris ----------------------------------------------------------- */
    let dirty = false;
    for (let i = 0; i < this.pylonCount; i += 1) {
      const p = this.pylonData[i];
      p.z += travel;
      if (p.z > 26) {
        const fresh = this._pylonSeed(i);
        p.x = fresh.x;
        p.height = fresh.height;
        p.bar = fresh.bar;
        p.z -= CORRIDOR.length;
        dirty = true;
      }
      this._tmp.position.set(p.x, p.height / 2, p.z);
      this._tmp.rotation.set(0, 0, 0);
      this._tmp.scale.set(1, p.height, 1);
      this._tmp.updateMatrix();
      this.pylons.setMatrixAt(i, this._tmp.matrix);

      this._tmp.position.set(p.x, p.height * 0.72, p.z);
      this._tmp.scale.set(p.bar ? 1 : 0.0001, p.bar ? 1 : 0.0001, 1);
      this._tmp.updateMatrix();
      this.pylonBars.setMatrixAt(i, this._tmp.matrix);
    }
    this.pylons.instanceMatrix.needsUpdate = true;
    this.pylonBars.instanceMatrix.needsUpdate = true;
    if (dirty) this.pylons.instanceColor.needsUpdate = true;

    /* horizon ---------------------------------------------------------- */
    const h = this.horizon;
    if (h) {
      h.rayMat.uniforms.uTime.value = this.time;
      h.rayMat.uniforms.uPulse.value = 0.35 + speedNorm * 0.45 + boost * 0.8;
      h.rayMat.uniforms.uOpacity.value = HORIZON.opacity * (0.8 + speedNorm * 0.25);
      h.glow.material.opacity = HORIZON.opacity * (1.05 + speedNorm * 0.3 + boost * 0.35);
      h.core.scale.setScalar(
        HORIZON.coreScale * 0.42 * (1 + Math.sin(this.time * 1.6) * 0.05 + speedNorm * 0.05)
      );
    }

    /* lights ----------------------------------------------------------- */
    this.corridorLight.position.z = -26 + Math.sin(this.time * 0.7) * 6;
    this.corridorLight.intensity = 240 + speedNorm * 180 + boost * 260;
    this.abyssLight.intensity = 160 + speedNorm * 140;
    this.horizonGlow.material.opacity = 0.32 + speedNorm * 0.3 + boost * 0.35;
    this.horizonGlow.scale.set(520 + boost * 120, 260 + boost * 60, 1);
  }

  setCameraZ(z) {
    this.floorMaterial.uniforms.uCamZ.value = z;
  }

  /**
   * Keep the endless world centred on the viewer.
   *
   * The ground plane, starfields, nebula backdrop and the corridor lights all
   * track the ship laterally, so flying arbitrarily far left or right never
   * reaches an edge, empty space or a black void.
   */
  followCamera(x, y = 0, camera = null) {
    this.floorMesh.position.x = x;
    this.deepPoints.position.set(x, y * 0.6, 0);
    this.streaks.position.set(x, y * 0.6, 0);
    this.backdrop.position.set(x, y * 0.55, 0);
    this.corridorLight.position.x = x;
    this.abyssLight.position.x = x;
    if (camera) this._placeHorizon(camera);
  }

  /**
   * Park the celestial body exactly on the view axis, `HORIZON.ndcY` above the
   * screen centre. Working from the camera's own basis means it stays welded to
   * the horizon line on any aspect ratio or field of view, and it follows the ship
   * sideways for free because the camera does.
   */
  _placeHorizon(camera) {
    if (!this.horizon) return;
    camera.updateMatrixWorld();
    const m = camera.matrixWorld.elements;
    this._dir.set(-m[8], -m[9], -m[10]).normalize();
    this._up.set(m[4], m[5], m[6]).normalize();

    const halfFov = (camera.fov * Math.PI) / 360;
    const rise = HORIZON.ndcY * Math.tan(halfFov);
    const dist = HORIZON.distance;

    this.horizon.group.position
      .copy(camera.position)
      .addScaledVector(this._dir, dist)
      .addScaledVector(this._up, rise * dist);
    // face the viewer, so the ray fan is always seen head-on
    this.horizon.group.quaternion.copy(camera.quaternion);
  }

  /** Re-seed the field for a fresh run (keeps geometry, resets positions). */
  reset() {
    this.offset = 0;
    this.time = 0;
    const d = this.deepStars;
    for (let i = 0; i < d.count; i += 1) {
      const i3 = i * 3;
      d.positions[i3] = (Math.random() - 0.5) * 620;
      d.positions[i3 + 1] = (Math.random() - 0.5) * 380;
      d.positions[i3 + 2] = -Math.random() * 900 + 20;
    }
    this.deepPoints.geometry.attributes.position.needsUpdate = true;

    const s = this.streakData;
    for (let i = 0; i < s.count; i += 1) {
      const i6 = i * 6;
      const x = (Math.random() - 0.5) * 190;
      const y = (Math.random() - 0.5) * 120;
      const z = -Math.random() * 520 + 12;
      s.positions[i6] = x;
      s.positions[i6 + 1] = y;
      s.positions[i6 + 2] = z;
      s.positions[i6 + 3] = x;
      s.positions[i6 + 4] = y;
      s.positions[i6 + 5] = z - 2;
    }
    this.streaks.geometry.attributes.position.needsUpdate = true;

    for (let i = 0; i < this.pylonCount; i += 1) {
      Object.assign(this.pylonData[i], this._pylonSeed(i));
    }
    this._writePylonMatrices();
    this.floorMaterial.uniforms.uDanger.value = 0;
  }
}
