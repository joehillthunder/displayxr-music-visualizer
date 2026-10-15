// Cosmic Nebula: a spiral galaxy of glowing particles hanging behind the glass, tilted toward
// you. The core runs on the bass and the outer arms on the highs, so the spectrum spreads from
// the centre outward. Each beat sends a shockwave through the disc that lifts the stars out
// toward you. The live waveform circles the core as a ring of light, the disc leans toward the
// louder stereo channel, and near-field dust drifts past in front of the screen.

import { POINT_SIZE_GLSL, COLOR_GLSL, QUAD_VERT, Palette, resample, rand, disposeTree } from './common.js';

const N = 26000;
const DUST = 700;
const FIELD = 1600;
const RING = 256;
const BANDS = 48;
const R = 0.075;

export default class NebulaStyle {
  static meta = {
    id: 'nebula',
    name: 'Cosmic Nebula',
    blurb: 'A spiral galaxy lit across the spectrum, ringed by the live waveform.',
  };
  static bloom = { strength: 0.55, radius: 0.35, threshold: 0.6 };
  // Core, arm A, arm B, arm C, shockwave.
  static palette = ['#ffe0a8', '#ff4fb8', '#8a5cff', '#38c8ff', '#ffffff'];

  constructor(THREE) {
    this.group = new THREE.Group();
    this.pal = new Palette(THREE, NebulaStyle.palette);
    this.bands = new Float32Array(BANDS);
    this.spin = 0;
    this.pulse = 10;

    const seed = new Float32Array(N * 4);   // radius, angle, height, colour mix
    for (let i = 0; i < N; i++) {
      const arm = i % 3;
      const r = (0.06 + 0.94 * Math.pow(Math.random(), 1.2)) * R;
      const twist = r / R * 5.2;
      const a = arm * 2.094 + twist + (Math.random() + Math.random() - 1) * 0.55 * (1 - r / R * 0.35);
      const h = (Math.random() + Math.random() - 1) * 0.007 * (1 - r / R) ** 2;
      seed.set([r, a, h, arm + Math.random() * 0.99], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));   // computed in the shader
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uViewportH: { value: 1000 }, uSpin: { value: 0 }, uPulse: { value: 10 },
        uLevel: { value: 0 }, uBands: { value: this.bands }, uPal: this.pal.uniform,
      },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: POINT_SIZE_GLSL + COLOR_GLSL + /* glsl */`
        uniform float uSpin, uPulse, uLevel;
        uniform float uBands[${BANDS}];
        attribute vec4 seed;
        varying vec3 vColor;
        void main() {
          float r = seed.x;
          float t = r / ${R};
          float band = uBands[int(clamp(t * ${BANDS}.0, 0.0, ${BANDS - 1}.0))];
          float a = seed.y + uSpin * (1.6 - t);                  // the inside turns faster
          float wave = exp(-pow((t - uPulse * 0.9) * 9.0, 2.0)) * exp(-uPulse * 1.2);
          float rr = r * (1.0 + band * 0.1 + wave * 0.08);
          vec3 p = vec3(cos(a) * rr, sin(a) * rr, seed.z + wave * 0.018 + band * 0.006 * (1.0 - t));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.0, pointPx(0.0009 + 0.0006 * (1.0 - t) + band * 0.0007 + wave * 0.0012, mv));
          int arm = int(floor(seed.w));
          vec3 armC = arm == 0 ? uPal[1] : (arm == 1 ? uPal[2] : uPal[3]);
          armC = mix(armC, uPal[(arm + 1) % 3 + 1], fract(seed.w) * 0.4);
          vec3 c = mix(uPal[0], armC, smoothstep(0.05, 0.35, t));
          c = mix(c, uPal[4], wave * 0.6);
          vColor = c * (0.18 + band * 0.75 + wave * 0.9 + uLevel * 0.15) * mix(0.05, 1.0, smoothstep(0.1, 0.55, t));
        }`,
      fragmentShader: COLOR_GLSL + /* glsl */`
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(toLinear(vColor) * a * a, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.galaxy = new THREE.Points(g, this.mat);
    this.galaxy.frustumCulled = false;

    // Waveform ring around the core, in the plane of the disc.
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RING * 3), 3));
    this.ringMat = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 1000 }, uPal: this.pal.uniform, uLevel: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: POINT_SIZE_GLSL + /* glsl */`
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.5, pointPx(0.0014, mv));
        }`,
      fragmentShader: COLOR_GLSL + /* glsl */`
        uniform float uLevel;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(toLinear(mix(uPal[0], uPal[4], 0.5) * (0.5 + uLevel * 0.7)) * smoothstep(0.5, 0.1, d), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.ring = new THREE.Points(rg, this.ringMat);
    this.ring.frustumCulled = false;

    // Tilt the disc so you look into it, centred a little behind the glass.
    this.disc = new THREE.Group();
    this.disc.position.z = -0.035;
    this.disc.rotation.x = -1.05;
    this.disc.add(this.galaxy, this.ring);
    this.group.add(this.disc);

    // Core glow.
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: { uBass: { value: 0 }, uPal: this.pal.uniform },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: QUAD_VERT,
      fragmentShader: COLOR_GLSL + /* glsl */`
        uniform float uBass;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          gl_FragColor = vec4(toLinear(uPal[0] * exp(-d * d * 8.0) * (0.16 + uBass * 0.3)), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.07), this.glowMat);
    this.glow.position.z = -0.035;
    this.group.add(this.glow);

    // Distant star field behind the galaxy.
    const fp = new Float32Array(FIELD * 3);
    for (let i = 0; i < FIELD; i++) fp.set([rand(-0.22, 0.22), rand(-0.13, 0.13), rand(-0.12, -0.1)], i * 3);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(fp, 3));
    this.fieldMat = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 1000 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: POINT_SIZE_GLSL + 'varying float vB; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; vB = fract(sin(dot(position.xy, vec2(91.7, 37.3))) * 4375.85); gl_PointSize = max(1.0, pointPx(0.0007, mv)); }',
      fragmentShader: COLOR_GLSL + /* glsl */`
        varying float vB;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(toLinear(vec3(0.75, 0.82, 1.0) * (0.2 + vB * vB * 0.6)) * smoothstep(0.5, 0.0, d), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.group.add(new THREE.Points(fg, this.fieldMat));

    // Near-field dust drifting toward and past the viewer.
    const dp = new Float32Array(DUST * 3);
    for (let i = 0; i < DUST; i++) dp.set([rand(-0.12, 0.12), rand(-0.07, 0.07), rand(-0.1, 0.04)], i * 3);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 1000 }, uTreble: { value: 0 }, uPal: this.pal.uniform },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: POINT_SIZE_GLSL + /* glsl */`
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          vA = smoothstep(0.045, 0.02, position.z) * smoothstep(-0.1, -0.06, position.z);
          gl_PointSize = max(1.0, pointPx(0.0011, mv));
        }`,
      fragmentShader: COLOR_GLSL + /* glsl */`
        uniform float uTreble;
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(toLinear(mix(uPal[3], vec3(1.0), 0.5) * vA * (0.3 + uTreble)) * smoothstep(0.5, 0.0, d), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.dust = new THREE.Points(dg, this.dustMat);
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
  }

  setPalette(rgbs) { this.pal.set(rgbs); }

  update(a, dt) {
    this.pal.update(dt);
    resample(a.bands, BANDS, this.bands);
    this.spin += dt * (0.12 + a.level * 0.9);
    if (a.beat > 0.95) this.pulse = 0;
    this.pulse += dt;
    const u = this.mat.uniforms;
    u.uSpin.value = this.spin;
    u.uPulse.value = this.pulse;
    u.uLevel.value = a.level;
    this.glowMat.uniforms.uBass.value = a.bass + a.beat * 0.3;
    this.dustMat.uniforms.uTreble.value = a.treble;
    this.ringMat.uniforms.uLevel.value = a.level;
    this.disc.rotation.y = Math.sin(a.time * 0.07) * 0.12 + a.pan * 0.25;

    const rp = this.ring.geometry.attributes.position.array;
    const w = a.wave;
    for (let i = 0; i < RING; i++) {
      const ang = i / RING * Math.PI * 2 + this.spin * 1.5;
      const r = 0.011 + w[Math.floor(i / RING * w.length)] * 0.006 + a.bass * 0.003;
      rp[i * 3] = Math.cos(ang) * r; rp[i * 3 + 1] = Math.sin(ang) * r; rp[i * 3 + 2] = 0.001;
    }
    this.ring.geometry.attributes.position.needsUpdate = true;

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
    this.ringMat.uniforms.uViewportH.value = vpH;
    this.fieldMat.uniforms.uViewportH.value = vpH;
  }

  dispose() { disposeTree(this.group); }
}
