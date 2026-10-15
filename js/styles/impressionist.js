// Impressionist Garden: thousands of painted brushstrokes in layers of depth, like a Monet water
// garden you can look into. Strokes follow a slow flow field that the mids stir up, swell with
// the bass, catch gold light on the highs, and a ripple runs across the water on each beat,
// starting from the side of the stereo field the music leans to. Each dab is shaded as a ridge
// of thick paint, over a slowly moving painted reflection. Petals ride the wind out of the
// painting toward you, and every beat sends a flurry of them.
//
// Variations:
//   Garden        layers of water, lily pads and blooms, straight on
//   Starry Night  the strokes wheel around slow vortices
//   Field         the painting tilts back into a meadow that runs away from you

import { FRAME_W, FRAME_H, POINT_SIZE_GLSL, NOISE_GLSL, COLOR_GLSL, QUAD_VERT, Palette, Blend, Flyers, resample, rand, disposeTree } from './common.js';

const N = 15000;
const BANDS = 48;

const LAYOUTS = [
  { rx: 0, py: 0, pz: 0, scale: 1, swirl: 0 },               // Garden
  { rx: 0, py: 0, pz: 0, scale: 1, swirl: 1 },               // Starry Night
  { rx: -0.85, py: 0.005, pz: -0.03, scale: 1.2, swirl: 0 }, // Field
];

export default class ImpressionistStyle {
  static meta = {
    id: 'impressionist',
    name: 'Impressionist Garden',
    blurb: 'Thick-paint brushstrokes in layers, with petals blowing out of the painting toward you.',
  };
  static bloom = { strength: 0.18, radius: 0.3, threshold: 0.9 };
  // Water blue, lilac, sage, rose, gold.
  static palette = ['#4f74b8', '#a99ad8', '#7fae86', '#e9a3b8', '#f1c45e'];
  static variations = ['Garden', 'Starry Night', 'Field'];
  static drift = { yaw: 0.1, pitch: 0.05 };

  constructor(THREE) {
    this.T = THREE;
    this.group = new THREE.Group();
    this.pal = new Palette(THREE, ImpressionistStyle.palette);
    this.bands = new Float32Array(BANDS);
    this.flow = 0;
    this.ripple = 10;
    this.rippleX = 0;
    this.layout = new Blend(LAYOUTS[0]);
    this.petalClock = 0;
    this.c = new THREE.Color();

    this.canvas = new THREE.Group();   // the painting itself, posed by the layout
    this.group.add(this.canvas);

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
        uRipple: { value: 10 }, uRippleX: { value: 0 }, uSwirl: { value: 0 }, uSpin: { value: 0 },
        uBands: { value: this.bands }, uPal: this.pal.uniform,
      },
      vertexShader: NOISE_GLSL + POINT_SIZE_GLSL + COLOR_GLSL + /* glsl */`
        uniform float uTime, uFlow, uBass, uMid, uTreble, uRipple, uRippleX, uSwirl, uSpin;
        uniform float uBands[${BANDS}];
        attribute vec4 seed;
        varying vec3 vColor;
        varying float vAngle;
        varying float vSeed;
        varying float vSpark;
        // Starry Night: three vortices. Each turns the strokes near it around its centre and
        // lines them up along the circle, the way the sky in the painting is brushed.
        vec2 vortex(vec2 p, vec2 c, float strength, inout float tangent, inout float weight) {
          vec2 d = p - c;
          float r2 = dot(d, d);
          float w = exp(-r2 / 0.0011) * strength;
          float a = w * (1.4 + uSpin);
          float ca = cos(a), sa = sin(a);
          d = vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y);
          float t = atan(d.y, d.x) + 1.5708;
          tangent = mix(tangent, t, clamp(w * 1.5, 0.0, 1.0));
          weight = max(weight, w);
          return c + d;
        }
        void main() {
          vec3 p = position;
          // Flow field: an angle from noise, drifting over time; the mids stir it harder.
          float n = snoise(vec3(p.xy * 16.0, uTime * 0.07));
          float ang = n * 3.1416 + uFlow;
          p.xy += vec2(cos(ang), sin(ang)) * (0.0015 + uMid * 0.006) * sin(uTime * 0.6 + seed.w);
          if (uSwirl > 0.001) {
            float tangent = ang, weight = 0.0;
            p.xy = vortex(p.xy, vec2(-0.05, 0.018), uSwirl, tangent, weight);
            p.xy = vortex(p.xy, vec2(0.048, -0.012), uSwirl * 0.9, tangent, weight);
            p.xy = vortex(p.xy, vec2(0.004, 0.04), uSwirl * 0.6, tangent, weight);
            ang = mix(ang, tangent, clamp(weight, 0.0, 1.0));
            p.z += weight * 0.012 * uSwirl;                 // the vortex centres bulge toward you
          }
          // Beat ripple: a ring spreading from where the music leans, lifting strokes toward you.
          float r = length(p.xy - vec2(uRippleX, 0.0));
          float ring = exp(-pow((r - uRipple * 0.1) * 45.0, 2.0)) * exp(-uRipple * 1.3);
          p.z += ring * 0.016;

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
    this.points.frustumCulled = false;
    this.canvas.add(this.points);

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
    const wash = new THREE.Mesh(new THREE.PlaneGeometry(FRAME_W * 2.6, FRAME_H * 2.6), this.washMat);
    wash.position.z = -0.11;
    this.group.add(wash);   // stays upright behind the painting: the sky when the Field tilts back

    // Petals: soft, lit, tumbling shapes that blow out of the painting toward you.
    const petal = new THREE.SphereGeometry(1, 12, 8);
    petal.scale(1, 0.16, 0.55);
    this.petals = new Flyers(THREE, petal, new THREE.MeshStandardMaterial({ roughness: 0.7, side: THREE.DoubleSide }), 220);
    this.petals.drag = 0.25;
    this.petals.gravity = 0.004;
    this.group.add(this.petals.mesh);
    const hemi = new THREE.HemisphereLight('#fff4e6', '#4a5a80', 2.2);
    const sun = new THREE.DirectionalLight('#fff0d8', 1.6);
    sun.position.set(-0.5, 0.8, 0.6);
    this.group.add(hemi, sun);
  }

  setPalette(rgbs) { this.pal.set(rgbs); }
  setVariation(i) { this.layout.to(LAYOUTS[i % LAYOUTS.length]); }

  _petal(x, y, z, vx, vy, vz) {
    const slot = [3, 3, 1, 4, 3][Math.floor(Math.random() * 5)];
    this.pal.color(slot, this.c).multiplyScalar(rand(0.85, 1.15));
    this.petals.spawn(x, y, z, vx, vy, vz, { life: rand(3, 4.5), size: rand(0.0035, 0.0055), color: this.c, spin: 2.2 });
  }

  update(a, dt) {
    const u = this.mat.uniforms;
    this.pal.update(dt);
    resample(a.bands, BANDS, this.bands);
    const L = this.layout.update(dt, 0.7);
    this.canvas.rotation.x = L.rx;
    this.canvas.position.set(0, L.py, L.pz);
    this.canvas.scale.setScalar(L.scale);
    u.uSwirl.value = L.swirl;
    u.uSpin.value += dt * (0.15 + a.mid * 0.6) * L.swirl;

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

    // A steady breeze of petals out of the painting, gustier with the music.
    this.petalClock += dt * (2.5 + a.level * 10);
    while (this.petalClock > 1) {
      this.petalClock -= 1;
      this._petal(rand(-0.08, 0.08), rand(-0.045, 0.045), rand(-0.07, -0.03),
        rand(-0.006, 0.006) + 0.004, rand(-0.003, 0.004), rand(0.018, 0.035));
    }
    // A flurry on each beat, from where the ripple starts.
    if (a.beat > 0.95) {
      for (let k = 0; k < 8 + a.bass * 14; k++) {
        const th = Math.random() * Math.PI * 2, sp = rand(0.01, 0.025);
        this._petal(this.rippleX + rand(-0.01, 0.01), rand(-0.01, 0.01), -0.01,
          Math.cos(th) * sp, Math.sin(th) * sp, rand(0.04, 0.07));
      }
    }
    this.petals.update(dt, 1);
  }

  // Interaction (js/interact.js): the petals riding out toward you can be tapped and swatted.
  get targets() { return [this.petals]; }

  beforeRender(vpH) { this.mat.uniforms.uViewportH.value = vpH; }

  dispose() { disposeTree(this.group); }
}
