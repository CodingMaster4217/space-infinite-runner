/**
 * vfx.js — procedural textures + pooled particle effects.
 * No external assets: every texture is painted into an offscreen canvas.
 */

import * as THREE from 'three';

const _color = new THREE.Color();

/** Soft radial glow sprite texture (white core → coloured halo). */
export function makeGlowTexture(core = '#ffffff', halo = '#3ff2ff', size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, core);
  g.addColorStop(0.22, halo);
  g.addColorStop(0.55, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Diagonal streak texture used for the boost star-burst overlay. */
export function makeStreakTexture(size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, size / 2, size, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, size / 2 - size * 0.06, size, size * 0.12);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeSprite(texture, color, opacity = 0.8) {
  const material = new THREE.SpriteMaterial({
    map: texture,
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });
  const sprite = new THREE.Sprite(material);
  return sprite;
}

const BURST_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uPixelRatio;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.0, aSize * uScale * uPixelRatio * (170.0 / max(1.0, -mv.z)));
  }
`;

const BURST_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    if (r > 0.5) discard;
    float falloff = smoothstep(0.5, 0.02, r);
    gl_FragColor = vec4(vColor, falloff * vAlpha);
  }
`;

/**
 * BurstPool — one draw call for every spark / debris / pickup flash in the game.
 */
export class BurstPool {
  constructor(scene, { count = 900, scale = 1 } = {}) {
    this.count = count;
    this.cursor = 0;
    this.alive = 0;

    this.positions = new Float32Array(count * 3);
    this.colors = new Float32Array(count * 3);
    this.sizes = new Float32Array(count);
    this.alphas = new Float32Array(count);

    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.gravity = new Float32Array(count);
    this.baseSize = new Float32Array(count);
    this.baseColor = new Float32Array(count * 3);

    for (let i = 0; i < count; i += 1) this.positions[i * 3 + 1] = -9999;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        uScale: { value: scale },
      },
      vertexShader: BURST_VERT,
      fragmentShader: BURST_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.geometry = geometry;
    this.material = material;
    scene.add(this.points);
  }

  setPixelRatio(pr) {
    this.material.uniforms.uPixelRatio.value = Math.min(pr, 2);
  }

  /**
   * Spawn a burst of particles.
   * @param {THREE.Vector3|{x,y,z}} origin
   */
  spawn(origin, {
    amount = 18,
    speed = 12,
    speedSpread = 0.7,
    life = 0.7,
    lifeSpread = 0.5,
    size = 0.9,
    color = 0x3ff2ff,
    colorVariance = 0.25,
    spread = 0.25,
    direction = null,
    directionBias = 0,
    drag = 1.6,
    gravity = 0,
  } = {}) {
    _color.set(color);
    for (let n = 0; n < amount; n += 1) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.count;

      const dir = new THREE.Vector3(
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1
      ).normalize();
      if (direction) dir.lerp(direction, directionBias).normalize();

      const sp = speed * (1 - speedSpread / 2 + Math.random() * speedSpread);
      this.vel[i * 3] = dir.x * sp;
      this.vel[i * 3 + 1] = dir.y * sp;
      this.vel[i * 3 + 2] = dir.z * sp;

      this.positions[i * 3] = origin.x + dir.x * spread;
      this.positions[i * 3 + 1] = origin.y + dir.y * spread;
      this.positions[i * 3 + 2] = origin.z + dir.z * spread;

      const ls = 0.4 + Math.random() * lifeSpread * 2;
      this.life[i] = life * ls;
      this.maxLife[i] = life * ls;
      this.drag[i] = drag;
      this.gravity[i] = gravity;
      this.baseSize[i] = size * (0.6 + Math.random() * 0.9);
      this.sizes[i] = this.baseSize[i];
      this.alphas[i] = 1;

      const v = (Math.random() - 0.5) * colorVariance;
      const c = _color.clone().offsetHSL(v * 0.12, v * 0.4, Math.abs(v) * 0.35);
      this.baseColor[i * 3] = c.r;
      this.baseColor[i * 3 + 1] = c.g;
      this.baseColor[i * 3 + 2] = c.b;
      this.colors[i * 3] = c.r;
      this.colors[i * 3 + 1] = c.g;
      this.colors[i * 3 + 2] = c.b;
    }
  }

  update(dt) {
    let alive = 0;
    const { positions, vel, life, maxLife, alphas, sizes, baseSize, drag, gravity, baseColor, colors } = this;
    for (let i = 0; i < this.count; i += 1) {
      if (life[i] <= 0) {
        if (alphas[i] !== 0) {
          alphas[i] = 0;
          positions[i * 3 + 1] = -9999;
        }
        continue;
      }
      alive += 1;
      life[i] -= dt;
      const t = Math.max(0, life[i] / maxLife[i]);
      const damp = Math.max(0, 1 - drag[i] * dt);
      vel[i * 3] *= damp;
      vel[i * 3 + 1] = vel[i * 3 + 1] * damp - gravity[i] * dt;
      vel[i * 3 + 2] *= damp;

      positions[i * 3] += vel[i * 3] * dt;
      positions[i * 3 + 1] += vel[i * 3 + 1] * dt;
      positions[i * 3 + 2] += vel[i * 3 + 2] * dt;

      alphas[i] = t * t;
      sizes[i] = baseSize[i] * (0.35 + t * 0.65);
      colors[i * 3] = baseColor[i * 3];
      colors[i * 3 + 1] = baseColor[i * 3 + 1];
      colors[i * 3 + 2] = baseColor[i * 3 + 2];
    }
    this.alive = alive;
    this.points.visible = alive > 0;
    if (alive > 0) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.aColor.needsUpdate = true;
      this.geometry.attributes.aSize.needsUpdate = true;
      this.geometry.attributes.aAlpha.needsUpdate = true;
    }
  }

  reset() {
    this.life.fill(0);
    this.alphas.fill(0);
    for (let i = 0; i < this.count; i += 1) this.positions[i * 3 + 1] = -9999;
    this.points.visible = false;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

/** Expanding additive ring — used for impacts, pickups and shield breaks. */
export class ShockwavePool {
  constructor(scene, { count = 8 } = {}) {
    this.items = [];
    const geo = new THREE.RingGeometry(0.72, 1, 48);
    for (let i = 0; i < count; i += 1) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 4;
      scene.add(mesh);
      this.items.push({ mesh, life: 0, maxLife: 1, size: 6 });
    }
    this.cursor = 0;
  }

  fire(position, { color = 0x3ff2ff, size = 8, life = 0.5 } = {}) {
    const item = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    item.mesh.position.copy(position);
    item.mesh.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI);
    item.mesh.material.color.set(color);
    item.mesh.visible = true;
    item.life = life;
    item.maxLife = life;
    item.size = size;
    item.mesh.scale.setScalar(size * 0.35);
    item.mesh.material.opacity = 0.9;
  }

  update(dt) {
    for (const item of this.items) {
      if (item.life <= 0) continue;
      item.life -= dt;
      const t = Math.max(0, item.life / item.maxLife);
      const eased = 1 - t * t;
      item.mesh.scale.setScalar(item.size * (0.35 + eased * 1.1));
      item.mesh.material.opacity = t * 0.85;
      if (item.life <= 0) item.mesh.visible = false;
    }
  }

  reset() {
    for (const item of this.items) {
      item.life = 0;
      item.mesh.visible = false;
    }
  }
}
