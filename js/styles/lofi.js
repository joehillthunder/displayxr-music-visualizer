// Lo-Fi Room: a chunky voxel spectrogram on a table that tilts away into the screen. The newest
// row of the spectrum sits nearest you and older rows scroll back behind the glass, in a muted
// sunset palette with a low-poly moon and floating dust.

import { FRAME_W, POINT_SIZE_GLSL, resample, rand, disposeTree } from './common.js';

const COLS = 24;
const ROWS = 14;
const STEP = 0.0055;        // heights snap to this, for the stepped "pixel" feel
const ROW_DT = 1 / 11;      // seconds per history row

export default class LofiStyle {
  static meta = {
    id: 'lofi',
    name: 'Lo-Fi Room',
    blurb: 'Chunky voxel spectrogram, warm sunset palette, drifting dust.',
  };

  constructor(THREE) {
    this.T = THREE;
    this.group = new THREE.Group();
    this.hist = Array.from({ length: ROWS }, () => new Float32Array(COLS));
    this.cur = new Float32Array(COLS);
    this.acc = 0;
    this.t = 0;

    // The tilted "table": rows run from z = +0.024 (front) back to z = -0.085.
    this.table = new THREE.Group();
    this.table.rotation.x = 0.42;
    this.table.position.set(0, -0.032, -0.012);
    this.group.add(this.table);

    const pitchX = (FRAME_W * 0.92) / COLS;
    this.pitchX = pitchX;
    this.pitchZ = 0.0082;
    const box = new THREE.BoxGeometry(pitchX * 0.8, 1, this.pitchZ * 0.75);
    box.translate(0, 0.5, 0);   // grow upward from the table
    const mat = new THREE.MeshLambertMaterial({ flatShading: true });
    this.bars = new THREE.InstancedMesh(box, mat, COLS * ROWS);
    this.bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.table.add(this.bars);

    // Palette: front rows peach/pink, back rows dusty teal/violet.
    this.front = [new THREE.Color('#ffb38a'), new THREE.Color('#ff7f9f'), new THREE.Color('#ffd6a0')];
    this.back = new THREE.Color('#5b6c9a');
    this.tmpC = new THREE.Color();
    this.m = new THREE.Matrix4();

    // A thin floor slab under the bars.
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(FRAME_W * 0.98, 0.002, ROWS * this.pitchZ + 0.006),
      new THREE.MeshLambertMaterial({ color: '#2b2340' }),
    );
    floor.position.set(0, -0.001, 0.024 - (ROWS - 1) * this.pitchZ / 2);
    this.table.add(floor);

    // Low-poly moon behind the glass.
    this.moon = new THREE.Mesh(
      new THREE.CircleGeometry(0.026, 10),
      new THREE.MeshBasicMaterial({ color: '#ffe9c4' }),
    );
    this.moon.position.set(0.055, 0.026, -0.1);
    this.group.add(this.moon);
    this.moonHalo = new THREE.Mesh(
      new THREE.CircleGeometry(0.036, 10),
      new THREE.MeshBasicMaterial({ color: '#c2708a', transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.moonHalo.position.set(0.055, 0.026, -0.101);
    this.group.add(this.moonHalo);

    // Dust motes, some in front of the glass.
    const N = 260;
    const pos = new Float32Array(N * 3);
    this.dustV = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = rand(-0.12, 0.12);
      pos[i * 3 + 1] = rand(-0.07, 0.07);
      pos[i * 3 + 2] = rand(-0.08, 0.035);
      this.dustV[i] = rand(0.002, 0.007);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 1000 }, uGlow: { value: 0 } },
      vertexShader: POINT_SIZE_GLSL + /* glsl */`
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.5, pointPx(0.0011, mv));
        }`,
      fragmentShader: /* glsl */`
        uniform float uGlow;
        void main() {
          // Square, slightly soft "pixel" dust.
          vec2 d = abs(gl_PointCoord - 0.5);
          if (max(d.x, d.y) > 0.42) discard;
          gl_FragColor = vec4(vec3(1.0, 0.86, 0.7) * (0.55 + uGlow), 1.0);
        }`,
    });
    this.dust = new THREE.Points(g, this.dustMat);
    this.group.add(this.dust);

    const hemi = new THREE.HemisphereLight('#ffd2b0', '#30264a', 1.6);
    const key = new THREE.DirectionalLight('#ffc9a3', 1.4);
    key.position.set(-0.4, 0.8, 0.6);
    this.group.add(hemi, key);
  }

  update(a, dt) {
    const T = this.T;
    this.t += dt;
    resample(a.bands, COLS, this.cur);

    // Scroll the history back one row at a fixed rate.
    this.acc += dt;
    while (this.acc >= ROW_DT) {
      this.acc -= ROW_DT;
      const last = this.hist.pop();
      this.hist.unshift(last);
    }
    this.hist[0].set(this.cur);

    let i = 0;
    for (let r = 0; r < ROWS; r++) {
      const fade = r / (ROWS - 1);
      for (let c = 0; c < COLS; c++, i++) {
        const v = this.hist[r][c];
        const h = Math.max(STEP, Math.round((0.003 + v * v * 0.05) / STEP) * STEP);
        const x = (c - (COLS - 1) / 2) * this.pitchX;
        const z = 0.024 - r * this.pitchZ;
        this.m.makeScale(1, h, 1).setPosition(x, 0, z);
        this.bars.setMatrixAt(i, this.m);
        const base = this.front[(c + r) % 3];
        this.tmpC.copy(base).lerp(this.back, Math.min(1, fade * 1.15));
        // Quantized brightness, like a limited palette.
        const lum = Math.round((0.55 + v * 0.7) * 4) / 4;
        this.tmpC.multiplyScalar(lum);
        this.bars.setColorAt(i, this.tmpC);
      }
    }
    this.bars.instanceMatrix.needsUpdate = true;
    this.bars.instanceColor.needsUpdate = true;

    // Tape wow: a slow, slightly uneven sway.
    this.group.rotation.y = Math.sin(this.t * 0.31) * 0.07 + Math.sin(this.t * 0.83) * 0.015;

    const s = 1 + a.bass * 0.18 + a.beat * 0.06;
    this.moon.scale.setScalar(s);
    this.moonHalo.scale.setScalar(s * (1 + a.beat * 0.15));

    const p = this.dust.geometry.attributes.position;
    for (let k = 0; k < p.count; k++) {
      let y = p.getY(k) + this.dustV[k] * dt * (1 + a.level * 3);
      if (y > 0.07) y = -0.07;
      p.setY(k, y);
      p.setX(k, p.getX(k) + Math.sin(this.t * 0.7 + k) * 0.0007 * dt * 60 * 0.05);
    }
    p.needsUpdate = true;
    this.dustMat.uniforms.uGlow.value = a.treble * 0.8;
  }

  beforeRender(vpH) { this.dustMat.uniforms.uViewportH.value = vpH; }

  dispose() { disposeTree(this.group); }
}
