/**
 * InputManager — unified keyboard / touch / pointer steering.
 *
 * Steering is analog: -1 (full left) … +1 (full right).
 * There are no hard lane limits, so the value is a continuous thrust request.
 */

import { clamp } from './utils.js';

const LEFT_CODES = new Set(['ArrowLeft', 'KeyA']);
const RIGHT_CODES = new Set(['ArrowRight', 'KeyD']);

export class InputManager {
  constructor({ canvas, buttons = {}, onAction = () => {}, dragRange = 90 } = {}) {
    this.canvas = canvas;
    this.onAction = onAction;
    this.dragRange = dragRange;

    this.keys = { left: false, right: false };
    this.buttonSteer = 0;
    this.dragSteer = 0;
    this.dragActive = false;
    this.pointerId = null;
    this.dragOriginX = 0;
    this.axis = 0;

    this._handlers = [];
    this._buttons = buttons;
    this._bind();
  }

  /* ------------------------------------------------------------------ */

  _bind() {
    const add = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this._handlers.push(() => target.removeEventListener(type, fn, opts));
    };

    add(window, 'keydown', (e) => this._onKeyDown(e), { passive: false });
    add(window, 'keyup', (e) => this._onKeyUp(e));
    add(window, 'blur', () => this.releaseAll());

    if (this.canvas) {
      add(this.canvas, 'pointerdown', (e) => this._onPointerDown(e));
      add(this.canvas, 'pointermove', (e) => this._onPointerMove(e));
      add(this.canvas, 'pointerup', (e) => this._onPointerUp(e));
      add(this.canvas, 'pointercancel', (e) => this._onPointerUp(e));
      add(this.canvas, 'pointerleave', (e) => this._onPointerUp(e));
    }

    const holdButton = (el, dir) => {
      if (!el) return;
      const down = (e) => {
        e.preventDefault();
        el.setPointerCapture?.(e.pointerId);
        el.classList.add('is-pressed');
        this.buttonSteer = dir;
        this._activeButton = el;
      };
      const up = (e) => {
        e.preventDefault();
        el.classList.remove('is-pressed');
        if (this._activeButton === el) {
          this._activeButton = null;
          this.buttonSteer = 0;
        }
      };
      add(el, 'pointerdown', down);
      add(el, 'pointerup', up);
      add(el, 'pointercancel', up);
      add(el, 'pointerleave', up);
      add(el, 'contextmenu', (e) => e.preventDefault());
    };

    holdButton(this._buttons.left, -1);
    holdButton(this._buttons.right, 1);

    const tap = (el, action) => {
      if (!el) return;
      add(el, 'click', (e) => {
        e.preventDefault();
        this.onAction(action);
      });
    };
    tap(this._buttons.pause, 'pause');
    tap(this._buttons.mute, 'mute');
  }

  _onKeyDown(e) {
    const { code } = e;
    if (LEFT_CODES.has(code) || RIGHT_CODES.has(code) || code === 'Space') e.preventDefault();

    if (LEFT_CODES.has(code)) this.keys.left = true;
    if (RIGHT_CODES.has(code)) this.keys.right = true;

    switch (code) {
      case 'Escape':
      case 'KeyP':
        this.onAction('pause');
        break;
      case 'KeyR':
        this.onAction('restart');
        break;
      case 'Enter':
      case 'Space':
        this.onAction('confirm');
        break;
      case 'KeyM':
        this.onAction('mute');
        break;
      default:
        break;
    }
  }

  _onKeyUp(e) {
    if (LEFT_CODES.has(e.code)) this.keys.left = false;
    if (RIGHT_CODES.has(e.code)) this.keys.right = false;
  }

  /* drag steering: grab anywhere on the playfield and slide ----------------- */

  _onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.dragActive = true;
    this.pointerId = e.pointerId;
    this.dragOriginX = e.clientX;
    this.dragSteer = 0;
    this.canvas.setPointerCapture?.(e.pointerId);
    this.onAction('pointerdown');
  }

  _onPointerMove(e) {
    if (!this.dragActive || e.pointerId !== this.pointerId) return;
    const delta = e.clientX - this.dragOriginX;
    this.dragSteer = clamp(delta / this.dragRange, -1, 1);
  }

  _onPointerUp(e) {
    if (!this.dragActive || (e && e.pointerId !== this.pointerId)) return;
    this.dragActive = false;
    this.pointerId = null;
    this.dragSteer = 0;
    this.onAction('pointerup');
  }

  /* ------------------------------------------------------------------ */

  releaseAll() {
    this.keys.left = false;
    this.keys.right = false;
    this.buttonSteer = 0;
    this.dragSteer = 0;
    this.dragActive = false;
  }

  /** Update the smoothed analog axis. Call once per frame. */
  update(dt) {
    const keyed = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
    let target = keyed + this.buttonSteer;
    if (this.dragActive) target = clamp(this.dragSteer, -1, 1);
    target = clamp(target, -1, 1);

    // snappier response than the ship physics so keys still feel immediate
    this.axis += (target - this.axis) * Math.min(1, dt * 16);
    if (Math.abs(this.axis) < 0.002) this.axis = 0;
    return this.axis;
  }

  dispose() {
    this._handlers.forEach((off) => off());
    this._handlers.length = 0;
  }
}
