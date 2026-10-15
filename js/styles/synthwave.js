// Neon Horizon: an 80s synthwave road trip. A neon-gridded landscape rolls toward you out of the
// screen. The mountains on the left are shaped by the left channel's spectrum history and those
// on the right by the right channel's. A striped sun pulses with the bass, stars twinkle on the
// highs, and the live waveform hangs just in front of the glass as a laser line. On each beat a
// neon wireframe shape launches from the horizon and races down the road out toward you.
//
// Variations:
//   Road      eye level on the road, the classic view
//   Flyover   higher and faster, looking down onto the grid
//   Canyon    tall mountains crowd in close around the road

import { FRAME_W, POINT_SIZE_GLSL, COLOR_GLSL, QUAD_VERT, Palette, Blend, Flyers, resample, rand, disposeTree } from './common.js';

const SX = 72;            // grid segments across
const SZ = 56;            // grid segments deep (= spectrum history rows)
const DEPTH = 0.17;       // z from +0.045 back to -0.125
const WIDTH = FRAME_W * 1.7;
const ROW_DT = 1 / 22;
const LASER = 192;

const LAYOUTS = [
  { rx: 0, py: 0, height: 1, road: 0.12, speed: 1 },          // Road
  { rx: 0.24, py: 0.014, height: 0.75, road: 0.06, speed: 1.7 }, // Flyover
  { rx: -0.05, py: -0.004, height: 1.9, road: 0.3, speed: 0.9 }, // Canyon
];

export default class SynthwaveStyle {
  static meta = {
    id: 'synthwave',
    name: 'Neon Horizon',
    blurb: 'Stereo synthwave mountains roll out of the screen under a pulsing sun and a waveform laser.',
  };
  static bloom = { strength: 0.5, radius: 0.3, threshold: 0.78 };
  // Grid pink, grid cyan, sun top, sun bottom, sky.
  static palette = ['#ff2ebf', '#19e6ff', '#ffe14d', '#ff2a8c', '#6a0f6b'];
  static variations = ['Road', 'Flyover', 'Canyon'];
  static drift = { yaw: 0.07, pitch: 0.02 };

  constructor(THREE) {
    this.group = new THREE.Group();
    this.pal = new Palette(THREE, SynthwaveStyle.palette);
    const half = SX / 2;
    this.hist = Array.from({ length: SZ + 1 }, () => new Float32Array(2 * (half + 1)));
    this.curL = new Float32Array(half + 1);
    this.curR = new Float32Array(half + 1);
    this.acc = 0;
    this.rows = 0;
    this.layout = new Blend(LAYOUTS[0]);
    this.launch = 0;
    this.c = new THREE.Color();
    // The land (terrain, laser, flyers) is posed by the layout; sky, sun and stars stay put.
    this.land = new THREE.Group();

    // Terrain: a plane lying flat at y = -0.04, front edge at z = +0.045.
    const geo = new THREE.PlaneGeometry(WIDTH, DEPTH, SX, SZ);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, -0.04, 0.045 - DEPTH / 2);
    this.base = geo.attributes.position.array.slice();
    this.terrainMat = new THREE.ShaderMaterial({
      uniforms: { uScroll: { value: 0 }, uFlash: { value: 0 }, uPal: this.pal.uniform },
      vertexShader: /* glsl */`
        varying vec2 vUv; varying float vH; varying float vZ;
        void main() {
          vUv = uv; vH = position.y + 0.04; vZ = position.z;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: COLOR_GLSL + /* glsl */`
        uniform float uScroll, uFlash;
        varying vec2 vUv; varying float vH; varying float vZ;
        float gridLine(float v, float n) {
          float f = abs(fract(v * n) - 0.5);
          float w = fwidth(v * n);
          return 1.0 - smoothstep(0.0, w * 1.4, 0.5 - f);
        }
        void main() {
          float gx = gridLine(vUv.x, ${SX / 2}.0);
          // A cross line every second history row, riding with the rows as they roll forward.
          float gz = gridLine(uScroll - ${SZ}.0 * (1.0 - vUv.y), 0.5);
          float g = max(gx, gz);
          vec3 line = mix(uPal[0], uPal[1], clamp(vH * 22.0, 0.0, 1.0)) * (1.35 + uFlash * 0.8);
          vec3 fill = uPal[4] * 0.08 + uPal[4] * 0.35 * clamp(vH * 18.0, 0.0, 1.0);
          vec3 col = mix(fill, line, g);
          // Fade into the horizon haze.
          float far = smoothstep(-0.06, -0.125, vZ);
          col = mix(col, uPal[4] * 0.6 + uPal[3] * 0.2, far * 0.85);
          gl_FragColor = vec4(toLinear(col), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.terrain = new THREE.Mesh(geo, this.terrainMat);
    this.land.add(this.terrain);

    // Striped sun.
    this.sunMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uBass: { value: 0 }, uPal: this.pal.uniform },
      transparent: true, depthWrite: false,
      vertexShader: QUAD_VERT,
      fragmentShader: COLOR_GLSL + /* glsl */`
        uniform float uTime, uBass;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv - 0.5;
          float r = length(p);
          vec3 col = mix(uPal[3], uPal[2], smoothstep(-0.26, 0.3, p.y)) * (1.0 + uBass * 0.25);
          float disc = smoothstep(0.265, 0.26, r);
          // Horizontal gaps in the lower half, scrolling down.
          float stripes = step(0.0, p.y) + step(0.5, fract(p.y * 14.0 - uTime * 0.6)) * step(p.y, 0.0) * smoothstep(-0.32, 0.0, p.y) + step(p.y, -0.265);
          float glow = exp(-max(0.0, r - 0.25) * 16.0) * (0.22 + uBass * 0.3) * smoothstep(0.5, 0.36, r);
          float a = max(disc * min(1.0, stripes), glow * (1.0 - disc));
          gl_FragColor = vec4(toLinear(col), a);
          #include <colorspace_fragment>
        }`,
    });
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.17), this.sunMat);
    this.sun.position.set(0, 0.004, -0.125);
    this.sun.renderOrder = -1;
    this.group.add(this.sun);

    // Sky gradient behind everything.
    const sky = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.3),
      new THREE.ShaderMaterial({
        uniforms: { uPal: this.pal.uniform },
        vertexShader: QUAD_VERT,
        fragmentShader: COLOR_GLSL + /* glsl */`
          varying vec2 vUv;
          void main() {
            vec3 c = mix(uPal[4] * 0.9 + uPal[3] * 0.15, vec3(0.02, 0.01, 0.06), smoothstep(0.35, 0.85, vUv.y));
            gl_FragColor = vec4(toLinear(c), 1.0);
            #include <colorspace_fragment>
          }`,
        depthWrite: false,
      }),
    );
    sky.position.z = -0.13;
    sky.renderOrder = -2;
    this.group.add(sky);

    // Stars.
    const NS = 700;
    const sp = new Float32Array(NS * 3), ph = new Float32Array(NS);
    for (let i = 0; i < NS; i++) {
      sp.set([rand(-0.2, 0.2), rand(-0.005, 0.1), rand(-0.128, -0.11)], i * 3);
      ph[i] = Math.random() * 6.283;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    sg.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 1000 }, uTime: { value: 0 }, uTreble: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: POINT_SIZE_GLSL + /* glsl */`
        uniform float uTime, uTreble; attribute float phase; varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          vA = 0.3 + 0.7 * (0.5 + 0.5 * sin(uTime * 3.0 + phase * 7.0)) * (0.4 + uTreble * 1.8);
          gl_PointSize = max(1.5, pointPx(0.001, mv));
        }`,
      fragmentShader: COLOR_GLSL + /* glsl */`
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(toLinear(vec3(1.0, 0.9, 1.0) * vA * smoothstep(0.5, 0.0, d)), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.renderOrder = -1;
    this.group.add(this.stars);

    // Waveform laser: a thin ribbon over the road, between the glass and the sun.
    const lp = new Float32Array(LASER * 2 * 3);
    const idx = [];
    for (let i = 0; i < LASER - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    lg.setIndex(idx);
    this.laserMat = new THREE.ShaderMaterial({
      uniforms: { uPal: this.pal.uniform, uLevel: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: 'varying float vX; void main(){ vX = position.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: COLOR_GLSL + /* glsl */`
        uniform float uLevel;
        varying float vX;
        void main() {
          float fade = smoothstep(0.1, 0.06, abs(vX));
          gl_FragColor = vec4(toLinear(uPal[1] * (1.1 + uLevel * 1.2) * fade), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.laser = new THREE.Mesh(lg, this.laserMat);
    this.laser.frustumCulled = false;
    this.land.add(this.laser);

    // Neon wireframe shapes launched down the road on the beat.
    this.shapes = [new THREE.OctahedronGeometry(1), new THREE.TetrahedronGeometry(1.2), new THREE.TorusGeometry(0.9, 0.12, 6, 24)]
      .map((geo) => {
        const f = new Flyers(THREE, geo, new THREE.MeshBasicMaterial({ wireframe: true }), 24);
        f.drag = 0.15;
        this.land.add(f.mesh);
        return f;
      });
    this.group.add(this.land);
  }

  setPalette(rgbs) { this.pal.set(rgbs); }
  setVariation(i) { this.layout.to(LAYOUTS[i % LAYOUTS.length]); }

  _launch(a) {
    const f = this.shapes[Math.floor(Math.random() * this.shapes.length)];
    this.pal.color(Math.random() < 0.5 ? 0 : 1, this.c).multiplyScalar(1.8);
    f.spawn(rand(-0.035, 0.035), rand(-0.022, 0.004), -0.115, rand(-0.01, 0.01), rand(0, 0.006), rand(0.11, 0.15) * (1 + a.level * 0.4),
      { life: 2.2, size: rand(0.004, 0.0075), color: this.c, spin: 1.6 });
  }

  update(a, dt) {
    this.pal.update(dt);
    const half = SX / 2;
    resample(a.bandsL, half + 1, this.curL);
    resample(a.bandsR, half + 1, this.curR);

    const L = this.layout.update(dt, 0.7);
    this.land.rotation.x = L.rx;
    this.land.position.y = L.py;
    const speed = (1 + a.level * 2.5) * L.speed;
    this.acc += dt * speed;
    while (this.acc >= ROW_DT) {
      this.acc -= ROW_DT;
      this.hist.unshift(this.hist.pop());
      this.hist[0].set(this.curL, 0);
      this.hist[0].set(this.curR, half + 1);
      this.rows = (this.rows + 1) % 2;
    }
    const frac = this.acc / ROW_DT;

    const p = this.terrain.geometry.attributes.position;
    const arr = p.array, base = this.base;
    for (let iz = 0; iz <= SZ; iz++) {
      // Row 0 of the plane is the far edge: the newest history is born at the horizon and
      // rolls toward you.
      const row = this.hist[iz];
      for (let ix = 0; ix <= SX; ix++) {
        const k = (iz * (SX + 1) + ix) * 3;
        const side = Math.abs(ix - half) / half;           // 0 at the road, 1 at the edge
        const bi = Math.round((1 - side) * half);           // bass at the outer edges
        const band = ix < half ? row[bi] : row[half + 1 + bi];
        const valley = Math.max(0, side - L.road) / (1 - L.road);   // a flat road down the middle
        arr[k + 1] = base[k + 1] + (band || 0) * 0.055 * L.height * valley ** (1.4 / Math.sqrt(L.height));
        arr[k + 2] = base[k + 2] + frac * (DEPTH / SZ);
      }
    }
    p.needsUpdate = true;
    this.terrainMat.uniforms.uScroll.value = this.rows % 2;
    this.terrainMat.uniforms.uFlash.value = a.beat;

    this.sunMat.uniforms.uTime.value = a.time;
    this.sunMat.uniforms.uBass.value = a.bass;
    this.sun.scale.setScalar(1 + a.bass * 0.12 + a.beat * 0.04);
    this.starMat.uniforms.uTime.value = a.time;
    this.starMat.uniforms.uTreble.value = a.treble;

    const lp = this.laser.geometry.attributes.position.array;
    const w = 0.0007 + a.level * 0.0006;
    for (let i = 0; i < LASER; i++) {
      const x = -0.1 + 0.2 * i / (LASER - 1);
      const y = -0.014 + a.wave[Math.floor(i / LASER * a.wave.length)] * 0.014;
      lp.set([x, y - w, 0.008, x, y + w, 0.008], i * 6);
    }
    this.laser.geometry.attributes.position.needsUpdate = true;
    this.laserMat.uniforms.uLevel.value = a.level;

    // A shape on every beat, and now and then in quiet passages.
    this.launch += dt;
    if (a.beat > 0.95 || this.launch > 2.5) { this._launch(a); this.launch = 0; }
    for (const f of this.shapes) f.update(dt, 1);
  }

  beforeRender(vpH) { this.starMat.uniforms.uViewportH.value = vpH; }

  dispose() { disposeTree(this.group); }
}
