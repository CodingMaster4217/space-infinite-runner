/**
 * UI — all DOM plumbing: HUD readouts, power-up tray, alert pills, toasts,
 * modal state machine and the FX overlays. Writes to the DOM only when values
 * actually change so the render loop stays cheap.
 */

import { formatInt } from './utils.js';

const POWERUP_NOUNS = {
  boost: { label: 'Speed Boost', cls: 'boost' },
  brake: { label: 'Warp Brake', cls: 'brake' },
  shield: { label: 'Shield Core', cls: 'shield' },
  invuln: { label: 'Invulnerable', cls: 'invuln' },
};

export class UI {
  constructor(actions = {}) {
    this.actions = actions;
    this.el = {
      hud: document.getElementById('hud'),
      score: document.getElementById('hud-score'),
      speed: document.getElementById('hud-speed'),
      speedUnit: document.getElementById('hud-speed-unit'),
      speedFill: document.getElementById('hud-speed-fill'),
      speedBar: document.querySelector('.speed-bar'),
      best: document.getElementById('hud-best'),
      fpsChip: document.getElementById('hud-fps-chip'),
      powerups: document.getElementById('hud-powerups'),
      powerupsEmpty: document.getElementById('hud-powerups-empty'),
      alert: document.getElementById('hud-alert'),
      toasts: document.getElementById('hud-toasts'),
      damage: document.getElementById('fx-damage'),
      boost: document.getElementById('fx-boost'),
      glitch: document.getElementById('fx-glitch'),
      modalLayer: document.getElementById('modal-layer'),
      modals: {
        start: document.getElementById('modal-start'),
        pause: document.getElementById('modal-pause'),
        over: document.getElementById('modal-over'),
      },
      startBest: document.getElementById('start-best'),
      overScore: document.getElementById('over-score'),
      overStats: document.getElementById('over-stats'),
      pauseStats: document.getElementById('pause-stats'),
      boot: document.getElementById('boot'),
      fatal: document.getElementById('fatal'),
      fatalMsg: document.getElementById('fatal-msg'),
      btnMute: document.getElementById('btn-mute'),
    };

    this.cache = {
      score: null,
      speed: null,
      best: null,
      fps: null,
      unit: null,
      speedFill: null,
      chips: '',
      modal: 'start',
      alertKey: null,
    };

    this.alertTimer = 0;
    this.alertEl = null;
    this.boostOn = false;

    this._bindButtons();
  }

  _bindButtons() {
    const wire = (id, action) => {
      const btn = document.getElementById(id);
      if (btn && this.actions[action]) {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          this.actions[action]();
        });
      }
    };
    wire('btn-start', 'start');
    wire('btn-resume', 'resume');
    wire('btn-restart', 'restart');
    wire('btn-pause-restart', 'restart');
    wire('btn-menu', 'menu');
    wire('btn-pause-menu', 'menu');
  }

  /* ------------------------------------------------------------------ */

  hideBoot() {
    if (!this.el.boot) return;
    this.el.boot.classList.add('is-done');
    window.setTimeout(() => this.el.boot?.remove(), 700);
  }

  showFatal(message) {
    if (!this.el.fatal) return;
    this.el.fatal.classList.remove('is-hidden');
    if (this.el.fatalMsg) this.el.fatalMsg.textContent = message;
    this.el.boot?.classList.add('is-done');
  }

  setHudVisible(visible) {
    this.el.hud?.classList.toggle('is-hidden', !visible);
  }

  setModal(name) {
    if (this.cache.modal === name) return;
    this.cache.modal = name;
    for (const [key, node] of Object.entries(this.el.modals)) {
      if (!node) continue;
      node.classList.toggle('is-active', key === name);
    }
    const layer = this.el.modalLayer;
    if (layer) layer.style.display = name ? 'grid' : 'none';
  }

  setBest(value, target = 'both') {
    if (target !== 'over') this.el.startBest.textContent = `Best distance: ${formatInt(value)} m`;
  }

  setMuteLabel(muted) {
    if (this.el.btnMute) {
      this.el.btnMute.textContent = muted ? '🔇' : '🔊';
      this.el.btnMute.setAttribute('aria-pressed', String(muted));
    }
  }

  /* ------------------------------------------------------------------ */
  /* per-frame HUD                                                       */
  /* ------------------------------------------------------------------ */

  update(state) {
    const {
      score = 0,
      speedKmh = 0,
      speedNorm = 0,
      boosting = false,
      dilating = false,
      best = 0,
      fps = 60,
      powerups = [],
      muted = false,
    } = state;

    const scoreText = formatInt(score);
    if (this.cache.score !== scoreText && this.el.score) {
      this.cache.score = scoreText;
      this.el.score.textContent = scoreText;
    }

    const speedText = formatInt(speedKmh);
    if (this.cache.speed !== speedText && this.el.speed) {
      this.cache.speed = speedText;
      this.el.speed.textContent = speedText;
    }

    const unit = boosting ? 'warp' : dilating ? 'dilated' : 'km/h';
    if (this.cache.unit !== unit && this.el.speedUnit) {
      this.cache.unit = unit;
      this.el.speedUnit.textContent = unit;
    }

    const bestText = `Best ${formatInt(best)} m`;
    if (this.cache.best !== bestText && this.el.best) {
      this.cache.best = bestText;
      this.el.best.textContent = bestText;
    }

    const fpsText = `${Math.round(fps)} FPS`;
    if (this.cache.fps !== fpsText && this.el.fpsChip) {
      this.cache.fps = fpsText;
      this.el.fpsChip.textContent = fpsText;
    }

    if (this.el.speedFill) {
      const pct = Math.max(2, Math.min(100, speedNorm * 100));
      this.el.speedFill.style.width = `${pct.toFixed(1)}%`;
      if (this.el.speedBar) {
        this.el.speedBar.classList.toggle('is-boost', boosting);
        this.el.speedBar.classList.toggle('is-danger', !boosting && pct > 82);
      }
    }

    this._renderChips(powerups);
    this.setMuteLabel(muted);
  }

  _renderChips(powerups) {
    const signature = powerups.map((p) => p.id).join('|');
    if (signature !== this.cache.chips) {
      this.cache.chips = signature;
      const tray = this.el.powerups;
      if (tray) {
        tray.innerHTML = '';
        if (powerups.length === 0) {
          const empty = document.createElement('span');
          empty.className = 'powerup-tray__empty';
          empty.textContent = 'none active';
          tray.appendChild(empty);
        } else {
          for (const p of powerups) {
            const meta = POWERUP_NOUNS[p.id] || POWERUP_NOUNS.boost;
            const chip = document.createElement('span');
            chip.className = `pu-chip pu-chip--${meta.cls}`;
            chip.innerHTML = `<span class="pu-chip__dot"></span><span>${meta.label}${
              p.count > 1 ? ` ×${p.count}` : ''
            }</span><span class="pu-chip__meter"><i></i></span>`;
            tray.appendChild(chip);
          }
        }
      }
    }

    const tray = this.el.powerups;
    if (!tray) return;
    const fills = tray.querySelectorAll('.pu-chip__meter i');
    powerups.forEach((p, i) => {
      const fill = fills[i];
      if (fill) fill.style.transform = `scaleX(${Math.max(0, Math.min(1, p.ratio ?? 1)).toFixed(3)})`;
    });
  }

  /* ------------------------------------------------------------------ */
  /* alerts + toasts                                                     */
  /* ------------------------------------------------------------------ */

  alert(text, variant = 'warn', ttl = 1.2) {
    const key = `${variant}:${text}`;
    if (this.cache.alertKey === key && this.alertTimer > 0.15) {
      this.alertTimer = Math.max(this.alertTimer, ttl);
      return;
    }
    this.cache.alertKey = key;
    this.alertTimer = ttl;
    const host = this.el.alert;
    if (!host) return;
    host.innerHTML = '';
    const pill = document.createElement('div');
    pill.className = `alert-pill${variant === 'warn' ? '' : ` alert-pill--${variant}`}`;
    pill.textContent = text;
    host.appendChild(pill);
    this.alertEl = pill;
    host.style.opacity = '1';
  }

  clearAlert() {
    this.alertTimer = 0;
    this.cache.alertKey = null;
    if (this.el.alert) this.el.alert.innerHTML = '';
  }

  toast(text, variant = 'info') {
    const host = this.el.toasts;
    if (!host) return;
    const node = document.createElement('div');
    node.className = `toast toast--${variant}`;
    node.textContent = text;
    host.appendChild(node);
    window.setTimeout(() => node.remove(), 1900);
  }

  damageFlash() {
    const node = this.el.damage;
    if (!node) return;
    node.classList.add('is-hit');
    window.setTimeout(() => node.classList.remove('is-hit'), 130);
  }

  boostOverlay(on) {
    if (this.boostOn === on) return;
    this.boostOn = on;
    this.el.boost?.classList.toggle('is-active', on);
  }

  glitch() {
    const node = this.el.glitch;
    if (!node) return;
    node.classList.remove('is-active');
    void node.offsetWidth;
    node.classList.add('is-active');
  }

  tick(dt) {
    if (this.alertTimer > 0) {
      this.alertTimer -= dt;
      if (this.alertTimer <= 0) this.clearAlert();
    }
  }

  /* ------------------------------------------------------------------ */
  /* modal content                                                       */
  /* ------------------------------------------------------------------ */

  _stat(label, value, unit = '', modifier = '') {
    return `<div class="stat${modifier ? ` stat--${modifier}` : ''}">
      <span class="stat__label">${label}</span>
      <span class="stat__value">${value}${unit ? `<small>${unit}</small>` : ''}</span>
    </div>`;
  }

  showGameOver({ distance, topSpeed, powerups, timeAlive, wallsDestroyed, shieldsUsed, newRecord }) {
    if (this.el.overScore) this.el.overScore.textContent = formatInt(distance);
    if (this.el.overStats) {
      this.el.overStats.innerHTML = [
        this._stat('Top speed', formatInt(topSpeed), 'km/h', 'gold'),
        this._stat('Survived', timeAlive.toFixed(1), 's'),
        this._stat('Power-ups', formatInt(powerups)),
        this._stat('Walls shattered', formatInt(wallsDestroyed), '', 'danger'),
        this._stat('Shields burned', formatInt(shieldsUsed)),
        this._stat('Record', newRecord ? 'NEW' : '▲ keep going'),
      ].join('');
    }
  }

  showPauseStats({ distance, topSpeed, timeAlive }) {
    if (this.el.pauseStats) {
      this.el.pauseStats.innerHTML = [
        this._stat('Distance', formatInt(distance), 'm'),
        this._stat('Top speed', formatInt(topSpeed), 'km/h', 'gold'),
        this._stat('Survived', timeAlive.toFixed(1), 's'),
      ].join('');
    }
  }

  showStartStats(best) {
    this.setBest(best);
  }
}
