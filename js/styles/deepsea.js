// Deep Sea: a bioluminescent ocean you look down into. Jellyfish glow and pulse with the bass,
// thrusting upward on each beat with their tentacles trailing. A school of fish swirls through
// the middle of the water, scattering on the beat and regrouping. Plankton sparkles on the highs,
// light rays fall from the surface, and bubbles rise and drift out of the glass toward you.
//
// Interaction: the fish school follows your pointer, and the plankton lights up around it. Tap a
// bubble to pop it. Tap a jellyfish and it flashes and jets away. Tap open water and the school
// bolts from that spot.
//
// Variations:
//   Reef     sunlit water, the school front and centre
//   Abyss    almost dark: the jellyfish and plankton carry the light
//   Current  everything streams sideways in a strong current

import { POINT_SIZE_GLSL, COLOR_GLSL, NOISE_GLSL, EDGE_FADE_GLSL, QUAD_VERT, Palette, Blend, Flyers, resample, rand, disposeTree } from './common.js';

const JELLIES = 7;
const TENTACLES = 8;
const TSEG = 14;
const FISH = 150;
const PLANKTON = 2200;

const LAYOUTS = [
  { rays: 1, glow: 0.8, fish: 1, current: 0, water: 1 },      // Reef
  { rays: 0.15, glow: 1.6, fish: 0.45, current: 0, water: 0.35 }, // Abyss
  { rays: 0.7, glow: 1, fish: 1, current: 1, water: 0.8 },     // Current
];

export default class DeepSeaStyle {
  static meta = {
    id: 'deepsea',
    name: 'Deep Sea',
    blurb: 'Glowing jellyfish and a fish school that follows your pointer. Pop the bubbles.',
  };
  static bloom = { strength: 0.75, radius: 0.55, threshold: 0.45 };
  // Water teal, jelly pink, jelly violet, fish gold, deep blue.
  static palette = ['#2ec4b6', '#ff6fb5', '#8a6bff', '#ffcf6b', '#0b3a66'];
  static variations = ['Reef', 'Abyss', 'Current'];
  static drift = { yaw: 0.08, pitch: 0.04 };

  constructor(THREE) {
    this.T = THREE;
    this.group = new THREE.Group();
    this.pal = new Palette(THREE, DeepSeaStyle.palette);
    this.layout = new Blend(LAYOUTS[0]);
    this.bands = new Float32Array(16);
    this.t = 0;
    this.c = new THREE.Color();
    this.v = new THREE.Vector3();
    this.v2 = new THREE.Vector3();
    this.pointer = new THREE.Vector3(0, 0, -0.02);
    this.pointerOn = 0;
    this.scatter = null;      // { x, y, z, t } a bolt point

    // Water: a deep gradient with light rays falling from the surface.
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uRays: { value: 1 }, uWater: { value: 1 }, uLevel: { value: 0 }, uPal: this.pal.uniform },
      depthWrite: false,
      vertexShader: QUAD_VERT,
      fragmentShader: NOISE_GLSL + COLOR_GLSL + /* glsl */`
        uniform float uTime, uRays, uWater, uLevel;
        varying vec2 vUv;
        void main() {
          vec3 deep = uPal[4] * 0.18, shallow = mix(uPal[0], uPal[4], 0.45) * 0.75;
          vec3 c = mix(deep, shallow, pow(vUv.y, 1.6)) * uWater;
          // God rays: slanted bright bands that shimmer, strongest near the surface.
          float x = vUv.x * 7.0 + vUv.y * 1.8;
          float rays = smoothstep(0.35, 1.0, snoise(vec3(x, 0.0, uTime * 0.12)) * 0.5 + 0.5);
          rays *= smoothstep(0.1, 1.0, vUv.y) * (0.55 + 0.45 * snoise(vec3(x * 2.0, vUv.y * 3.0, uTime * 0.3)));
          c += mix(uPal[0], vec3(1.0), 0.5) * rays * 0.35 * uRays * (0.8 + uLevel * 0.6);
          gl_FragColor = vec4(toLinear(c), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.36), this.waterMat);
    water.position.z = -0.15;
    water.renderOrder = -2;
    this.group.add(water);

    // Jellyfish: a glowing bell with a rim of tentacles.
    this.bellMat = new THREE.ShaderMaterial({
      uniforms: { uGlow: { value: 1 }, uPal: this.pal.uniform },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        attribute vec3 instanceTint;
        varying vec3 vN; varying vec3 vV; varying float vY; varying vec3 vTint;
        void main() {
          vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
          vV = normalize(cameraPosition - w.xyz);
          vY = position.y;
          vTint = instanceTint;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: COLOR_GLSL + /* glsl */`
        uniform float uGlow;
        varying vec3 vN; varying vec3 vV; varying float vY; varying vec3 vTint;
        void main() {
          float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
          float bands = 0.75 + 0.25 * sin(vY * 40.0);
          vec3 c = vTint * (0.12 + rim * 1.1 * bands) * uGlow;
          gl_FragColor = vec4(toLinear(c), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const bell = new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.55);
    this.bells = new THREE.InstancedMesh(bell, this.bellMat, JELLIES);
    this.bells.frustumCulled = false;
    this.tint = new Float32Array(JELLIES * 3);
    bell.setAttribute('instanceTint', new THREE.InstancedBufferAttribute(this.tint, 3));
    this.group.add(this.bells);
    this.jelly = Array.from({ length: JELLIES }, (_, i) => this._newJelly(i, true));
    // Tentacles: one LineSegments for all of them, positions rebuilt each frame.
    this.tPos = new Float32Array(JELLIES * TENTACLES * (TSEG - 1) * 6);
    this.tCol = new Float32Array(this.tPos.length);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.tPos, 3));
    tg.setAttribute('color', new THREE.BufferAttribute(this.tCol, 3));
    this.tentacles = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.tentacles.frustumCulled = false;
    this.group.add(this.tentacles);

    // Fish: a school of small slim bodies, each steering toward a slot around a moving target.
    const body = new THREE.ConeGeometry(0.0011, 0.0055, 5);
    body.rotateX(Math.PI / 2);   // nose along +z, so lookAt points it where it swims
    this.fish = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.6 }), FISH);
    this.fish.frustumCulled = false;
    this.fish.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.fish);
    this.fp = new Float32Array(FISH * 3);
    this.fv = new Float32Array(FISH * 3);
    this.slot = new Float32Array(FISH * 4);   // offset around the school centre + phase
    for (let i = 0; i < FISH; i++) {
      this.fp.set([rand(-0.05, 0.05), rand(-0.03, 0.03), rand(-0.06, -0.01)], i * 3);
      const r = Math.cbrt(Math.random()) * 0.022;
      const th = Math.random() * Math.PI * 2, ph = Math.acos(rand(-1, 1));
      this.slot.set([Math.sin(ph) * Math.cos(th) * r * 1.6, Math.sin(ph) * Math.sin(th) * r * 0.7, Math.cos(ph) * r, Math.random() * 6.28], i * 4);
      this.fish.setColorAt(i, this.c.set('#ffffff'));
    }
    this.target = new THREE.Vector3();
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.up = new THREE.Vector3(0, 1, 0);
    this.obj = new THREE.Object3D();
    const hemi = new THREE.HemisphereLight('#9fe8ff', '#0b2040', 2.4);
    const sun = new THREE.DirectionalLight('#e6fbff', 2);
    sun.position.set(0.2, 1, 0.4);
    this.group.add(hemi, sun);

    // Plankton: specks through the whole volume, lit by the highs and by the pointer.
    const pp = new Float32Array(PLANKTON * 3);
    for (let i = 0; i < PLANKTON; i++) {
      const z = rand(-0.13, 0.04);
      const k = z > 0.012 ? 0.75 : 1;
      pp.set([rand(-0.13, 0.13) * k, rand(-0.075, 0.075) * k, z], i * 3);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
    this.plankMat = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 1000 }, uTime: { value: 0 }, uTreble: { value: 0 }, uPointer: { value: this.pointer }, uPointerOn: { value: 0 }, uGlow: { value: 1 }, uPal: this.pal.uniform },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: POINT_SIZE_GLSL + EDGE_FADE_GLSL + /* glsl */`
        uniform float uTime, uTreble, uPointerOn, uGlow;
        uniform vec3 uPointer;
        varying float vB;
        void main() {
          vec3 p = position;
          float h = fract(sin(dot(p.xy, vec2(12.9, 78.2))) * 43758.5);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float near = exp(-pow(length(p - uPointer) / 0.022, 2.0)) * uPointerOn;
          float tw = 0.5 + 0.5 * sin(uTime * (2.0 + h * 5.0) + h * 40.0);
          vB = (0.08 + uTreble * 0.9 * tw * step(0.6, h) + near * 1.6) * uGlow * edgeFade(p);
          gl_PointSize = max(1.0, pointPx(0.0007 + near * 0.0008, mv));
        }`,
      fragmentShader: COLOR_GLSL + /* glsl */`
        varying float vB;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(toLinear(mix(uPal[0], vec3(0.8, 1.0, 1.0), 0.4)) * vB * smoothstep(0.5, 0.0, d), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.plankton = new THREE.Points(pg, this.plankMat);
    this.plankton.frustumCulled = false;
    this.group.add(this.plankton);

    // Bubbles: rise from the deep and drift out of the glass. Tappable.
    this.bubbles = new Flyers(THREE, new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshStandardMaterial({ roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.55, emissive: '#1a4a66' }), 90);
    this.bubbles.drag = 0.4;
    this.bubbles.gravity = -0.012;   // buoyant
    this.group.add(this.bubbles.mesh);
    this.bubbleClock = 0;
  }

  setPalette(rgbs) { this.pal.set(rgbs); }
  setVariation(i) { this.layout.to(LAYOUTS[i % LAYOUTS.length]); }

  _newJelly(i, anywhere) {
    return {
      x: rand(-0.08, 0.08), y: anywhere ? rand(-0.06, 0.05) : -0.09, z: rand(-0.1, 0.01),
      size: rand(0.007, 0.013), phase: Math.random() * 6.28, vy: 0, vx: 0, vz: 0,
      hue: Math.floor(rand(1, 3)), flash: 0, jet: 0,
      trail: Array.from({ length: TENTACLES }, () => Array.from({ length: TSEG }, () => new this.T.Vector3())),
      init: false,
    };
  }

  update(a, dt) {
    const T = this.T;
    this.pal.update(dt);
    const L = this.layout.update(dt, 0.7);
    this.t += dt;
    resample(a.bands, 16, this.bands);
    const current = L.current * 0.02;
    this.waterMat.uniforms.uTime.value = this.t;
    this.waterMat.uniforms.uRays.value = L.rays;
    this.waterMat.uniforms.uWater.value = L.water;
    this.waterMat.uniforms.uLevel.value = a.level;
    this.bellMat.uniforms.uGlow.value = L.glow * (0.8 + a.bass * 0.6);
    this.plankMat.uniforms.uTime.value = this.t;
    this.plankMat.uniforms.uTreble.value = a.treble;
    this.plankMat.uniforms.uGlow.value = 0.6 + L.glow * 0.5;
    this.pointerOn *= Math.exp(-dt * 1.5);
    this.plankMat.uniforms.uPointerOn.value = this.pointerOn;

    // Jellyfish: a pulse every so often (sooner with the bass), each one a thrust upward.
    for (let i = 0; i < JELLIES; i++) {
      const j = this.jelly[i];
      j.phase += dt * (1.6 + a.bass * 3 + j.jet * 6);
      const pulse = Math.max(0, Math.sin(j.phase));          // contraction
      j.vy += (pulse * pulse * 0.02 + j.jet * 0.06) * dt;
      j.vy *= Math.exp(-dt * 1.4);
      j.vx += (current * 0.6 - j.vx) * dt * 0.5;
      j.vz *= Math.exp(-dt * 1.2);
      j.x += j.vx * dt; j.y += (j.vy - 0.002) * dt; j.z += j.vz * dt;
      j.flash *= Math.exp(-dt * 2.5);
      j.jet *= Math.exp(-dt * 1.5);
      if (j.z > 0.03) { j.z = 0.03; j.vz = 0; }
      if (j.y > 0.09 || Math.abs(j.x) > 0.16) { this.jelly[i] = this._newJelly(i, false); continue; }
      const s = j.size * (1 + a.bass * 0.15);
      this.obj.position.set(j.x, j.y, j.z);
      this.obj.rotation.set(Math.sin(j.phase * 0.3) * 0.15, 0, Math.sin(j.phase * 0.23) * 0.2);
      this.obj.scale.set(s * (1 + pulse * 0.12), s * (1 - pulse * 0.25), s * (1 + pulse * 0.12));
      this.obj.updateMatrix();
      this.bells.setMatrixAt(i, this.obj.matrix);
      this.pal.color(j.hue, this.c).multiplyScalar(1 + j.flash * 2.5);
      this.tint.set([this.c.r, this.c.g, this.c.b], i * 3);

      // Tentacles hang from the rim and follow it with a lag, so they trail when it moves.
      for (let k = 0; k < TENTACLES; k++) {
        const th = (k / TENTACLES) * Math.PI * 2;
        const tr = j.trail[k];
        const rx = j.x + Math.cos(th) * s * 0.8, rz = j.z + Math.sin(th) * s * 0.8;
        if (!j.init) for (let q = 0; q < TSEG; q++) tr[q].set(rx, j.y - q * 0.0025, rz);
        tr[0].set(rx, j.y, rz);
        for (let q = 1; q < TSEG; q++) {
          const prev = tr[q - 1], cur = tr[q];
          const sway = Math.sin(this.t * 2 + q * 0.6 + k) * 0.0004;
          cur.x += (prev.x + sway - cur.x) * Math.min(1, dt * 9);
          cur.z += (prev.z - cur.z) * Math.min(1, dt * 9);
          cur.y += (prev.y - 0.0026 - cur.y) * Math.min(1, dt * 12);
          const o = (((i * TENTACLES + k) * (TSEG - 1)) + q - 1) * 6;
          this.tPos.set([prev.x, prev.y, prev.z, cur.x, cur.y, cur.z], o);
          const f = (1 - q / TSEG) * 0.55 * (L.glow * 0.8 + j.flash * 2);
          this.tCol.set([this.c.r * f, this.c.g * f, this.c.b * f, this.c.r * f * 0.8, this.c.g * f * 0.8, this.c.b * f * 0.8], o);
        }
      }
      j.init = true;
    }
    this.bells.instanceMatrix.needsUpdate = true;
    this.bells.geometry.attributes.instanceTint.needsUpdate = true;
    this.tentacles.geometry.attributes.position.needsUpdate = true;
    this.tentacles.geometry.attributes.color.needsUpdate = true;

    // The school: its target wanders, or follows the pointer while it's over the water.
    const wander = this.v2.set(Math.sin(this.t * 0.31) * 0.06, Math.sin(this.t * 0.47) * 0.025, -0.03 + Math.sin(this.t * 0.23) * 0.025);
    this.target.lerp(this.pointerOn > 0.3 ? this.pointer : wander, Math.min(1, dt * 1.6));
    if (a.beat > 0.95) this.scatter = { x: this.target.x, y: this.target.y, z: this.target.z, t: 1.2, k: 0.08 + a.bass * 0.06 };
    const sc = this.scatter;
    if (sc) { sc.t -= dt; if (sc.t <= 0) this.scatter = null; }
    this.pal.color(3, this.c);
    const gold = this.c.clone(), alt = this.pal.color(0, new T.Color());
    for (let i = 0; i < FISH; i++) {
      const o = i * 3, s4 = i * 4;
      const ang = this.t * 0.9 + this.slot[s4 + 3];
      const ox = this.slot[s4] * Math.cos(ang) - this.slot[s4 + 2] * Math.sin(ang);
      const oz = this.slot[s4] * Math.sin(ang) + this.slot[s4 + 2] * Math.cos(ang);
      let dx = this.target.x + ox - this.fp[o], dy = this.target.y + this.slot[s4 + 1] - this.fp[o + 1], dz = this.target.z + oz - this.fp[o + 2];
      let ax = dx * 3, ay = dy * 3, az = dz * 3;
      if (sc) {   // bolt away from the scatter point
        const ex = this.fp[o] - sc.x, ey = this.fp[o + 1] - sc.y, ez = this.fp[o + 2] - sc.z;
        const d2 = Math.max(1e-4, ex * ex + ey * ey + ez * ez);
        const k = sc.k * sc.t / d2 * 0.02;
        ax += ex * k; ay += ey * k; az += ez * k;
      }
      ax -= current * 1.5;   // swimming into the current
      this.fv[o] += ax * dt; this.fv[o + 1] += ay * dt; this.fv[o + 2] += az * dt;
      const sp = Math.hypot(this.fv[o], this.fv[o + 1], this.fv[o + 2]), max = 0.07 + a.level * 0.05;
      if (sp > max) { this.fv[o] *= max / sp; this.fv[o + 1] *= max / sp; this.fv[o + 2] *= max / sp; }
      this.fv[o] *= Math.exp(-dt * 0.8); this.fv[o + 1] *= Math.exp(-dt * 0.8); this.fv[o + 2] *= Math.exp(-dt * 0.8);
      this.fp[o] += (this.fv[o] + current) * dt; this.fp[o + 1] += this.fv[o + 1] * dt;
      this.fp[o + 2] = Math.min(0.03, this.fp[o + 2] + this.fv[o + 2] * dt);
      this.obj.position.set(this.fp[o], this.fp[o + 1], this.fp[o + 2]);
      this.v.set(this.fp[o] + this.fv[o] + current, this.fp[o + 1] + this.fv[o + 1], this.fp[o + 2] + this.fv[o + 2]);
      this.obj.scale.setScalar(L.fish > 0.6 || i % 2 === 0 ? 1 : 0.0001);
      this.obj.lookAt(this.v);
      this.obj.updateMatrix();
      this.fish.setMatrixAt(i, this.obj.matrix);
      this.c.copy(i % 5 === 0 ? alt : gold).multiplyScalar((0.6 + this.bands[i % 16] * 0.8) * (0.4 + L.fish * 0.6));
      this.fish.setColorAt(i, this.c);
    }
    this.fish.instanceMatrix.needsUpdate = true;
    this.fish.instanceColor.needsUpdate = true;

    // Plankton drifts with the current and slowly rises.
    const pp = this.plankton.geometry.attributes.position;
    for (let i = 0; i < pp.count; i++) {
      let x = pp.getX(i) + (current * 1.4 + Math.sin(this.t * 0.4 + i) * 0.0008) * dt;
      let y = pp.getY(i) + 0.0012 * dt;
      if (x > 0.14) x = -0.14; if (x < -0.14) x = 0.14;
      if (y > 0.078) y = -0.078;
      pp.setX(i, x); pp.setY(i, y);
    }
    pp.needsUpdate = true;

    // Bubbles: a steady trickle, a column on each beat.
    this.bubbleClock += dt * (1.5 + a.level * 4);
    while (this.bubbleClock > 1) {
      this.bubbleClock -= 1;
      this._bubble(rand(-0.09, 0.09), rand(-0.1, -0.02), 1);
    }
    if (a.beat > 0.95) {
      const x = rand(-0.06, 0.06), z = rand(-0.06, -0.01);
      for (let k = 0; k < 5; k++) this._bubble(x + rand(-0.004, 0.004), z, 0.8 + k * 0.1);
    }
    for (let i = 0; i < this.bubbles.n; i++) if (this.bubbles.life[i] > 0) this.bubbles.v[i * 3] += current * 0.8 * dt;
    this.bubbles.update(dt, 1);
  }

  _bubble(x, z, k) {
    this.c.set('#cfeeff');
    this.bubbles.spawn(x, -0.075, z, rand(-0.002, 0.002), rand(0.006, 0.014), rand(0.012, 0.03) * k,
      { life: rand(4, 6), size: rand(0.0016, 0.0034), color: this.c, spin: 0.5 });
  }

  // ---- interaction ----

  get targets() { return [this.bubbles]; }

  popped(pool, i, info) {
    // A popped bubble lights the plankton around it.
    this.pointer.set(info.x, info.y, info.z);
    this.pointerOn = 1;
  }

  tap(ray, fx) {
    const local = fx.toLocal(ray, this.group);
    // A jellyfish? It flashes and jets up and toward you.
    for (const j of this.jelly) {
      if (local.distanceToPoint(this.v.set(j.x, j.y, j.z)) < j.size * 1.4 + 0.003) {
        j.flash = 1; j.jet = 1; j.vz = 0.02;
        fx.burst(this.v.applyMatrix4(this.group.matrixWorld), this.pal.color(j.hue, new this.T.Color()), 0.7);
        return true;
      }
    }
    // Open water: the school bolts from where you tapped.
    const t = Math.abs(local.direction.z) > 1e-4 ? (this.target.z - local.origin.z) / local.direction.z : -1;
    if (t <= 0) return false;
    const p = local.at(t, this.v);
    this.scatter = { x: p.x, y: p.y, z: p.z, t: 1.5, k: 0.2 };
    return false;   // the glass still ripples
  }

  hover(ray) {
    const local = ray.clone().applyMatrix4(new this.T.Matrix4().copy(this.group.matrixWorld).invert());
    if (Math.abs(local.direction.z) < 1e-4) return;
    const t = (-0.02 - local.origin.z) / local.direction.z;
    if (t <= 0) return;
    local.at(t, this.pointer);
    this.pointerOn = 1;
  }

  get cursorTargets() { return [this.bells]; }

  beforeRender(vpH) { this.plankMat.uniforms.uViewportH.value = vpH; }

  dispose() { disposeTree(this.group); }
}
