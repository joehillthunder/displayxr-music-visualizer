// Impressionist Garden: thousands of painted brushstrokes in layers of depth, like a Monet water
// garden you can look into. Strokes follow a slow flow field that the mids stir up, swell with
// the bass, catch gold light on the highs, and a ripple runs across the water on each beat,
// starting from the side of the stereo field the music leans to. Each dab is shaded as a ridge
// of thick paint, over a slowly moving painted reflection.

import { FRAME_W, FRAME_H, POINT_SIZE_GLSL, NOISE_GLSL, COLOR_GLSL, QUAD_VERT, Palette, resample, rand, disposeTree } from './common.js';

const N = 15000;
const BANDS = 48;

export default class ImpressionistStyle {
  static meta = {
    id: 'impressionist',
    name: 'Impressionist Garden',
    blurb: 'Layers of thick-paint brushstrokes that flow, swell and shimmer with the music.',
  };
  static bloom = { strength: 0.18, radius: 0.3, threshold: 0.9 };
  // Water blue, lilac, sage, rose, gold.
  static palette = ['#4f74b8', '#a99ad8', '#7fae86', '#e9a3b8', '#f1c45e'];

  constructor(THREE) {
    this.group = new THREE.Group();
    this.pal = new Palette(THREE, ImpressionistStyle.palette);
    this.bands = new Float32Array(BANDS);
    this.flow = 0;
    this.ripple = 10;
    this.rippleX = 0;

    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N * 4);    // size, band, palette slot (+ variant), phase
    for (let i = 0; i < N; i++) {
      // Layers: deep water far back, lily pads in the middle, a few strokes out in front.
      const layer = Math.random();
      const z = layer < 0.42 ? rand(-0.09, -0.05) : layer < 0.9 ? rand(-0.05, -0.006) : rand(-0.006, 0.024);
      const spread = 1.15 - z * 2.2;
      const x = rand(-0.5, 0.5) * FRAME_W * spread;
      const y = rand(-0.5, 0.5) * FRAME_H * spread;
      pos.set([x, y, z], i * 3);
      // Palette slot by layer: water/sky far, pads and blooms middle, flowers in front; gold rare.
      let slot;
      if (Math.random() < 0.06) slot = 4;
      else if (z < -0.05) slot = Math.random() < 0.75 ? 0 : 1;
      else if (z < -0.006) slot = [0, 1, 2, 2, 3][Math.floor(Math.random() * 5)];
      else slot = [2, 3, 3, 1][Math.floor(Math.random() * 4)];
      const variant = Math.random();          // lighter/darker shade of the slot colour
      const band = Math.min(BANDS - 1, Math.max(0, Math.floor(((x / (FRAME_W * spread)) + 0.5) * BANDS)));
      seed.set([rand(0.0028, 0.0055) * (1 + Math.max(0, -z) * 4.5), band, slot + variant * 0.99, Math.random() * 6.283], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uViewportH: { value: 1000 }, uTime: { value: 0 }, uFlow: { value: 0 },
        uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
        uRipple: { value: 10 }, uRippleX: { value: 0 },
        uBands: { value: this.bands }, uPal: this.pal.uniform,
      },
      vertexShader: NOISE_GLSL + POINT_SIZE_GLSL + COLOR_GLSL + /* glsl */`
        uniform float uTime, uFlow, uBass, uMid, uTreble, uRipple, uRippleX;
        uniform float uBands[${BANDS}];
        attribute vec4 seed;
        varying vec3 vColor;
        varying float vAngle;
        varying float vSeed;
        varying float vSpark;
        void main() {
          vec3 p = position;
          // Flow field: an angle from noise, drifting over time; the mids stir it harder.
          float n = snoise(vec3(p.xy * 16.0, uTime * 0.07));
          float ang = n * 3.1416 + uFlow;
          p.xy += vec2(cos(ang), sin(ang)) * (0.0015 + uMid * 0.006) * sin(uTime * 0.6 + seed.w);
          // Beat ripple: a ring spreading from where the music leans, lifting strokes toward you.
          float r = length(p.xy - vec2(uRippleX, 0.0));
          float ring = exp(-pow((r - uRipple * 0.1) * 45.0, 2.0)) * exp(-uRipple * 1.3);
          p.z += ring * 0.012;

          float band = uBands[int(seed.y)];
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float size = seed.x * (1.0 + uBass * 0.55 * step(-0.05, position.z) + band * 0.45 + ring * 0.8);
          gl_PointSize = pointPx(size, mv);

          int slot = int(floor(seed.z));
          float variant = fract(seed.z);
          vec3 c = uPal[0];
          if (slot == 1) c = uPal[1]; else if (slot == 2) c = uPal[2]; else if (slot == 3) c = uPal[3]; else if (slot == 4) c = uPal[4];
          c *= mix(0.72, 1.18, variant);
          // Aerial perspective: far strokes drift toward a pale, cool haze.
          float haze = clamp((-position.z - 0.03) * 7.0, 0.0, 0.65);
          c = mix(c, mix(uPal[0], vec3(0.92, 0.94, 1.0), 0.6), haze);
          vSpark = (slot == 4 ? 1.0 : 0.0) * (0.5 + 0.5 * sin(uTime * 7.0 + seed.w * 5.0)) * uTreble * 2.0;
          vColor = c * (0.78 + band * 0.45 + ring * 0.35);
          vAngle = ang;
          vSeed = seed.w;
        }`,
      fragmentShader: COLOR_GLSL + /* glsl */`
        varying vec3 vColor;
        varying float vAngle;
        varying float vSeed;
        varying float vSpark;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1)) + vSeed) * 43758.5); }
        void main() {
          // Rotate into the stroke's frame: x across, y along.
          vec2 q = gl_PointCoord - 0.5;
          float c = cos(vAngle), s = sin(vAngle);
          q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
          q.x *= 2.2;                                   // long and thin
          float edge = 0.45 + 0.05 * (hash(floor(q * 10.0)) - 0.5);
          float d = length(q) / edge;
          if (d > 1.0) discard;
          // Impasto: shade the dab as a ridge of paint lit from the upper left, with bristle grooves.
          float h = sqrt(1.0 - d * d);
          float grooves = 0.06 * sin(q.x * 70.0 + vSeed * 9.0);
          vec3 n = normalize(vec3(-q.x * 1.6 + grooves, -q.y * 0.6, h));
          float light = 0.62 + 0.5 * max(0.0, dot(n, normalize(vec3(-0.5, 0.6, 0.7))));
          float gloss = pow(max(0.0, dot(n, normalize(vec3(-0.3, 0.4, 1.0)))), 24.0) * 0.18;
          vec3 col = vColor * light + gloss + vec3(1.0, 0.85, 0.45) * vSpark;
          gl_FragColor = vec4(toLinear(col), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.group.add(this.points);

    // A painted reflection behind the strokes: slow-moving patches of the palette, so gaps read
    // as paint, not as a void.
    this.washMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPal: this.pal.uniform },
      vertexShader: QUAD_VERT,
      fragmentShader: NOISE_GLSL + COLOR_GLSL + /* glsl */`
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv * vec2(3.5, 2.0);
          float n = snoise(vec3(p, uTime * 0.03)) * 0.5 + snoise(vec3(p * 2.3, uTime * 0.05)) * 0.25;
          vec3 base = mix(uPal[0] * 0.55, mix(uPal[1], vec3(0.9), 0.3) * 0.8, smoothstep(0.1, 0.95, vUv.y + n * 0.3));
          base = mix(base, uPal[2] * 0.55, smoothstep(0.25, 0.6, n) * 0.5);
          gl_FragColor = vec4(toLinear(base), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const wash = new THREE.Mesh(new THREE.PlaneGeometry(FRAME_W * 2.4, FRAME_H * 2.4), this.washMat);
    wash.position.z = -0.1;
    this.group.add(wash);
  }

  setPalette(rgbs) { this.pal.set(rgbs); }

  update(a, dt) {
    const u = this.mat.uniforms;
    this.pal.update(dt);
    resample(a.bands, BANDS, this.bands);
    u.uTime.value = a.time * 2;
    this.flow += dt * (0.05 + a.mid * 0.4);
    u.uFlow.value = this.flow;
    u.uBass.value = a.bass;
    u.uMid.value = a.mid;
    u.uTreble.value = a.treble;
    if (a.beat > 0.95) { this.ripple = 0; this.rippleX = a.pan * 0.07; }
    this.ripple += dt;
    u.uRipple.value = this.ripple;
    u.uRippleX.value = this.rippleX;
    this.washMat.uniforms.uTime.value = a.time;
    this.group.rotation.y = Math.sin(a.time * 0.15) * 0.05;
  }

  beforeRender(vpH) { this.mat.uniforms.uViewportH.value = vpH; }

  dispose() { disposeTree(this.group); }
}
