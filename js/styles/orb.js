// Liquid Orb: an iridescent sphere of liquid chrome sitting in the glass, rippling with the bass
// and shivering with the highs. It reflects a soft studio and shifts colour with viewing angle,
// so each eye sees slightly different colours. Around it, a tilted ring of spectrum bars
// carries the left channel on the left and the right channel on the right, with the bass at the
// back framing the orb and the treble at the front, where the ring comes out of the screen. A
// halo of light traces the live waveform, each beat throws sparks off the surface toward you, and
// small chrome satellites orbit the orb, passing out in front of the glass and back behind it.
//
// Variations:
//   Ring       the ring tilted back like a turntable platter
//   Sunburst   the ring turned to face you, its bars shooting straight out of the screen
//   Gyro       the tilted ring precesses around the orb, its front edge sweeping toward you

import { NOISE_GLSL, COLOR_GLSL, POINT_SIZE_GLSL, Palette, Blend, resample, rand, disposeTree } from './common.js';

const LAYOUTS = [
  { rx: 0.38, ringY: -0.02, ringZ: -0.008, orbZ: -0.008, gyro: 0 },  // Ring
  { rx: 1.5708, ringY: 0, ringZ: -0.022, orbZ: -0.006, gyro: 0 },    // Sunburst
  { rx: 0.95, ringY: 0, ringZ: -0.01, orbZ: 0.0, gyro: 1 },          // Gyro
];

// Satellites: orbit radius, tilt of the orbit, speed, size.
const SATELLITES = [
  [0.048, 0.35, 0.55, 0.0042],
  [0.056, -0.5, -0.4, 0.0032],
  [0.044, 1.2, 0.75, 0.0026],
  [0.06, -1.0, 0.3, 0.0036],
];

const BARS = 80;
const RING_R = 0.05;
const HALO = 256;
const SPARKS = 700;

export default class OrbStyle {
  static meta = {
    id: 'orb',
    name: 'Liquid Orb',
    blurb: 'Iridescent liquid chrome in a stereo ring of bars, throwing sparks on the beat.',
  };
  static bloom = { strength: 0.4, radius: 0.3, threshold: 0.88 };
  static palette = ['#7a5cff', '#22d3ee', '#a3ff7a', '#ff5fae', '#ffd36b'];
  static variations = ['Ring', 'Sunburst', 'Gyro'];
  static drift = { yaw: 0.1, pitch: 0.06 };

  constructor(THREE) {
    this.T = THREE;
    this.group = new THREE.Group();
    this.pal = new Palette(THREE, OrbStyle.palette);
    this.L = new Float32Array(32);
    this.R = new Float32Array(32);
    this.hue = 0;
    this.layout = new Blend(LAYOUTS[0]);
    this.gyroYaw = 0;
    this.satT = 0;

    this.orbMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uBass: { value: 0 }, uTreble: { value: 0 }, uBeat: { value: 0 },
        uHue: { value: 0 }, uAmp: { value: 1 }, uPal: this.pal.uniform,
      },
      vertexShader: NOISE_GLSL + /* glsl */`
        uniform float uTime, uBass, uTreble, uBeat, uAmp;
        varying vec3 vWorld;
        varying vec3 vNormal;
        float disp(vec3 n) {
          float big = snoise(n * 1.6 + vec3(0.0, uTime * 0.35, 0.0));
          float fine = snoise(n * 6.0 + vec3(uTime * 0.9));
          return uAmp * (big * (0.0025 + uBass * 0.006 + uBeat * 0.003) + fine * (0.0004 + uTreble * 0.0018));
        }
        vec3 surf(vec3 n, float r) { return n * (r + disp(n)); }
        void main() {
          float r = length(position);
          vec3 n = position / r;
          // Smooth normal from the displaced surface at two nearby points.
          vec3 t1 = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
          vec3 t2 = cross(n, t1);
          vec3 p0 = surf(n, r);
          vec3 p1 = surf(normalize(n + t1 * 0.02), r);
          vec3 p2 = surf(normalize(n + t2 * 0.02), r);
          vec3 nn = normalize(cross(p1 - p0, p2 - p0));
          if (dot(nn, n) < 0.0) nn = -nn;
          vec4 w = modelMatrix * vec4(p0, 1.0);
          vWorld = w.xyz;
          vNormal = normalize(mat3(modelMatrix) * nn);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: COLOR_GLSL + /* glsl */`
        uniform float uHue, uBass;
        varying vec3 vWorld;
        varying vec3 vNormal;
        // A soft studio: a dim gradient dome with two long light boxes and a warm floor bounce.
        vec3 env(vec3 d) {
          vec3 c = mix(uPal[0] * 0.05, vec3(0.32, 0.35, 0.45), smoothstep(-0.3, 1.0, d.y));
          c += vec3(1.3) * smoothstep(0.86, 0.95, d.y) * smoothstep(0.6, 0.2, abs(d.x));
          c += uPal[1] * 0.9 * smoothstep(0.75, 0.9, -d.x) * smoothstep(0.5, 0.1, abs(d.y));
          c += uPal[3] * 0.5 * smoothstep(-0.4, -0.9, d.y);
          return c;
        }
        void main() {
          vec3 N = normalize(vNormal);
          vec3 V = normalize(cameraPosition - vWorld);
          vec3 R = reflect(-V, N);
          float ndv = clamp(dot(N, V), 0.0, 1.0);
          float fres = 0.08 + 0.92 * pow(1.0 - ndv, 4.0);
          // Thin-film iridescence: the tint slides through the palette with viewing angle.
          vec3 film = palette(uHue + ndv * 0.55);
          vec3 col = env(R) * mix(film * 0.9, vec3(1.0), fres) + film * 0.06;
          vec3 H = normalize(normalize(vec3(-0.4, 0.8, 0.5)) + V);
          col += vec3(1.8) * pow(max(dot(N, H), 0.0), 220.0);
          col += film * uBass * 0.15;
          gl_FragColor = vec4(toLinear(col), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 56), this.orbMat);
    this.orb.position.z = -0.008;
    this.group.add(this.orb);

    // Ring of bars.
    this.ring = new THREE.Group();
    this.ring.position.set(0, -0.02, -0.008);
    this.ring.rotation.order = 'YXZ';   // tilt the ring, then turn it about the vertical (Gyro)
    this.ring.rotation.x = 0.38;   // tilt the top back, so the front of the ring comes out at you
    this.group.add(this.ring);
    const bar = new THREE.BoxGeometry(0.0022, 1, 0.0022);
    bar.translate(0, 0.5, 0);
    this.bars = new THREE.InstancedMesh(bar, new THREE.MeshBasicMaterial({ color: '#ffffff' }), BARS);
    this.ring.add(this.bars);
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.c = new THREE.Color();
    this.up = new THREE.Vector3(0, 1, 0);
    this.v = new THREE.Vector3();
    this.s = new THREE.Vector3();
    this.disc = new THREE.Mesh(
      new THREE.RingGeometry(RING_R - 0.006, RING_R + 0.004, 128),
      new THREE.MeshBasicMaterial({ color: '#1d1640', side: THREE.DoubleSide }),
    );
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.position.y = -0.0005;
    this.ring.add(this.disc);

    // Waveform halo: beads of light around the orb, facing you.
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(HALO * 3), 3));
    this.haloMat = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 1000 }, uLevel: { value: 0 }, uPal: this.pal.uniform },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: POINT_SIZE_GLSL + /* glsl */`
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.5, pointPx(0.0013, mv));
        }`,
      fragmentShader: COLOR_GLSL + /* glsl */`
        uniform float uLevel;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(toLinear(uPal[1] * (0.85 + uLevel * 0.9)) * smoothstep(0.5, 0.1, d), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.halo = new THREE.Points(hg, this.haloMat);
    this.halo.position.z = -0.008;
    this.halo.frustumCulled = false;
    this.group.add(this.halo);

    // Beat sparks.
    this.sp = new Float32Array(SPARKS * 3);
    this.sv = new Float32Array(SPARKS * 3);
    this.life = new Float32Array(SPARKS);
    this.next = 0;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.sp, 3));
    sg.setAttribute('life', new THREE.BufferAttribute(this.life, 1));
    this.sparkMat = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 1000 }, uPal: this.pal.uniform },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: POINT_SIZE_GLSL + /* glsl */`
        attribute float life;
        varying float vLife;
        void main() {
          vLife = life;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = life > 0.0 ? max(1.0, pointPx(0.0012 * (0.4 + life), mv)) : 0.0;
        }`,
      fragmentShader: COLOR_GLSL + /* glsl */`
        varying float vLife;
        void main() {
          if (vLife <= 0.0) discard;
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(toLinear(mix(uPal[3], uPal[4], vLife) * 1.4 * vLife) * smoothstep(0.5, 0.0, d), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.sparks = new THREE.Points(sg, this.sparkMat);
    this.sparks.frustumCulled = false;
    this.group.add(this.sparks);

    // Chrome satellites: the orb's own material at a fraction of the ripple, sharing its uniforms.
    const satMat = new THREE.ShaderMaterial({
      uniforms: { ...this.orbMat.uniforms, uAmp: { value: 0.12 } },
      vertexShader: this.orbMat.vertexShader,
      fragmentShader: this.orbMat.fragmentShader,
    });
    this.sats = SATELLITES.map(([r, tilt, speed, size], i) => {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 12), satMat);
      m.userData = { r, tilt, speed, phase: i * 1.7 };
      this.group.add(m);
      return m;
    });
  }

  setPalette(rgbs) { this.pal.set(rgbs); }
  setVariation(i) { this.layout.to(LAYOUTS[i % LAYOUTS.length]); }

  update(a, dt) {
    const T = this.T;
    this.pal.update(dt);
    resample(a.bandsL, 32, this.L);
    resample(a.bandsR, 32, this.R);
    const u = this.orbMat.uniforms;
    u.uTime.value = a.time;
    u.uBass.value = a.bass;
    u.uTreble.value = a.treble;
    u.uBeat.value = a.beat;
    this.hue = (this.hue + dt * 0.02 + a.beat * 0.01) % 1;
    u.uHue.value = this.hue + a.centroid * 0.3;
    this.orb.scale.setScalar(1 + a.beat * 0.05 + a.bass * 0.05);
    this.orb.rotation.y += dt * (0.2 + a.mid * 0.8);

    const Lt = this.layout.update(dt, 0.7);
    if (Lt.gyro > 0.01) this.gyroYaw += dt * (0.35 + a.level * 0.5) * Lt.gyro;
    else this.gyroYaw += (Math.round(this.gyroYaw / (Math.PI * 2)) * Math.PI * 2 - this.gyroYaw) * (1 - Math.exp(-dt * 1.0));
    this.ring.rotation.x = Lt.rx;
    this.ring.rotation.y = this.gyroYaw + Math.sin(a.time * 0.12) * 0.25 * (1 - Lt.gyro);
    this.ring.position.set(0, Lt.ringY, Lt.ringZ);
    this.orb.position.z = Lt.orbZ;
    this.halo.position.z = Lt.orbZ;

    // Satellites on tilted circular orbits around the orb: in front of the glass at the near
    // side of each orbit, behind the orb at the far side.
    this.satT += dt * (0.6 + a.level * 0.8);
    for (const s of this.sats) {
      const { r, tilt, speed, phase } = s.userData;
      const ang = this.satT * speed + phase;
      const x = Math.cos(ang) * r, z0 = Math.sin(ang) * r;
      s.position.set(x, Math.sin(tilt) * z0 * 0.6, Lt.orbZ + Math.cos(tilt * 0.5) * z0 * 0.72);
      s.scale.setScalar(1 + a.bass * 0.35 + a.beat * 0.2);
    }
    for (let i = 0; i < BARS; i++) {
      const ang = (i / BARS) * Math.PI * 2;
      const x = Math.cos(ang) * RING_R, z = Math.sin(ang) * RING_R;
      // Bass at the back, framing the orb; treble at the front, where the ring comes out at you.
      // Left channel on the left, right channel on the right.
      const f = 1 - Math.abs(Math.atan2(x, z)) / Math.PI;
      const k = Math.min(31, Math.floor(f * 32));
      const v = x < 0 ? this.L[k] : this.R[k];
      this.q.setFromAxisAngle(this.up, -ang);
      this.m.compose(this.v.set(x, 0, z), this.q, this.s.set(1, 0.003 + Math.min(1, v * 1.3) * (0.03 + 0.03 * f), 1));
      this.bars.setMatrixAt(i, this.m);
      this.pal.color(Math.floor(f * 4.99), this.c).lerp(this.pal.color((Math.floor(f * 4.99) + 1) % 5, new T.Color()), (f * 4.99) % 1);
      this.bars.setColorAt(i, this.c.multiplyScalar(0.45 + v * 1.1));
    }
    this.bars.instanceMatrix.needsUpdate = true;
    this.bars.instanceColor.needsUpdate = true;

    const hp = this.halo.geometry.attributes.position.array;
    for (let i = 0; i < HALO; i++) {
      const ang = i / HALO * Math.PI * 2;
      const r = 0.041 + a.wave[Math.floor(i / HALO * a.wave.length)] * 0.007;
      hp[i * 3] = Math.cos(ang) * r; hp[i * 3 + 1] = Math.sin(ang) * r; hp[i * 3 + 2] = 0;
    }
    this.halo.geometry.attributes.position.needsUpdate = true;
    this.haloMat.uniforms.uLevel.value = a.level;

    // Sparks: burst on a beat, fly out (biased toward you), slow down and fade.
    if (a.beat > 0.95) {
      const n = 40 + Math.floor(a.bass * 80);
      for (let j = 0; j < n; j++) {
        const i = this.next = (this.next + 1) % SPARKS;
        const th = Math.random() * Math.PI * 2, ph = Math.acos(rand(-0.2, 1));
        const dx = Math.sin(ph) * Math.cos(th), dy = Math.sin(ph) * Math.sin(th), dz = Math.cos(ph);
        this.sp.set([dx * 0.032, dy * 0.032, this.orb.position.z + dz * 0.032], i * 3);
        const sp = rand(0.03, 0.08) * (0.6 + a.bass);
        this.sv.set([dx * sp, dy * sp, dz * sp], i * 3);
        this.life[i] = 1;
      }
    }
    const drag = Math.exp(-dt * 2.2);
    for (let i = 0; i < SPARKS; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt / 1.3;
      for (let k = 0; k < 3; k++) { this.sp[i * 3 + k] += this.sv[i * 3 + k] * dt; this.sv[i * 3 + k] *= drag; }
      this.sp[i * 3 + 2] = Math.min(this.sp[i * 3 + 2], 0.045);   // keep them within comfortable pop-out
    }
    this.sparks.geometry.attributes.position.needsUpdate = true;
    this.sparks.geometry.attributes.life.needsUpdate = true;
  }

  beforeRender(vpH) {
    this.haloMat.uniforms.uViewportH.value = vpH;
    this.sparkMat.uniforms.uViewportH.value = vpH;
  }

  dispose() { disposeTree(this.group); }
}
