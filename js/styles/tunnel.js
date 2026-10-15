// Warp Tunnel: you are flying down a tunnel of light. Rings of spectrum bars stream out of the
// depths toward you. Each ring carries the spectrum around its rim, bass at the floor and treble
// at the ceiling, the left channel on the left wall and the right channel on the right. The far
// end of the bore swings with the mids, so the tunnel bends, and it speeds up when the music gets
// loud. Each beat sends a pulse of light racing down the rings, and launches an energy orb from
// the far end that flies down the tunnel and out of the screen at you. Tap an orb to pop it; tap
// anywhere else to kick the warp drive.
//
// Variations:
//   Straight    a straight bore, rings square to you
//   Corkscrew   the rings twist as they come and the bore snakes
//   Hyperspace  the bars stretch into streaks along the direction of travel

import { COLOR_GLSL, Palette, Blend, Flyers, resample, rand, disposeTree } from './common.js';

const LAYOUTS = [
  { twist: 0, snake: 0.6, stretch: 0 },    // Straight
  { twist: 7, snake: 1.6, stretch: 0 },    // Corkscrew
  { twist: 1.2, snake: 0.4, stretch: 1 },  // Hyperspace
];

const RINGS = 40;
const SEGS = 48;
const R = 0.074;            // tunnel radius, just wider than the window, so the rings frame it
const Z_FAR = -0.55;
const Z_NEAR = -0.004;      // rings stay behind the glass: a ring wider than the window must not pop out
const SPAN = Z_NEAR - Z_FAR;

export default class TunnelStyle {
  static meta = {
    id: 'tunnel',
    name: 'Warp Tunnel',
    blurb: 'Fly down a tunnel of spectrum rings; energy orbs race out at you.',
  };
  static bloom = { strength: 0.85, radius: 0.45, threshold: 0.55 };
  static palette = ['#3b5bff', '#00e5ff', '#b44dff', '#ff3d9a', '#ffe14d'];
  static variations = ['Straight', 'Corkscrew', 'Hyperspace'];
  static drift = { yaw: 0.05, pitch: 0.03 };

  constructor(THREE) {
    this.T = THREE;
    this.group = new THREE.Group();
    this.pal = new Palette(THREE, TunnelStyle.palette);
    this.layout = new Blend(LAYOUTS[0]);
    this.L = new Float32Array(24);
    this.Rb = new Float32Array(24);
    this.travel = 0;
    this.bend = 0;
    this.surge = 0;
    this.pulses = [];

    this.bars = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), RINGS * SEGS);
    this.bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bars.frustumCulled = false;
    this.group.add(this.bars);

    // The light at the end of the tunnel.
    this.coreMat = new THREE.ShaderMaterial({
      uniforms: { uPal: this.pal.uniform, uLevel: { value: 0 }, uBeat: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: COLOR_GLSL + /* glsl */`
        uniform float uLevel, uBeat;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float g = exp(-d * d * 6.0) * (0.5 + uLevel * 1.2 + uBeat * 0.8) + exp(-d * 18.0) * 1.5;
          gl_FragColor = vec4(toLinear(mix(uPal[1], vec3(1.0), 0.35)) * g, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.core = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), this.coreMat);
    this.core.position.z = Z_FAR - 0.02;
    this.group.add(this.core);

    this.orbs = new Flyers(THREE, new THREE.IcosahedronGeometry(1, 2), new THREE.MeshBasicMaterial(), 24);
    this.orbs.drag = 0.05;
    this.group.add(this.orbs.mesh);

    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.p = new THREE.Vector3();
    this.s = new THREE.Vector3();
    this.zAxis = new THREE.Vector3(0, 0, 1);
    this.c = new THREE.Color();
    this.c2 = new THREE.Color();
  }

  setPalette(rgbs) { this.pal.set(rgbs); }
  setVariation(i) { this.layout.to(LAYOUTS[i % LAYOUTS.length]); }

  // Where the bore's centre is at depth z: on axis at the glass, swinging further out with depth.
  centre(z, out) {
    const k = (z - Z_NEAR) / (Z_FAR - Z_NEAR);           // 0 at the glass, 1 at the far end
    const s = this.layout.cur.snake * (0.022 + this.bend * 0.02) * k * k;
    return out.set(Math.sin(this.travel * 2.1 + k * 2.4) * s, Math.cos(this.travel * 1.7 + k * 1.9) * s * 0.7, z);
  }

  update(a, dt) {
    this.pal.update(dt);
    const Lt = this.layout.update(dt, 0.8);
    resample(a.bandsL, 24, this.L);
    resample(a.bandsR, 24, this.Rb);
    this.surge *= Math.exp(-dt * 1.6);
    this.bend += (a.mid - this.bend) * (1 - Math.exp(-dt * 2));
    const speed = 0.08 + a.level * 0.22 + this.surge * 0.5;
    this.travel += speed * dt;

    // Beat pulses travel down the rings toward you, faster than the rings themselves.
    if (a.beat > 0.95) {
      this.pulses.push(Z_FAR);
      if (this.pulses.length > 5) this.pulses.shift();
      this.launch(a);
    }
    for (let i = 0; i < this.pulses.length; i++) this.pulses[i] += (speed * 3 + 0.25) * dt;
    this.pulses = this.pulses.filter((z) => z < Z_NEAR + 0.05);

    const spacing = SPAN / RINGS;
    const len0 = 0.004, stretch = Lt.stretch * (0.012 + speed * 0.12);
    let n = 0;
    for (let r = 0; r < RINGS; r++) {
      const z = Z_FAR + ((r * spacing + this.travel) % SPAN);
      this.centre(z, this.p);
      const cx = this.p.x, cy = this.p.y;
      const depthK = (z - Z_FAR) / SPAN;                                  // 0 far, 1 near
      const fog = Math.min(1, depthK * 2.2) * Math.min(1, (Z_NEAR - z) / 0.03 + 0.15);
      let pulse = 0;
      for (const pz of this.pulses) pulse += Math.exp(-(((z - pz) / 0.03) ** 2));
      const twist = Lt.twist * z;
      for (let j = 0; j < SEGS; j++) {
        const ang = (j / SEGS) * Math.PI * 2 + twist;
        const sx = Math.sin(ang), sy = -Math.cos(ang);                     // ang 0 = floor
        // Bass at the floor, treble at the ceiling; left wall = left channel.
        const u = Math.abs(((j / SEGS) * 2 + 1) % 2 - 1);                 // 0 floor .. 1 ceiling
        const k = Math.min(23, Math.floor(u * 24));
        const v = (j / SEGS) < 0.5 ? this.Rb[k] : this.L[k];
        const len = len0 + Math.min(1, v * 1.2) * 0.028;
        const rr = R - len / 2;
        this.p.set(cx + sx * rr, cy + sy * rr, z);
        this.q.setFromAxisAngle(this.zAxis, ang);
        this.s.set((Math.PI * 2 * R / SEGS) * 0.55, len, 0.0035 + stretch);
        this.m.compose(this.p, this.q, this.s);
        this.bars.setMatrixAt(n, this.m);
        const pi = u * 4.99;
        this.pal.color(Math.floor(pi), this.c).lerp(this.pal.color((Math.floor(pi) + 1) % 5, this.c2), pi % 1);
        this.bars.setColorAt(n, this.c.multiplyScalar(fog * (0.25 + v * 1.5 + pulse * 1.3 + this.surge * 0.6)));
        n++;
      }
    }
    this.bars.instanceMatrix.needsUpdate = true;
    this.bars.instanceColor.needsUpdate = true;

    this.centre(Z_FAR, this.p);
    this.core.position.set(this.p.x, this.p.y, Z_FAR - 0.02);
    this.coreMat.uniforms.uLevel.value = a.level + this.surge;
    this.coreMat.uniforms.uBeat.value = a.beat;
    this.orbs.update(dt, 1.5);
  }

  // An energy orb leaves the far end and flies down the bore, out of the glass toward you.
  launch(a) {
    const start = this.centre(Z_FAR + 0.03, new this.T.Vector3());
    const tx = rand(-0.05, 0.05), ty = rand(-0.03, 0.03), tz = rand(0.012, 0.03);
    const flight = rand(1.6, 2.4) / (0.8 + a.level);
    this.orbs.spawn(start.x, start.y, start.z, (tx - start.x) / flight, (ty - start.y) / flight, (tz - start.z) / flight, {
      life: flight + 1.4, size: rand(0.0035, 0.0055), spin: 2,
      color: this.pal.color(Math.floor(rand(0, 5)), new this.T.Color()).multiplyScalar(1.4),
    });
  }

  // Interaction (js/interact.js): pop the orbs; a tap anywhere else kicks the warp drive.
  get targets() { return [this.orbs]; }
  popped() { this.surge = Math.max(this.surge, 0.5); }
  tap() { this.surge = 1; this.pulses.push(Z_FAR); return false; }   // false: the glass still ripples

  dispose() { disposeTree(this.group); }
}
