// Cosmic Nebula: a spiral galaxy of glowing particles hanging behind the glass, tilted toward
// you. The core runs on the bass and the outer arms on the highs, so the spectrum spreads from
// the centre outward. Each beat sends a shockwave through the disc that lifts the stars out
// toward you, and a cloud of near-field dust drifts in front of the screen.

import { POINT_SIZE_GLSL, resample, rand, disposeTree } from './common.js';

const N = 9000;
const DUST = 500;
const BANDS = 32;
const R = 0.075;

export default class NebulaStyle {
  static meta = {
    id: 'nebula',
    name: 'Cosmic Nebula',
    blurb: 'A spiral galaxy whose core and arms light up across the spectrum.',
  };

  constructor(THREE) {
    this.group = new THREE.Group();
    this.bands = new Float32Array(BANDS);
    this.spin = 0;
    this.pulse = 10;

    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N * 4);   // radius, angle, height, hue offset
    for (let i = 0; i < N; i++) {
      const arm = i % 3;
      const r = (0.1 + 0.9 * Math.pow(Math.random(), 1.25)) * R;
      const twist = r / R * 5.0;
      const a = arm * 2.094 + twist + rand(-0.5, 0.5) * (1 - r / R * 0.4);
      const h = rand(-1, 1) * 0.006 * (1 - r / R) ** 2;
      seed.set([r, a, h, Math.random()], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));   // computed in the shader
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 1.5);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uViewportH: { value: 1000 },
        uSpin: { value: 0 },
        uPulse: { value: 10 },
        uHue: { value: 0.75 },
        uLevel: { value: 0 },
        uBands: { value: this.bands },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: POINT_SIZE_GLSL + /* glsl */`
        uniform float uSpin, uPulse, uHue, uLevel;
        uniform float uBands[${BANDS}];
        attribute vec4 seed;
        varying vec3 vColor;
        vec3 hsv(float h, float s, float v) {
          vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
          return v * mix(vec3(1.0), k, s);
        }
        void main() {
          float r = seed.x;
          float t = r / ${R};
          int bi = int(clamp(t * ${BANDS}.0, 0.0, ${BANDS - 1}.0));
          float band = uBands[bi];
          // Differential rotation: the inside turns faster.
          float a = seed.y + uSpin * (1.6 - t);
          // Shockwave from the centre on each beat.
          float wave = exp(-pow((t - uPulse * 0.9) * 9.0, 2.0)) * exp(-uPulse * 1.2);
          float rr = r * (1.0 + band * 0.12 + wave * 0.08);
          vec3 p = vec3(cos(a) * rr, sin(a) * rr, seed.z + wave * 0.018 + band * 0.006 * (1.0 - t));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.0, pointPx(0.0012 + 0.0008 * (1.0 - t) + band * 0.0008 + wave * 0.0015, mv));
          vec3 core = vec3(1.0, 0.86, 0.62);
          vec3 arm = hsv(uHue + seed.w * 0.18 + t * 0.15, 0.75, 1.0);
          vColor = mix(core, arm, smoothstep(0.0, 0.3, t)) * (0.1 + band * 0.45 + wave * 0.8 + uLevel * 0.1) * mix(0.04, 1.0, smoothstep(0.1, 0.55, t));
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vColor * a * a, 1.0);
        }`,
    });
    this.galaxy = new THREE.Points(g, this.mat);
    this.galaxy.frustumCulled = false;

    // Tilt the disc so you look into it, centred a little behind the glass.
    this.disc = new THREE.Group();
    this.disc.position.z = -0.035;
    this.disc.rotation.x = -1.05;
    this.disc.add(this.galaxy);
    this.group.add(this.disc);

    // Core glow.
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: { uBass: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform float uBass; varying vec2 vUv; void main(){ float d = length(vUv-0.5)*2.0; gl_FragColor = vec4(vec3(1.0,0.7,0.45)*exp(-d*d*6.0)*(0.12+uBass*0.4), 1.0); }',
    });
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.07), this.glowMat);
    this.glow.position.z = -0.035;
    this.group.add(this.glow);

    // Near-field dust drifting toward and past the viewer.
    const dp = new Float32Array(DUST * 3);
    for (let i = 0; i < DUST; i++) dp.set([rand(-0.12, 0.12), rand(-0.07, 0.07), rand(-0.1, 0.04)], i * 3);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 1000 }, uTreble: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: POINT_SIZE_GLSL + /* glsl */`
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          vA = smoothstep(0.045, 0.02, position.z) * smoothstep(-0.1, -0.06, position.z);
          gl_PointSize = max(1.0, pointPx(0.0013, mv));
        }`,
      fragmentShader: 'uniform float uTreble; varying float vA; void main(){ float d = length(gl_PointCoord-0.5); gl_FragColor = vec4(vec3(0.7,0.8,1.0)*smoothstep(0.5,0.0,d)*vA*(0.35+uTreble), 1.0); }',
    });
    this.dust = new THREE.Points(dg, this.dustMat);
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
  }

  update(a, dt) {
    resample(a.bands, BANDS, this.bands);
    this.spin += dt * (0.12 + a.level * 0.9);
    if (a.beat > 0.95) this.pulse = 0;
    this.pulse += dt;
    const u = this.mat.uniforms;
    u.uSpin.value = this.spin;
    u.uPulse.value = this.pulse;
    u.uHue.value = 0.62 + a.centroid * 0.35 + Math.sin(a.time * 0.05) * 0.08;
    u.uLevel.value = a.level;
    this.glowMat.uniforms.uBass.value = a.bass + a.beat * 0.3;
    this.dustMat.uniforms.uTreble.value = a.treble;
    this.disc.rotation.y = Math.sin(a.time * 0.07) * 0.15;

    const p = this.dust.geometry.attributes.position;
    const v = dt * (0.004 + a.level * 0.03);
    for (let k = 0; k < p.count; k++) {
      let z = p.getZ(k) + v;
      if (z > 0.045) z = -0.1;
      p.setZ(k, z);
    }
    p.needsUpdate = true;
  }

  beforeRender(vpH) {
    this.mat.uniforms.uViewportH.value = vpH;
    this.dustMat.uniforms.uViewportH.value = vpH;
  }

  dispose() { disposeTree(this.group); }
}
