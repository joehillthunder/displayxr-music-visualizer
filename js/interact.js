// Pointer interaction: turn the scene, zoom it, and pop what flies at you.
//
// - Drag to turn the scene (yaw and pitch, with inertia). Left alone for a while it eases back to
//   centre; a double-click on empty space (or R) sends it home at once. Ctrl/Cmd + wheel, a
//   trackpad pinch or a two-finger pinch zooms; so does the plain wheel in full view.
// - Tap something flying at you to pop it: it bursts into shards with a shockwave ring. A fast
//   swipe swats the flyers near the pointer aside. A tap that hits nothing poppable goes to the
//   style (style.tap); if the style has nothing to do with it, the glass ripples where it landed.
//
// On a display rig the runtime owns the eyes, so turning means turning the CONTENT (the `orbit`
// group), never moving a camera. Picking uses one camera: the mono camera in 2D, and in 3D a
// camera at the midpoint between the eyes (one cursor, one screen), never an eye camera.

import { Flyers, rand } from './styles/common.js';

const YAW_MAX = 1.1;
const PITCH_MAX = 0.55;
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.8;
const RETURN_AFTER = 9;      // seconds untouched before the view eases back to centre
const SWAT_SPEED = 1400;     // pointer speed (CSS px/s) that counts as a swipe

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Interaction {
  /**
   * @param THREE     the three.js namespace
   * @param opts.canvas    the woven canvas
   * @param opts.orbit     the group the drag turns and the zoom scales
   * @param opts.fxParent  where pop effects live (the styles' parent, so they share its space)
   * @param opts.getStyle  () => the current style
   * @param opts.getCamera () => the camera to pick with, or null when there is none yet
   * @param opts.onPop     (count) => void, after each pop
   */
  constructor(THREE, { canvas, orbit, fxParent, getStyle, getCamera, onPop }) {
    Object.assign(this, { T: THREE, canvas, orbit, fxParent, getStyle, getCamera, onPop });
    this.yaw = 0; this.pitch = 0; this.vYaw = 0; this.vPitch = 0;
    this.zoom = 1; this.zoomTarget = 1;
    this.idle = RETURN_AFTER;
    this.pops = 0;
    this.lastTapPopped = false;
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.inv = new THREE.Matrix4();
    this.m3 = new THREE.Matrix3();
    this.v = new THREE.Vector3();
    this.white = new THREE.Color(1, 1, 1);
    this.pointers = new Map();
    this.hover = null;       // last pointer position over the canvas, in NDC
    this.lastMove = null;

    // Pop effects, in fxParent's space.
    this.shards = new Flyers(THREE, new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial(), 260);
    this.shards.drag = 2.6;
    fxParent.add(this.shards.mesh);
    this.rings = Array.from({ length: 8 }, () => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.8, 1, 56),
        new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      );
      m.visible = false;
      m.userData = { t: 1, r: 0.02 };
      fxParent.add(m);
      return m;
    });
    this.nextRing = 0;
    this._bind();
  }

  // ---- per frame ----

  update(dt) {
    const dragging = this.pointers.size > 0 && this.dragged;
    if (!dragging) {
      this.idle += dt;
      // Inertia after a flick, then a slow glide home once the view has been left alone.
      this.yaw = clamp(this.yaw + this.vYaw * dt, -YAW_MAX, YAW_MAX);
      this.pitch = clamp(this.pitch + this.vPitch * dt, -PITCH_MAX, PITCH_MAX);
      const damp = Math.exp(-dt * 3.5);
      this.vYaw *= damp; this.vPitch *= damp;
      if (this.idle > RETURN_AFTER) {
        const k = 1 - Math.exp(-dt * 1.4);
        this.yaw -= this.yaw * k; this.pitch -= this.pitch * k;
        this.zoomTarget += (1 - this.zoomTarget) * k;
      }
    }
    this.zoom += (this.zoomTarget - this.zoom) * (1 - Math.exp(-dt * 8));
    this.orbit.rotation.set(this.pitch, this.yaw, 0, 'XYZ');   // turn about the vertical, then tip
    this.orbit.scale.setScalar(this.zoom);

    this.shards.update(dt, 1.6);
    for (const m of this.rings) {
      if (!m.visible) continue;
      const u = m.userData;
      u.t += dt / 0.6;
      if (u.t >= 1) { m.visible = false; continue; }
      m.scale.setScalar(u.r * (0.12 + (1 - Math.pow(1 - u.t, 3))));
      m.material.opacity = Math.pow(1 - u.t, 1.6);
    }

    if (this.hover) {
      const ray = this.worldRay(this.hover);
      if (ray) {
        this.getStyle()?.hover?.(ray, dt);
        if (!this.pointers.size) this.canvas.style.cursor = this.pick(ray) ? 'pointer' : 'grab';
      }
    }
  }

  // ---- picking ----

  worldRay(ndc) {
    const cam = this.getCamera();
    if (!cam) return null;
    this.raycaster.setFromCamera(ndc, cam);
    return this.raycaster.ray;
  }

  /** A world-space ray in `obj`'s local space. */
  toLocal(ray, obj) {
    return ray.clone().applyMatrix4(this.inv.copy(obj.matrixWorld).invert());
  }

  /** The nearest poppable object along a world ray: { pool, i, dist } or null. */
  pick(ray) {
    let best = null;
    for (const pool of this.getStyle()?.targets || []) {
      const i = pool.hit(this.toLocal(ray, pool.mesh), 0.004);
      if (i < 0) continue;
      const o = i * 3;
      const d = this.v.set(pool.p[o], pool.p[o + 1], pool.p[o + 2]).applyMatrix4(pool.mesh.matrixWorld).distanceTo(ray.origin);
      if (!best || d < best.dist) best = { pool, i, dist: d };
    }
    return best;
  }

  tap(e) {
    const ray = this.worldRay(this._ndc(e));
    if (!ray) return;
    const style = this.getStyle();
    const hit = this.pick(ray);
    this.lastTapPopped = !!hit;
    if (hit) {
      const info = hit.pool.pop(hit.i);
      style.popped?.(hit.pool, hit.i, info);
      const world = new this.T.Vector3(info.x, info.y, info.z).applyMatrix4(hit.pool.mesh.matrixWorld);
      this.burst(world, info.color, 1);
      this.pops++;
      this.onPop?.(this.pops);
      return;
    }
    if (style?.tap?.(ray.clone(), this)) return;
    // Nothing to pop and nothing the style wants: ripple the glass (z = 0) where the tap landed.
    const local = this.toLocal(ray, this.fxParent);
    if (Math.abs(local.direction.z) < 1e-4) return;
    const t = -local.origin.z / local.direction.z;
    if (t <= 0) return;
    const p = local.at(t, new this.T.Vector3());
    this.ring(p, this.white, 0.014, true);
  }

  /** Shards and a shockwave ring at a WORLD position. */
  burst(world, color, scale = 1) {
    const p = this.fxParent.worldToLocal(world.clone());
    const c = new this.T.Color();
    const n = Math.round(22 * scale);
    for (let k = 0; k < n; k++) {
      const th = Math.random() * Math.PI * 2, z = rand(-0.6, 1);
      const r = Math.sqrt(1 - z * z), sp = rand(0.03, 0.1) * scale;
      c.copy(color).lerp(this.white, rand(0, 0.5)).multiplyScalar(1.4);
      this.shards.spawn(p.x, p.y, p.z, Math.cos(th) * r * sp, Math.sin(th) * r * sp, z * sp * 0.7,
        { life: rand(0.5, 1.0), size: rand(0.0008, 0.0018) * Math.sqrt(scale), color: c, spin: 12 });
    }
    this.ring(p, color, 0.02 * scale, true);
  }

  /** A shockwave ring facing the viewer at a position in fxParent's space. */
  ring(p, color, radius = 0.02, local = true) {
    const m = this.rings[this.nextRing = (this.nextRing + 1) % this.rings.length];
    m.position.copy(local ? p : this.fxParent.worldToLocal(p.clone()));
    m.material.color.copy(color).multiplyScalar(1.5);
    m.userData.t = 0;
    m.userData.r = radius;
    m.scale.setScalar(radius * 0.12);
    m.visible = true;
  }

  reset() {
    this.idle = RETURN_AFTER;
    this.vYaw = this.vPitch = 0;
    this.zoomTarget = 1;
  }

  // ---- pointer events ----

  _ndc(e) {
    const r = this.canvas.getBoundingClientRect();
    return this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1).clone();
  }

  _pinchDist() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _swat(e, now) {
    const last = this.lastMove;
    this.lastMove = { x: e.clientX, y: e.clientY, t: now };
    if (!last || now - last.t > 80) return;
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    const speed = Math.hypot(dx, dy) / Math.max(0.001, (now - last.t) / 1000);
    if (speed < SWAT_SPEED) return;
    const ray = this.worldRay(this._ndc(e));
    if (!ray) return;
    const mag = 0.12 * Math.min(2.2, speed / SWAT_SPEED);
    const len = Math.hypot(dx, dy) || 1;
    for (const pool of this.getStyle()?.targets || []) {
      this.inv.copy(pool.mesh.matrixWorld).invert();
      this.m3.setFromMatrix4(this.inv);
      this.v.set((dx / len) * mag, (-dy / len) * mag, mag * 0.25).applyMatrix3(this.m3);
      pool.push(ray.clone().applyMatrix4(this.inv), this.v.x, this.v.y, this.v.z, 0.014);
    }
  }

  _bind() {
    const c = this.canvas;
    c.style.cursor = 'grab';
    c.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      c.setPointerCapture(e.pointerId);
      const now = performance.now();
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: now, t: now });
      if (this.pointers.size === 1) this.dragged = false;
      if (this.pointers.size === 2) { this.pinch0 = this._pinchDist(); this.zoom0 = this.zoomTarget; this.dragged = true; }
      this.vYaw = this.vPitch = 0;
      c.style.cursor = 'grabbing';
    });
    c.addEventListener('pointermove', (e) => {
      const now = performance.now();
      this.hover = this._ndc(e);
      const p = this.pointers.get(e.pointerId);
      if (!p) { if (e.pointerType === 'mouse') this._swat(e, now); return; }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      const dt = Math.max(0.008, (now - p.t) / 1000);
      p.x = e.clientX; p.y = e.clientY; p.t = now;
      if (this.pointers.size === 2) {
        if (this.pinch0 > 0) this.zoomTarget = clamp((this.zoom0 * this._pinchDist()) / this.pinch0, ZOOM_MIN, ZOOM_MAX);
        this.idle = 0;
        return;
      }
      if (!this.dragged && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 6) return;
      this.dragged = true;
      const dYaw = (dx / (c.clientWidth || 1)) * 2.6, dPitch = (dy / (c.clientHeight || 1)) * 1.4;
      this.yaw = clamp(this.yaw + dYaw, -YAW_MAX, YAW_MAX);
      this.pitch = clamp(this.pitch + dPitch, -PITCH_MAX, PITCH_MAX);
      this.vYaw = dYaw / dt; this.vPitch = dPitch / dt;
      this.idle = 0;
    });
    const end = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      this.pointers.delete(e.pointerId);
      const now = performance.now();
      if (!this.dragged && now - p.t0 < 500 && e.type === 'pointerup') this.tap(e);
      if (now - p.t > 90) { this.vYaw = 0; this.vPitch = 0; }   // released after a pause: no fling
      if (!this.pointers.size) c.style.cursor = 'grab';
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { if (!this.pointers.size) { this.hover = null; this.lastMove = null; } });
    c.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey || document.body.classList.contains('fill'))) return;   // otherwise the page scrolls
      e.preventDefault();
      this.zoomTarget = clamp(this.zoomTarget * Math.exp(-e.deltaY * 0.0015), ZOOM_MIN, ZOOM_MAX);
      this.idle = 0;
    }, { passive: false });
    c.addEventListener('dblclick', () => { if (!this.lastTapPopped) this.reset(); });
  }
}
