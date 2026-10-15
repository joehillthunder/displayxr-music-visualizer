// Lo-Fi Room: a chunky voxel spectrogram. The newest row of the spectrum is at the front and
// older rows scroll away from it. Each bar wears a glowing cap, a low-poly moon hangs in the
// back, rain streaks down a pane in front of the glass, dust drifts through the room, and on
// each beat the loudest bars throw voxel sparks out of the screen toward you.
//
// Variations:
//   Table      the deck tilts away into the screen, like looking down at a desk
//   Wall       the deck turns to face you and the bars extrude straight out of the glass
//   Turntable  a smaller deck spins slowly in mid-air, its front edge sweeping out toward you

import { FRAME_W, POINT_SIZE_GLSL, COLOR_GLSL, QUAD_VERT, Palette, Blend, Flyers, resample, rand, disposeTree } from './common.js';

const COLS = 32;
const ROWS = 22;
const STEP = 0.004;         // heights snap to this, for the stepped "pixel" feel
const ROW_DT = 1 / 14;      // seconds per history row
const RAIN = 220;
const PITCH_Z = 0.0058;
const DECK_Z = (ROWS - 1) * PITCH_Z / 2;   // the deck is centred on the table's origin

const LAYOUTS = [
  { rx: 0.42, py: -0.019, pz: -0.044, scale: 1, hScale: 1, spin: 0 },     // Table
  { rx: 1.35, py: 0, pz: -0.022, scale: 0.8, hScale: 1.5, spin: 0 },     // Wall
  { rx: 0.62, py: -0.008, pz: -0.022, scale: 0.5, hScale: 1.6, spin: 0.22 }, // Turntable
];

export default class LofiStyle {
  static meta = {
    id: 'lofi',
    name: 'Lo-Fi Room',
    blurb: 'Voxel spectrogram with glowing caps and voxel sparks, a low-poly moon and rain on the glass.',
  };
  static bloom = { strength: 0.35, radius: 0.3, threshold: 0.85 };
  static palette = ['#ffb38a', '#ff7f9f', '#ffd6a0', '#5b6c9a', '#ffe9c4'];
  static variations = ['Table', 'Wall', 'Turntable'];
  static drift = { yaw: 0.08, pitch: 0.03 };

  constructor(THREE) {
    this.T = THREE;
    this.group = new THREE.Group();
    this.pal = new Palette(THREE, LofiStyle.palette);
    this.hist = Array.from({ length: ROWS }, () => new Float32Array(COLS));
    this.cur = new Float32Array(COLS);
    this.acc = 0;
    this.t = 0;
    this.yaw = 0;
    this.layout = new Blend(LAYOUTS[0]);
    this.variation = 0;

    this.table = new THREE.Group();
    this.group.add(this.table);
    this.deck = new THREE.Group();
    this.deck.position.z = DECK_Z;
    this.table.add(this.deck);

    const pitchX = (FRAME_W * 0.94) / COLS;
    this.pitchX = pitchX;
    const box = new THREE.BoxGeometry(pitchX * 0.8, 1, PITCH_Z * 0.78);
    box.translate(0, 0.5, 0);   // grow upward from the deck
    this.bars = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, flatShading: true }), COLS * ROWS);
    this.bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.deck.add(this.bars);
    // Glowing caps: a thin bright slab on top of each bar, brighter the louder it is.
    const cap = new THREE.BoxGeometry(pitchX * 0.8, 0.0012, PITCH_Z * 0.78);
    this.caps = new THREE.InstancedMesh(cap, new THREE.MeshBasicMaterial(), COLS * ROWS);
    this.caps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.deck.add(this.caps);

    this.tmpC = new THREE.Color();
    this.backC = new THREE.Color();
    this.front = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
    this.m = new THREE.Matrix4();
    this.v3 = new THREE.Vector3();

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(FRAME_W * 0.99, 0.002, ROWS * PITCH_Z + 0.006),
      new THREE.MeshStandardMaterial({ color: '#241d38', roughness: 0.9 }),
    );
    floor.position.set(0, -0.001, -DECK_Z);
    this.deck.add(floor);

    // Voxel sparks thrown off the loudest bars on each beat.
    this.sparks = new Flyers(THREE, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 160);
    this.sparks.drag = 1.1;
    this.sparks.gravity = 0.006;
    this.group.add(this.sparks.mesh);

    // Low-poly moon with a soft halo, behind the glass.
    this.moonMat = new THREE.ShaderMaterial({
      uniforms: { uPal: this.pal.uniform, uGlow: { value: 0 } },
      transparent: true, depthWrite: false,
      vertexShader: QUAD_VERT,
      fragmentShader: COLOR_GLSL + /* glsl */`
        uniform float uGlow;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv - 0.5;
          // A 10-sided polygon for the low-poly look.
          float a = atan(p.y, p.x), seg = 6.2832 / 10.0;
          float r = length(p) * cos(mod(a, seg) - seg * 0.5);
          float disc = step(r, 0.19);
          float halo = smoothstep(0.45, 0.2, r) * (0.25 + uGlow * 0.3);
          vec3 moon = mix(uPal[4], vec3(1.0, 0.97, 0.9), 0.4) * (0.78 + uGlow * 0.15);
          vec3 col = mix(uPal[1] * 0.8 * halo, moon, disc);
          gl_FragColor = vec4(toLinear(col), max(disc, halo));
          #include <colorspace_fragment>
        }`,
    });
    this.moon = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.13), this.moonMat);
    this.moon.position.set(0.055, 0.03, -0.1);
    this.moon.renderOrder = -1;
    this.group.add(this.moon);

    // Dust motes through the whole room, the nearest ones well out in front of the glass.
    const N = 420;
    const pos = new Float32Array(N * 3);
    this.dustV = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const z = rand(-0.08, 0.045);
      const k = z > 0.015 ? 0.7 : 1;   // pop-out dust stays nearer the middle
      pos.set([rand(-0.12, 0.12) * k, rand(-0.07, 0.07) * k, z], i * 3);
      this.dustV[i] = rand(0.002, 0.007);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 1000 }, uGlow: { value: 0 }, uPal: this.pal.uniform },
      vertexShader: POINT_SIZE_GLSL + /* glsl */`
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.5, pointPx(0.0009, mv));
        }`,
      fragmentShader: COLOR_GLSL + /* glsl */`
        uniform float uGlow;
        void main() {
          vec2 d = abs(gl_PointCoord - 0.5);
          if (max(d.x, d.y) > 0.42) discard;      // square "pixel" dust
          gl_FragColor = vec4(toLinear(mix(uPal[2], vec3(1.0), 0.5) * (0.5 + uGlow)), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.dust = new THREE.Points(g, this.dustMat);
    this.dust.frustumCulled = false;
    this.group.add(this.dust);

    // Rain on a pane in front of the glass: short streaks, faster with the music.
    const rp = new Float32Array(RAIN * 6);
    this.rain = new Float32Array(RAIN * 4);   // x, y, z, speed
    for (let i = 0; i < RAIN; i++) this.rain.set([rand(-0.11, 0.11), rand(-0.07, 0.07), rand(0.004, 0.032), rand(0.06, 0.12)], i * 4);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    this.rainMat = new THREE.LineBasicMaterial({ color: '#9fb6ff', transparent: true, opacity: 0.35, depthWrite: false });
    this.rainLines = new THREE.LineSegments(rg, this.rainMat);
    this.rainLines.frustumCulled = false;
    this.group.add(this.rainLines);

    this.hemi = new THREE.HemisphereLight('#ffd2b0', '#30264a', 1.5);
    const key = new THREE.DirectionalLight('#ffc9a3', 1.6);
    key.position.set(-0.4, 0.8, 0.6);
    this.rim = new THREE.PointLight('#ff9fc0', 0.02, 0.4, 1.5);
    this.rim.position.set(0.055, 0.03, -0.08);
    this.group.add(this.hemi, key, this.rim);
  }

  setPalette(rgbs) { this.pal.set(rgbs); }

  setVariation(i) {
    this.variation = i % LAYOUTS.length;
    this.layout.to(LAYOUTS[this.variation]);
  }

  update(a, dt) {
    const T = this.T;
    this.t += dt;
    this.pal.update(dt);
    resample(a.bands, COLS, this.cur);
    const L = this.layout.update(dt, 0.8);

    // Table pose. A spinning layout turns continuously; leaving it, the deck settles back to the
    // nearest full turn instead of unwinding.
    if (L.spin > 0.01) this.yaw += dt * L.spin * (1 + a.level * 0.6);
    else this.yaw += (Math.round(this.yaw / (Math.PI * 2)) * Math.PI * 2 - this.yaw) * (1 - Math.exp(-dt * 1.2));
    this.table.rotation.set(L.rx, this.yaw, 0);
    this.table.position.set(0, L.py, L.pz);
    this.table.scale.setScalar(L.scale);

    this.acc += dt;
    while (this.acc >= ROW_DT) {
      this.acc -= ROW_DT;
      this.hist.unshift(this.hist.pop());
    }
    this.hist[0].set(this.cur);

    for (let k = 0; k < 3; k++) this.pal.color(k, this.front[k]);
    this.pal.color(3, this.backC).multiplyScalar(0.7);
    let i = 0;
    for (let r = 0; r < ROWS; r++) {
      const fade = r / (ROWS - 1);
      for (let c = 0; c < COLS; c++, i++) {
        const v = this.hist[r][c];
        const h = Math.max(STEP, Math.round((0.002 + v * v * 0.05 * L.hScale) / STEP) * STEP);
        const x = (c - (COLS - 1) / 2) * this.pitchX;
        const z = -r * PITCH_Z;
        this.m.makeScale(1, h, 1).setPosition(x, 0, z);
        this.bars.setMatrixAt(i, this.m);
        this.m.makeTranslation(x, h + 0.0006, z);
        this.caps.setMatrixAt(i, this.m);
        this.tmpC.copy(this.front[(c + r) % 3]).lerp(this.backC, Math.min(1, fade * 1.1));
        const lum = Math.round((0.5 + v * 0.7) * 4) / 4;      // a limited, stepped palette
        this.bars.setColorAt(i, this.tmpC.multiplyScalar(lum));
        this.tmpC.copy(this.front[(c + r) % 3]).multiplyScalar((0.4 + v * v * 1.6) * (1 - fade * 0.75));
        this.caps.setColorAt(i, this.tmpC);
      }
    }
    this.bars.instanceMatrix.needsUpdate = true;
    this.bars.instanceColor.needsUpdate = true;
    this.caps.instanceMatrix.needsUpdate = true;
    this.caps.instanceColor.needsUpdate = true;

    // Beat: sparks from the tops of the loudest front-row bars, up and out toward you.
    if (a.beat > 0.95) {
      this.table.updateMatrix();
      this.deck.updateMatrix();
      const row = this.hist[0];
      const order = [...row.keys()].sort((p, q) => row[q] - row[p]).slice(0, 3 + Math.floor(a.bass * 5));
      for (const c of order) {
        const h = 0.002 + row[c] * row[c] * 0.05 * L.hScale;
        this.v3.set((c - (COLS - 1) / 2) * this.pitchX, h, 0).applyMatrix4(this.deck.matrix).applyMatrix4(this.table.matrix);
        for (let k = 0; k < 2; k++) {
          this.sparks.spawn(this.v3.x, this.v3.y, this.v3.z,
            rand(-0.008, 0.008), rand(0.012, 0.03), rand(0.035, 0.07),
            { life: rand(1.3, 2.0), size: rand(0.0022, 0.0038), color: this.front[c % 3], spin: 4 });
        }
      }
    }
    this.sparks.update(dt, 1.4);

    // Tape wow: a slow, slightly uneven sway.
    this.group.rotation.y = Math.sin(this.t * 0.31) * 0.05 + Math.sin(this.t * 0.83) * 0.012;

    const s = 1 + a.bass * 0.15 + a.beat * 0.05;
    this.moon.scale.setScalar(s);
    this.moonMat.uniforms.uGlow.value = a.bass * 0.8 + a.beat * 0.4;
    this.rim.intensity = 0.01 + a.bass * 0.04;
    this.pal.color(1, this.rim.color);

    const p = this.dust.geometry.attributes.position;
    for (let k = 0; k < p.count; k++) {
      let y = p.getY(k) + this.dustV[k] * dt * (1 + a.level * 3);
      if (y > 0.07) y = -0.07;
      p.setY(k, y);
    }
    p.needsUpdate = true;
    this.dustMat.uniforms.uGlow.value = a.treble * 0.8;

    const rp = this.rainLines.geometry.attributes.position.array;
    const speed = 0.6 + a.level * 1.5;
    for (let k = 0; k < RAIN; k++) {
      const o = k * 4;
      this.rain[o + 1] -= this.rain[o + 3] * dt * speed;
      if (this.rain[o + 1] < -0.075) { this.rain[o + 1] = 0.075; this.rain[o] = rand(-0.11, 0.11); }
      const len = 0.003 + this.rain[o + 3] * 0.03;
      rp.set([this.rain[o], this.rain[o + 1], this.rain[o + 2], this.rain[o], this.rain[o + 1] + len, this.rain[o + 2]], k * 6);
    }
    this.rainLines.geometry.attributes.position.needsUpdate = true;
    this.rainMat.opacity = 0.18 + a.treble * 0.4;
  }

  // Interaction (js/interact.js): the voxel sparks can be tapped and swatted.
  get targets() { return [this.sparks]; }

  beforeRender(vpH) { this.dustMat.uniforms.uViewportH.value = vpH; }

  dispose() { disposeTree(this.group); }
}
