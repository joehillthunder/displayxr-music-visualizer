// Impressionist Garden: thousands of painted brushstrokes in layers of depth, like a Monet water
// garden you can look into. Strokes follow a slow flow field that the mids stir up, swell with
// the bass, catch gold light on the highs, and a ripple runs across the water on each beat.

import { FRAME_W, FRAME_H, POINT_SIZE_GLSL, NOISE_GLSL, resample, rand, disposeTree } from './common.js';

const N = 6500;
const BANDS = 32;

export default class ImpressionistStyle {
  static meta = {
    id: 'impressionist',
    name: 'Impressionist Garden',
    blurb: 'Layered brushstrokes that flow, swell and shimmer with the music.',
  };

  constructor(THREE) {
    this.group = new THREE.Group();
    this.bands = new Float32Array(BANDS);
    this.flow = 0;
    this.ripple = 10;

    // Monet palette: water blues, lilac, sage, rose, and gold highlights.
    const palette = ['#3d5a99', '#5f84c4', '#8fb3d9', '#a18fd1', '#c7a6e0', '#6f9c7d',
      '#9cc29a', '#e8a5b8', '#f2c6c2', '#f4d58d', '#e9b949'].map((c) => new THREE.Color(c));

    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const seed = new Float32Array(N * 4);   // size, band, sparkle, phase
    for (let i = 0; i < N; i++) {
      // Layers: deep water far back, lily pads in the middle, a few strokes out in front.
      const layer = Math.random();
      const z = layer < 0.45 ? rand(-0.09, -0.05) : layer < 0.9 ? rand(-0.05, -0.005) : rand(-0.005, 0.025);
      const spread = 1.15 - z * 2;  // the far layers fill the wider view behind the glass
      const x = rand(-0.5, 0.5) * FRAME_W * spread;
      const y = rand(-0.5, 0.5) * FRAME_H * spread;
      pos.set([x, y, z], i * 3);

      let c;
      const gold = Math.random() < 0.08;
      if (gold) c = palette[9 + (Math.random() < 0.5 ? 0 : 1)];
      else if (z < -0.05) c = palette[Math.floor(rand(0, 5))];               // water and sky
      else if (z < -0.005) c = palette[Math.floor(rand(3, 9))];              // pads and blooms
      else c = palette[Math.floor(rand(5, 9))];
      const haze = Math.max(0, -z - 0.03) * 6;                                // aerial perspective
      const mute = 0.8, k2 = Math.min(0.7, haze * 0.5);
      col.set([(c.r * mute) + (0.8 - c.r * mute) * k2, (c.g * mute) + (0.82 - c.g * mute) * k2, (c.b * mute) + (0.95 - c.b * mute) * k2], i * 3);

      const band = Math.min(BANDS - 1, Math.floor(((x / (FRAME_W * spread)) + 0.5) * BANDS));
      seed.set([rand(0.0035, 0.007) * (1 + Math.max(0, -z) * 4), Math.max(0, band), gold ? 1 : 0, Math.random() * 6.283], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uViewportH: { value: 1000 },
        uTime: { value: 0 },
        uFlow: { value: 0 },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uTreble: { value: 0 },
        uRipple: { value: 10 },
        uBands: { value: this.bands },
      },
      vertexShader: NOISE_GLSL + POINT_SIZE_GLSL + /* glsl */`
        uniform float uTime, uFlow, uBass, uMid, uTreble, uRipple;
        uniform float uBands[${BANDS}];
        attribute vec3 color;
        attribute vec4 seed;
        varying vec3 vColor;
        varying float vAngle;
        varying float vSeed;
        void main() {
          vec3 p = position;
          // Flow field: an angle from noise, drifting over time; the mids stir it harder.
          float n = snoise(vec3(p.xy * 18.0, uTime * 0.08));
          float ang = n * 3.1416 + uFlow;
          float stir = 0.002 + uMid * 0.006;
          p.xy += vec2(cos(ang), sin(ang)) * stir * sin(uTime * 0.6 + seed.w);
          // Beat ripple: a ring spreading from the centre lifts strokes toward you.
          float r = length(p.xy);
          float ring = exp(-pow((r - uRipple * 0.09) * 40.0, 2.0)) * exp(-uRipple * 1.4);
          p.z += ring * 0.012;

          float band = uBands[int(seed.y)];
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float size = seed.x * (1.0 + uBass * 0.6 * step(-0.05, position.z) + band * 0.5 + ring * 0.8);
          gl_PointSize = pointPx(size, mv);

          float sparkle = seed.z * (0.5 + 0.5 * sin(uTime * 7.0 + seed.w * 5.0)) * uTreble * 1.6;
          vColor = color * (0.72 + band * 0.55 + ring * 0.4) + vec3(1.0, 0.85, 0.45) * sparkle;
          vAngle = ang;
          vSeed = seed.w;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor;
        varying float vAngle;
        varying float vSeed;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1)) + vSeed) * 43758.5); }
        void main() {
          // Rotate into the stroke's frame and draw a ragged, elongated dab.
          vec2 q = gl_PointCoord - 0.5;
          float c = cos(vAngle), s = sin(vAngle);
          q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
          q.y *= 2.1;                                  // long and thin
          float edge = 0.45 + 0.06 * (hash(floor(q * 9.0)) - 0.5);
          if (length(q) > edge) discard;
          // Bristle streaks along the stroke.
          float streak = 0.93 + 0.07 * sin(q.y * 30.0 + vSeed * 9.0);
          gl_FragColor = vec4(vColor * streak, 1.0);
        }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.group.add(this.points);

    // A soft wash behind the strokes so gaps read as paint, not as a void.
    const wash = new THREE.Mesh(
      new THREE.PlaneGeometry(FRAME_W * 2.2, FRAME_H * 2.2),
      new THREE.ShaderMaterial({
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: /* glsl */`
          varying vec2 vUv;
          void main() {
            vec3 top = vec3(0.62, 0.66, 0.86), bottom = vec3(0.20, 0.30, 0.52);
            gl_FragColor = vec4(mix(bottom, top, vUv.y), 1.0);
          }`,
      }),
    );
    wash.position.z = -0.1;
    this.group.add(wash);
  }

  update(a, dt) {
    const u = this.mat.uniforms;
    resample(a.bands, BANDS, this.bands);
    u.uTime.value = a.time * 2;
    this.flow += dt * (0.05 + a.mid * 0.4);
    u.uFlow.value = this.flow;
    u.uBass.value = a.bass;
    u.uMid.value = a.mid;
    u.uTreble.value = a.treble;
    if (a.beat > 0.95) this.ripple = 0;
    this.ripple += dt;
    u.uRipple.value = this.ripple;
    this.group.rotation.y = Math.sin(a.time * 0.15) * 0.05;
  }

  beforeRender(vpH) { this.mat.uniforms.uViewportH.value = vpH; }

  dispose() { disposeTree(this.group); }
}
