// Liquid Orb: an iridescent sphere of liquid metal sitting in the glass, rippling with the bass
// and shivering with the highs, inside a tilted ring of spectrum bars whose front half comes out
// of the screen toward you.

import { NOISE_GLSL, resample, disposeTree } from './common.js';

const BARS = 72;
const RING_R = 0.05;

export default class OrbStyle {
  static meta = {
    id: 'orb',
    name: 'Liquid Orb',
    blurb: 'An iridescent liquid-metal sphere inside a ring of spectrum bars.',
  };

  constructor(THREE) {
    this.T = THREE;
    this.group = new THREE.Group();
    this.half = new Float32Array(BARS / 2);
    this.wobble = 0;

    this.orbMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
        uBeat: { value: 0 }, uHue: { value: 0 },
      },
      vertexShader: NOISE_GLSL + /* glsl */`
        uniform float uTime, uBass, uMid, uTreble, uBeat;
        varying vec3 vWorld;
        varying vec3 vNormalGuess;
        void main() {
          vec3 n = normalize(position);
          float big = snoise(n * 1.6 + vec3(0.0, uTime * 0.35, 0.0));
          float fine = snoise(n * 6.0 + vec3(uTime * 0.9));
          float d = big * (0.0025 + uBass * 0.006 + uBeat * 0.003) + fine * (0.0004 + uTreble * 0.0018);
          vec3 p = position + n * d;
          vec4 w = modelMatrix * vec4(p, 1.0);
          vWorld = w.xyz;
          vNormalGuess = normalize(mat3(modelMatrix) * n);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform float uHue, uBass;
        varying vec3 vWorld;
        varying vec3 vNormalGuess;
        vec3 hsv(float h, float s, float v) {
          vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
          return v * mix(vec3(1.0), k, s);
        }
        void main() {
          // Displaced normal from screen-space derivatives, blended with the smooth one.
          vec3 dn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
          if (dot(dn, vNormalGuess) < 0.0) dn = -dn;
          vec3 N = normalize(mix(vNormalGuess, dn, 0.4));
          vec3 V = normalize(cameraPosition - vWorld);
          float ndv = clamp(dot(N, V), 0.0, 1.0);
          float fres = pow(1.0 - ndv, 3.0);
          // Thin-film iridescence: hue shifts with viewing angle (and so between your two eyes).
          vec3 film = hsv(uHue + ndv * 0.6, 0.65, 1.0);
          vec3 L = normalize(vec3(-0.4, 0.7, 0.6));
          vec3 H = normalize(L + V);
          float spec = pow(max(dot(N, H), 0.0), 90.0);
          vec3 env = mix(vec3(0.03, 0.02, 0.08), vec3(0.35, 0.4, 0.6), N.y * 0.5 + 0.5);
          vec3 col = env * 0.6 + film * (0.18 + fres * 0.9) + vec3(spec) * 1.4;
          col += film * uBass * 0.12;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 40), this.orbMat);
    this.orb.position.z = -0.008;
    this.group.add(this.orb);

    // Ring of bars, mirrored so the spectrum reads symmetrically left and right.
    this.ring = new THREE.Group();
    this.ring.position.z = -0.008;
    this.ring.rotation.x = 0.38;   // tilt the top back, so the front of the ring comes out at you
    this.group.add(this.ring);
    const bar = new THREE.BoxGeometry(0.0026, 1, 0.0026);
    bar.translate(0, 0.5, 0);
    this.barMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    this.bars = new THREE.InstancedMesh(bar, this.barMat, BARS);
    this.ring.add(this.bars);
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.c = new THREE.Color();

    // Reflection-ish floor disc beneath the ring.
    const disc = new THREE.Mesh(
      new THREE.RingGeometry(RING_R - 0.006, RING_R + 0.004, 96),
      new THREE.MeshBasicMaterial({ color: '#2a1f55', side: THREE.DoubleSide }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.0005;
    this.ring.add(disc);
    this.ring.position.y = -0.02;
  }

  update(a, dt) {
    const T = this.T;
    resample(a.bands, BARS / 2, this.half);
    const u = this.orbMat.uniforms;
    u.uTime.value = a.time;
    u.uBass.value = a.bass;
    u.uMid.value = a.mid;
    u.uTreble.value = a.treble;
    u.uBeat.value = a.beat;
    u.uHue.value = (a.time * 0.03 + a.centroid * 0.5) % 1;
    this.orb.scale.setScalar(1 + a.beat * 0.06 + a.bass * 0.05);
    this.orb.rotation.y += dt * (0.2 + a.mid * 0.8);

    this.ring.rotation.y += dt * (0.08 + a.level * 0.35);
    const up = new T.Vector3(0, 1, 0);
    for (let i = 0; i < BARS; i++) {
      const ang = (i / BARS) * Math.PI * 2;
      const k = i < BARS / 2 ? i : BARS - 1 - i;
      const v = this.half[k];
      const h = 0.003 + v * 0.05;
      this.q.setFromAxisAngle(up, -ang);
      this.m.compose(
        new T.Vector3(Math.cos(ang) * RING_R, 0, Math.sin(ang) * RING_R),
        this.q,
        new T.Vector3(1, h, 1),
      );
      this.bars.setMatrixAt(i, this.m);
      this.c.setHSL((u.uHue.value + k / BARS * 0.8) % 1, 0.85, 0.45 + v * 0.35);
      this.bars.setColorAt(i, this.c);
    }
    this.bars.instanceMatrix.needsUpdate = true;
    this.bars.instanceColor.needsUpdate = true;
  }

  dispose() { disposeTree(this.group); }
}
