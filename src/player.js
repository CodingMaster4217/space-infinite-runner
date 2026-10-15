/**
 * Player — procedurally built spaceship, engine trail, free lateral steering
 * (no hard lane snapping), banking animation and defensive visual states.
 */

import * as THREE from 'three';
import { COLORS, SHIP } from './config.js';
import { clamp, damp } from './utils.js';
import { makeGlowTexture, makeSprite } from './vfx.js';

const TRAIL_VERT = /* glsl */ `
  attribute float aLife;
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uPixelRatio;
  varying float vLife;
  varying vec3 vColor;
  void main() {
    vLife = aLife;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.0, aSize * uPixelRatio * (210.0 / max(1.0, -mv.z)));
  }
`;

const TRAIL_FRAG = /* glsl */ `
  varying float vLife;
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    if (r > 0.5) discard;
    float core = smoothstep(0.5, 0.0, r);
    float a = core * core * clamp(vLife, 0.0, 1.0);
    gl_FragColor = vec4(vColor, a);
  }
`;

const SHIELD_VERT = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  uniform float uFresnel;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SHIELD_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uFresnel;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  void main() {
    float f = pow(1.0 - clamp(dot(normalize(vNormalW), normalize(vViewDir)), 0.0, 1.0), 2.4);
    float grid = 0.5 + 0.5 * sin(vNormalW.y * 26.0 + uTime * 4.0);
    float a = (f * 0.9 + grid * 0.12) * uOpacity;
    gl_FragColor = vec4(uColor * (0.7 + f * 1.4), a);
  }
`;

const TRAIL_MAX = 320;

export class Player {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.position.set(0, SHIP.startY, 0);
    scene.add(this.root);

    this.visual = new THREE.Group();
    this.root.add(this.visual);

    this.velocityX = 0;
    this.roll = 0;
    this.pitch = 0;
    this.yaw = 0;
    this.time = 0;
    this.hitFlash = 0;
    this.trailAccum = 0;
    this.trailCursor = 0;
    this.shieldCharges = 0;
    this.engineLevel = 0;
    this.nozzles = [];
    this.hullMaterials = [];

    this.glowTex = makeGlowTexture('#ffffff', '#4dfbe0');
    this._tmpVec = new THREE.Vector3();
    this._col = new THREE.Color();

    this._buildShip();
    this._buildTrail();
    this._buildAuras();
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  _hullMaterial(color, emissive, emissiveIntensity = 0.25) {
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive,
      emissiveIntensity,
      metalness: 0.86,
      roughness: 0.34,
    });
    this.hullMaterials.push(mat);
    return mat;
  }

  _buildShip() {
    const hull = this._hullMaterial(COLORS.hull, COLORS.cyan, 0.14);
    const panel = this._hullMaterial(0x1b2b46, 0x2f7fa8, 0.3);
    const trim = new THREE.MeshStandardMaterial({
      color: 0x050b16,
      emissive: COLORS.cyan,
      emissiveIntensity: 2.4,
      metalness: 0.4,
      roughness: 0.5,
    });

    // fuselage — cone pointing down the corridor (-z)
    const bodyGeo = new THREE.ConeGeometry(0.62, 2.9, 14, 1, true);
    bodyGeo.rotateX(-Math.PI / 2);
    const body = new THREE.Mesh(bodyGeo, hull);
    body.position.z = -0.15;
    this.visual.add(body);

    // rear collar
    const collarGeo = new THREE.CylinderGeometry(0.5, 0.64, 0.7, 12, 1, true);
    collarGeo.rotateX(-Math.PI / 2);
    const collar = new THREE.Mesh(collarGeo, panel);
    collar.position.z = 1.1;
    this.visual.add(collar);

    // cockpit canopy
    const canopyGeo = new THREE.SphereGeometry(0.42, 18, 14);
    canopyGeo.scale(0.78, 0.66, 1.25);
    const canopy = new THREE.Mesh(
      canopyGeo,
      new THREE.MeshStandardMaterial({
        color: 0x06202c,
        emissive: COLORS.cyanSoft,
        emissiveIntensity: 1.15,
        metalness: 0.2,
        roughness: 0.08,
        transparent: true,
        opacity: 0.92,
      })
    );
    canopy.position.set(0, 0.24, -0.15);
    this.visual.add(canopy);

    // swept wings
    this.wings = [];
    for (const dir of [-1, 1]) {
      const wingGeo = new THREE.BoxGeometry(2.15, 0.14, 1.25);
      wingGeo.translate(dir * 1.05, 0, 0);
      const wing = new THREE.Mesh(wingGeo, panel);
      wing.position.set(dir * 0.2, -0.04, 0.5);
      wing.rotation.z = dir * 0.16;
      wing.rotation.y = dir * -0.24;
      this.visual.add(wing);
      this.wings.push(wing);

      const edgeGeo = new THREE.BoxGeometry(2.05, 0.05, 0.12);
      edgeGeo.translate(dir * 1.02, 0, 0);
      const edge = new THREE.Mesh(edgeGeo, trim);
      edge.position.set(dir * 0.22, 0.06, 0.02);
      edge.rotation.z = dir * 0.16;
      edge.rotation.y = dir * -0.24;
      this.visual.add(edge);

      // wingtip light
      const tip = makeSprite(this.glowTex, dir < 0 ? 0x7ef9ff : 0xff6fe0, 0.85);
      tip.scale.set(1.5, 1.5, 1);
      tip.position.set(dir * 2.2, 0.05, 0.35);
      this.visual.add(tip);
      this[dir < 0 ? 'leftTip' : 'rightTip'] = tip;
    }

    // vertical stabiliser
    const finGeo = new THREE.BoxGeometry(0.1, 0.78, 1.05);
    finGeo.translate(0, 0.39, 0);
    const fin = new THREE.Mesh(finGeo, panel);
    fin.position.set(0, 0.2, 0.95);
    fin.rotation.x = -0.22;
    this.visual.add(fin);

    const finTrim = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.95), trim);
    finTrim.position.set(0, 0.79, 0.99);
    this.visual.add(finTrim);

    // engine nacelles + glowing nozzles
    this.engines = [];
    for (const dir of [-1, 1]) {
      const nacelleGeo = new THREE.CylinderGeometry(0.24, 0.32, 1.5, 12, 1, true);
      nacelleGeo.rotateX(Math.PI / 2);
      const nacelle = new THREE.Mesh(nacelleGeo, hull);
      nacelle.position.set(dir * 0.72, -0.02, 0.95);
      this.visual.add(nacelle);

      const nozzleGeo = new THREE.CylinderGeometry(0.26, 0.19, 0.42, 12);
      nozzleGeo.rotateX(Math.PI / 2);
      const nozzle = new THREE.Mesh(nozzleGeo, trim);
      nozzle.position.set(dir * 0.72, -0.02, 1.78);
      this.visual.add(nozzle);

      const flame = makeSprite(this.glowTex, 0x9dfcff, 0.9);
      flame.scale.set(1.9, 1.9, 1);
      flame.position.set(dir * 0.72, -0.02, 2.05);
      this.visual.add(flame);

      const nozzleLocal = new THREE.Vector3(dir * 0.72, -0.02, 2.0);
      this.nozzles.push({ local: nozzleLocal, flame });
      this.engines.push(nacelle);
    }

    // under-glow so the hull reads against the dark corridor
    this.underGlow = makeSprite(this.glowTex, COLORS.cyan, 0.35);
    this.underGlow.scale.set(4.5, 3, 1);
    this.underGlow.position.set(0, -0.5, 0.4);
    this.visual.add(this.underGlow);
  }

  _buildTrail() {
    this.trailPositions = new Float32Array(TRAIL_MAX * 3);
    this.trailAlpha = new Float32Array(TRAIL_MAX); // shader attribute (0..1)
    this.trailLife = new Float32Array(TRAIL_MAX); // seconds remaining
    this.trailSize = new Float32Array(TRAIL_MAX);
    this.trailColors = new Float32Array(TRAIL_MAX * 3);
    this.trailVel = new Float32Array(TRAIL_MAX * 3);
    this.trailMaxLife = new Float32Array(TRAIL_MAX).fill(1);
    for (let i = 0; i < TRAIL_MAX; i += 1) this.trailPositions[i * 3 + 1] = -9999;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.trailAlpha, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.trailSize, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.trailColors, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) } },
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.trail = new THREE.Points(geo, mat);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 2;
    this.scene.add(this.trail);
    this.trailGeometry = geo;
    this.trailMaterial = mat;
  }

  _buildAuras() {
    const shieldGeo = new THREE.IcosahedronGeometry(2.15, 3);
    this.shieldMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(COLORS.gold) },
        uOpacity: { value: 0.0 },
        uTime: { value: 0 },
        uFresnel: { value: 2.2 },
      },
      vertexShader: SHIELD_VERT,
      fragmentShader: SHIELD_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.shield = new THREE.Mesh(shieldGeo, this.shieldMaterial);
    this.shield.visible = false;
    this.root.add(this.shield);

    const invulnGeo = new THREE.IcosahedronGeometry(2.45, 1);
    this.invulnMaterial = new THREE.MeshBasicMaterial({
      color: COLORS.green,
      wireframe: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.invuln = new THREE.Mesh(invulnGeo, this.invulnMaterial);
    this.invuln.visible = false;
    this.root.add(this.invuln);
  }

  /* ------------------------------------------------------------------ */
  /* runtime                                                             */
  /* ------------------------------------------------------------------ */

  get position() {
    return this.root.position;
  }

  reset() {
    this.root.position.set(0, SHIP.startY, 0);
    this.velocityX = 0;
    this.roll = 0;
    this.pitch = 0;
    this.yaw = 0;
    this.visual.rotation.set(0, 0, 0);
    this.hitFlash = 0;
    this.shieldCharges = 0;
    this.engineLevel = 0;
    this.shield.visible = false;
    this.invuln.visible = false;
    this.setPixelRatio(this.trailMaterial.uniforms.uPixelRatio.value);
    for (let i = 0; i < TRAIL_MAX; i += 1) {
      this.trailLife[i] = 0;
      this.trailAlpha[i] = 0;
      this.trailPositions[i * 3 + 1] = -9999;
    }
    this.trailGeometry.attributes.position.needsUpdate = true;
    this.trailGeometry.attributes.aLife.needsUpdate = true;
    this.trail.visible = false;
    this.hullMaterials.forEach((m) => {
      m.emissiveIntensity = 0.14;
    });
  }

  setPixelRatio(pr) {
    this.trailMaterial.uniforms.uPixelRatio.value = Math.min(pr, 2);
  }

  setShield(charges) {
    this.shieldCharges = charges;
    this.shield.visible = charges > 0;
  }

  flashHit() {
    this.hitFlash = 1;
  }

  /**
   * @param {number} dt   real seconds (steering is never time-dilated)
   * @param {object} state
   */
  update(dt, state) {
    const {
      axis = 0,
      speed = 0,
      speedNorm = 0,
      boost = 0,
      dilating = false,
      invuln = 0,
      shieldCharges = 0,
      idle = false,
    } = state;

    this.time += dt;

    /* --- lateral physics: continuous, no lane snapping ---------------- */
    const boostAgility = 1 + boost * 0.18;
    const targetVel = axis * SHIP.maxLateralSpeed * boostAgility;
    const accel = SHIP.lateralAccel * (0.72 + speedNorm * 0.6);
    const delta = targetVel - this.velocityX;
    const step = accel * dt;
    this.velocityX += clamp(delta, -step, step);
    if (Math.abs(this.velocityX) < 0.001) this.velocityX = 0;

    // No lateral clamp: the plane is infinite, so the ship may steer as far
    // left or right as it likes.
    this.root.position.x += this.velocityX * dt;

    /* --- banking / attitude ------------------------------------------ */
    const norm = clamp(this.velocityX / SHIP.maxLateralSpeed, -1, 1);
    const targetRoll = -norm * SHIP.bankMax;
    const targetYaw = norm * 0.34;
    const targetPitch = -speedNorm * 0.06 + (boost > 0 ? -0.05 : 0);

    this.roll = damp(this.roll, targetRoll, 7.5, dt);
    this.yaw = damp(this.yaw, targetYaw, 6.2, dt);
    this.pitch = damp(this.pitch, targetPitch, 5.0, dt);

    const wobble = idle ? 0 : Math.sin(this.time * 2.6) * 0.012;
    this.visual.rotation.set(this.pitch + wobble, this.yaw, this.roll + wobble * 1.4);
    this.visual.position.y = Math.sin(this.time * 3.1) * 0.05;

    /* --- engine visuals ---------------------------------------------- */
    this.engineLevel = damp(this.engineLevel, clamp(speedNorm * 0.7 + boost, 0, 1.6), 4.5, dt);
    for (const n of this.nozzles) {
      const flicker = 0.86 + Math.random() * 0.22;
      const scale = (1.5 + this.engineLevel * 2.3) * flicker;
      n.flame.scale.set(scale, scale * (1.05 + boost * 0.4), 1);
      n.flame.material.opacity = clamp(0.55 + this.engineLevel * 0.45, 0, 1);
      n.flame.material.color.set(boost > 0.15 ? COLORS.green : 0x9dfcff);
    }

    this.underGlow.material.opacity = 0.2 + this.engineLevel * 0.28;
    this.leftTip.material.opacity = 0.5 + Math.sin(this.time * 6) * 0.25;
    this.rightTip.material.opacity = 0.5 + Math.sin(this.time * 6 + 1.7) * 0.25;

    /* --- hull heat flash on impact ----------------------------------- */
    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - dt * 2.2);
      const f = this.hitFlash;
      this.hullMaterials.forEach((m) => {
        m.emissiveIntensity = 0.14 + f * 2.6;
      });
      this.leftTip.material.color.set(f > 0.05 ? COLORS.red : 0x7ef9ff);
    } else if (this.leftTip.material.color.getHex() === COLORS.red) {
      this.leftTip.material.color.set(0x7ef9ff);
    }

    /* --- auras -------------------------------------------------------- */
    const shielding = shieldCharges > 0;
    this.shield.visible = shielding;
    if (shielding) {
      const mat = this.shieldMaterial;
      mat.uniforms.uTime.value = this.time;
      mat.uniforms.uColor.value.set(COLORS.gold);
      mat.uniforms.uOpacity.value = 0.5 + Math.sin(this.time * 4.2) * 0.12;
    }

    this.invuln.visible = invuln > 0;
    if (invuln > 0) {
      this.invulnMaterial.opacity = 0.24 + Math.sin(this.time * 9) * 0.1;
      this.invulnMaterial.color.set(boost > 0.15 ? COLORS.green : COLORS.cyan);
      this.invuln.rotation.y += dt * 1.2;
      this.invuln.rotation.x += dt * 0.5;
    }

    /* --- engine trail ------------------------------------------------- */
    this._updateTrail(dt, { speed, boost, dilating, speedNorm });
  }

  _updateTrail(dt, { speed, boost, dilating, speedNorm }) {
    const {
      trailPositions,
      trailVel,
      trailLife,
      trailMaxLife,
      trailAlpha,
      trailSize,
      trailColors,
    } = this;

    // integrate existing particles
    const drift = speed * 0.42 + 5;
    let alive = 0;
    for (let i = 0; i < TRAIL_MAX; i += 1) {
      if (trailLife[i] <= 0) {
        if (trailAlpha[i] !== 0) {
          trailAlpha[i] = 0;
          trailPositions[i * 3 + 1] = -9999;
        }
        continue;
      }
      alive += 1;
      trailLife[i] -= dt;
      const drag = Math.max(0, 1 - 1.9 * dt);
      trailVel[i * 3] *= drag;
      trailVel[i * 3 + 1] = trailVel[i * 3 + 1] * drag + dt * 0.6;
      trailVel[i * 3 + 2] *= drag;

      trailPositions[i * 3] += trailVel[i * 3] * dt;
      trailPositions[i * 3 + 1] += trailVel[i * 3 + 1] * dt;
      trailPositions[i * 3 + 2] += (trailVel[i * 3 + 2] + drift) * dt;
      trailAlpha[i] = clamp(trailLife[i] / trailMaxLife[i], 0, 1) ** 1.15;
    }

    // spawn new particles
    const rate = 42 + speedNorm * 150 + boost * 320;
    this.trailAccum += rate * dt * (dilating ? 0.65 : 1);
    const spawnCount = Math.min(24, Math.floor(this.trailAccum));
    this.trailAccum -= spawnCount;

    const color = this._col.set(boost > 0.15 ? COLORS.green : COLORS.cyan);
    for (let n = 0; n < spawnCount; n += 1) {
      const i = this.trailCursor;
      this.trailCursor = (this.trailCursor + 1) % TRAIL_MAX;
      const nozzle = this.nozzles[n % this.nozzles.length];
      this._tmpVec.copy(nozzle.local);
      this.root.localToWorld(this._tmpVec);

      trailPositions[i * 3] = this._tmpVec.x + (Math.random() - 0.5) * 0.16;
      trailPositions[i * 3 + 1] = this._tmpVec.y + (Math.random() - 0.5) * 0.16;
      trailPositions[i * 3 + 2] = this._tmpVec.z + (Math.random() - 0.5) * 0.2;

      trailVel[i * 3] = (Math.random() - 0.5) * 1.5;
      trailVel[i * 3 + 1] = (Math.random() - 0.5) * 1.2;
      trailVel[i * 3 + 2] = 2 + Math.random() * 3;

      const life = (0.3 + Math.random() * 0.45) * (1 + boost * 0.7);
      trailLife[i] = life;
      trailMaxLife[i] = life;
      trailAlpha[i] = 1;
      trailSize[i] = (0.55 + Math.random() * 0.7) * (1 + boost * 0.8);

      const tint = color.clone();
      tint.offsetHSL(0, 0, (Math.random() - 0.5) * 0.22);
      trailColors[i * 3] = tint.r;
      trailColors[i * 3 + 1] = tint.g;
      trailColors[i * 3 + 2] = tint.b;
    }

    this.trail.visible = alive > 0 || spawnCount > 0;
    this.trailGeometry.attributes.position.needsUpdate = true;
    this.trailGeometry.attributes.aLife.needsUpdate = true;
    this.trailGeometry.attributes.aSize.needsUpdate = true;
    this.trailGeometry.attributes.aColor.needsUpdate = true;
  }
}
