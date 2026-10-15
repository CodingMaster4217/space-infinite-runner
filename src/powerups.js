/**
 * PowerUps — glowing collectible orbs hovering above the track.
 *   boost  : hyper-speed warp burst + temporary invincibility
 *   brake  : time dilation (world slows, ship stays agile)
 *   shield : single-use collision absorber
 */

import * as THREE from 'three';
import { COLORS, CORRIDOR, LANES, POWERUPS, POWERUP_TYPES, laneCenterX } from './config.js';
import { makeGlowTexture, makeSprite } from './vfx.js';

const ORB_GEO = new THREE.IcosahedronGeometry(0.44, 2);
const SHELL_GEO = new THREE.IcosahedronGeometry(0.72, 1);
const RING_GEO = new THREE.TorusGeometry(0.86, 0.045, 8, 36);
const PYLON_GEO = new THREE.CylinderGeometry(0.028, 0.028, 2.6, 6);

export class PowerUpManager {
  constructor(scene, { burstPool, shockwavePool } = {}) {
    this.scene = scene;
    this.burstPool = burstPool;
    this.shockwavePool = shockwavePool;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.orbs = [];
    this.glowTex = makeGlowTexture('#ffffff', '#c9fff0');
    this.time = 0;
    this.cursor = 0;
  }

  /* ------------------------------------------------------------------ */

  _makeOrb(type) {
    const meta = POWERUP_TYPES[type];
    const group = new THREE.Group();
    group.rotation.z = 0;

    const coreMaterial = new THREE.MeshBasicMaterial({
      color: meta.color,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const core = new THREE.Mesh(ORB_GEO, coreMaterial);
    group.add(core);

    const shellMaterial = new THREE.MeshBasicMaterial({
      color: meta.accent,
      wireframe: true,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const shell = new THREE.Mesh(SHELL_GEO, shellMaterial);
    group.add(shell);

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: meta.color,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(RING_GEO, ringMaterial);
    ring.rotation.x = Math.PI / 2;
    group.add(ring);

    const halo = makeSprite(this.glowTex, meta.color, 0.75);
    halo.scale.set(3.4, 3.4, 1);
    group.add(halo);

    const beamMaterial = new THREE.MeshBasicMaterial({
      color: meta.color,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const beam = new THREE.Mesh(PYLON_GEO, beamMaterial);
    beam.position.y = -0.35;
    group.add(beam);

    return { group, core, shell, ring, halo, materials: [coreMaterial, shellMaterial, ringMaterial, beamMaterial], beam };
  }

  /**
   * Place a new orb in a lane.
   * @param {'boost'|'brake'|'shield'} type
   * @param {number} laneIndex
   * @param {number} z
   */
  spawn(type, laneIndex, z = CORRIDOR.spawnZ) {
    const existing = this.orbs.find((o) => !o.active && o.type === type);
    const orb = existing || this._makeOrb(type);
    if (!existing) this.group.add(orb.group);

    orb.type = type;
    orb.active = true;
    orb.collected = false;
    orb.laneIndex = laneIndex;
    orb.group.visible = true;
    orb.group.position.set(laneCenterX(laneIndex), POWERUPS.hoverHeight, z);
    orb.baseY = POWERUPS.hoverHeight;
    orb.phase = Math.random() * Math.PI * 2;
    orb.group.scale.setScalar(0.001);
    orb.spin = 0.8 + Math.random() * 0.6;
    if (!existing) this.orbs.push(orb);
    return orb;
  }

  /** Pick a random lane for a drop. */
  pickLane(rand) {
    return Math.floor(rand() * LANES.count) % LANES.count;
  }

  release(orb) {
    orb.active = false;
    orb.group.visible = false;
  }

  /**
   * Called when the player touches an orb.
   * @returns {{type:string, position:THREE.Vector3}|null}
   */
  collect(orb) {
    if (!orb || !orb.active || orb.collected) return null;
    orb.collected = true;
    const meta = POWERUP_TYPES[orb.type];
    const position = orb.group.position.clone();

    if (this.burstPool) {
      this.burstPool.spawn(position, {
        amount: 34,
        speed: 11,
        life: 0.85,
        size: 1.1,
        color: meta.color,
        colorVariance: 0.5,
        spread: 0.4,
        drag: 2.2,
      });
      this.burstPool.spawn(position, {
        amount: 12,
        speed: 4,
        life: 1.1,
        size: 1.9,
        color: 0xffffff,
        spread: 0.2,
        drag: 3,
      });
    }
    if (this.shockwavePool) {
      this.shockwavePool.fire(position, { color: meta.color, size: 12, life: 0.55 });
    }
    this.release(orb);
    return { type: orb.type, position };
  }

  update(dt, { travel = 0 } = {}) {
    this.time += dt;
    for (const orb of this.orbs) {
      if (!orb.active) continue;
      orb.group.position.z += travel;
      if (orb.group.position.z > CORRIDOR.despawnZ) {
        this.release(orb);
        continue;
      }

      const bob = Math.sin(this.time * 2.1 + orb.phase) * 0.22;
      orb.group.position.y = orb.baseY + bob;
      orb.core.rotation.y += dt * 1.6 * orb.spin;
      orb.core.rotation.x += dt * 0.8 * orb.spin;
      orb.shell.rotation.y -= dt * 0.9;
      orb.shell.rotation.z += dt * 0.6;
      orb.ring.rotation.z += dt * 1.3;
      orb.ring.rotation.y = Math.sin(this.time * 1.1 + orb.phase) * 0.4;

      const pulse = 0.86 + Math.sin(this.time * 5 + orb.phase) * 0.14;
      orb.halo.scale.set(3.4 * pulse, 3.4 * pulse, 1);
      orb.core.scale.setScalar(0.9 + Math.sin(this.time * 6 + orb.phase) * 0.08);

      // pop-in as the orb enters the corridor
      const dist = Math.abs(orb.group.position.z - CORRIDOR.spawnZ);
      const grow = Math.min(1, 0.15 + dist / 40);
      orb.group.scale.setScalar(THREE.MathUtils.lerp(orb.group.scale.x, grow, Math.min(1, dt * 6)));
    }
  }

  /** Every active orb that could hit the player (near the collision plane). */
  nearPlayer(radius = 4) {
    return this.orbs.filter((o) => o.active && Math.abs(o.group.position.z) < radius);
  }

  reset() {
    for (const orb of this.orbs) this.release(orb);
    this.time = 0;
  }
}

export const POWERUP_COLOR = (type) => (POWERUP_TYPES[type] || POWERUP_TYPES.boost).color;
export const SHIELD_COLOR = COLORS.gold;
