// Neon Horizon: an 80s synthwave road trip. A neon-gridded landscape rolls toward you out of the
// screen, its mountains shaped by the spectrum history, under a striped sun that pulses with the
// bass and a sky of stars that twinkle on the highs.

import { FRAME_W, POINT_SIZE_GLSL, resample, rand, disposeTree } from './common.js';

const SX = 48;            // grid segments across
const SZ = 36;            // grid segments deep (= spectrum history rows)
const DEPTH = 0.17;       // z from +0.045 back to -0.125
const WIDTH = FRAME_W * 1.7;
const ROW_DT = 1 / 18;

export default class SynthwaveStyle {
  static meta = {
    id: 'synthwave',
    name: 'Neon Horizon',
    blurb: 'Synthwave grid terrain rolling out of the screen under a pulsing sun.',
  };

  constructor(THREE) {
    this.group = new THREE.Group();
    this.hist = Array.from({ length: SZ + 1 }, () => new Float32Array(SX / 2 + 1));
    this.cur = new Float32Array(SX / 2 + 1);
    this.acc = 0;
    this.rows = 0;

    // Terrain: a plane lying flat at y = -0.035, front edge at z = +0.03.
    const geo = new THREE.PlaneGeometry(WIDTH, DEPTH, SX, SZ);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, -0.04, 0.045 - DEPTH / 2);
    this.base = geo.attributes.position.array.slice();
    this.terrainMat = new THREE.ShaderMaterial({
      uniforms: { uScroll: { value: 0 }, uFlash: { value: 0 }, uHue: { value: 0 } },
      vertexShader: /* glsl */`
        varying vec2 vUv; varying float vH; varying float vZ;
        void main() {
          vUv = uv; vH = position.y + 0.04; vZ = position.z;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float uScroll, uFlash, uHue;
        varying vec2 vUv; varying float vH; varying float vZ;
        float gridLine(float v, float n) {
          float f = abs(fract(v * n) - 0.5);
          float w = fwidth(v * n);
          return 1.0 - smoothstep(0.0, w * 1.5, 0.5 - f);
        }
        void main() {
          float gx = gridLine(vUv.x, ${SX / 2}.0);
          // A cross line every second history row, riding with the rows as they roll forward.
          float gz = gridLine(uScroll - ${SZ}.0 * (1.0 - vUv.y), 0.5);
          float g = max(gx, gz);
          vec3 pink = vec3(1.0, 0.18, 0.75), cyan = vec3(0.1, 0.9, 1.0);
          vec3 line = mix(pink, cyan, clamp(vH * 25.0 + uHue, 0.0, 1.0));
          vec3 fill = vec3(0.06, 0.01, 0.12) + vec3(0.12, 0.0, 0.18) * vH * 20.0;
          vec3 col = mix(fill, line * (1.2 + uFlash), g);
          // Fade into the horizon haze.
          float far = smoothstep(-0.06, -0.12, vZ);
          col = mix(col, vec3(0.35, 0.05, 0.4), far * 0.85);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.terrain = new THREE.Mesh(geo, this.terrainMat);
    this.group.add(this.terrain);

    // Striped sun.
    this.sunMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uBass: { value: 0 } },
      transparent: true,
      depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: /* glsl */`
        uniform float uTime, uBass;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv - 0.5;
          float r = length(p);
          vec3 col = mix(vec3(1.0, 0.15, 0.55), vec3(1.0, 0.85, 0.25), smoothstep(-0.3, 0.35, p.y));
          float disc = smoothstep(0.265, 0.26, r);
          // Horizontal gaps in the lower half, scrolling down.
          float stripes = step(0.0, p.y) + step(0.5, fract(p.y * 14.0 - uTime * 0.6)) * step(p.y, 0.0) * smoothstep(-0.32, 0.0, p.y) + step(p.y, -0.265);
          float glow = exp(-max(0.0, r - 0.25) * 16.0) * (0.35 + uBass * 0.6);
          float a = max(disc * min(1.0, stripes), glow * (1.0 - disc) * smoothstep(0.5, 0.36, r));
          gl_FragColor = vec4(col * (1.0 + uBass * 0.4), a);
        }`,
    });
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.17), this.sunMat);
    this.sun.position.set(0, 0.006, -0.125);
    this.sun.renderOrder = -1;
    this.group.add(this.sun);

    // Sky gradient behind everything.
    const sky = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.3),
      new THREE.ShaderMaterial({
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'varying vec2 vUv; void main(){ gl_FragColor = vec4(mix(vec3(0.45,0.06,0.42), vec3(0.03,0.01,0.1), smoothstep(0.35,0.85,vUv.y)), 1.0); }',
        depthWrite: false,
      }),
    );
    sky.position.z = -0.13;
    sky.renderOrder = -2;
    this.group.add(sky);

    // Stars.
    const NS = 400;
    const sp = new Float32Array(NS * 3), ph = new Float32Array(NS);
    for (let i = 0; i < NS; i++) {
      sp.set([rand(-0.2, 0.2), rand(0.0, 0.1), rand(-0.128, -0.11)], i * 3);
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
          vA = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * 3.0 + phase * 7.0)) * (0.4 + uTreble * 1.5);
          gl_PointSize = max(1.5, pointPx(0.0012, mv));
        }`,
      fragmentShader: 'varying float vA; void main(){ float d = length(gl_PointCoord-0.5); gl_FragColor = vec4(vec3(1.0,0.9,1.0)*vA*smoothstep(0.5,0.0,d), 1.0); }',
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.renderOrder = -1;
    this.group.add(this.stars);
  }

  update(a, dt) {
    // Fold the spectrum into half a row (mirrored about the road), bass at the outer edges.
    const half = SX / 2;
    resample(a.bands, half + 1, this.cur);

    const speed = 1 + a.level * 2.5;
    this.acc += dt * speed;
    while (this.acc >= ROW_DT) {
      this.acc -= ROW_DT;
      this.hist.unshift(this.hist.pop());
      this.rows = (this.rows + 1) % 2;
      this.hist[0].set(this.cur);
    }
    const frac = this.acc / ROW_DT;

    const p = this.terrain.geometry.attributes.position;
    const arr = p.array, base = this.base;
    for (let iz = 0; iz <= SZ; iz++) {
      // Row 0 of the plane is the far edge; the newest history row is drawn at the far edge and
      // rolls toward you.
      const row = this.hist[iz];
      for (let ix = 0; ix <= SX; ix++) {
        const k = (iz * (SX + 1) + ix) * 3;
        const side = Math.abs(ix - half) / half;            // 0 at the road, 1 at the edge
        const band = row[Math.round((1 - side) * half)] || 0;
        const valley = Math.max(0, side - 0.12) / 0.88;     // a flat road down the middle
        arr[k + 1] = base[k + 1] + band * 0.05 * valley ** 1.4;
        arr[k + 2] = base[k + 2] + frac * (DEPTH / SZ);
      }
    }
    p.needsUpdate = true;
    this.terrainMat.uniforms.uScroll.value = this.rows % 2;
    this.terrainMat.uniforms.uFlash.value = a.beat * 0.8;
    this.terrainMat.uniforms.uHue.value = a.centroid - 0.4;

    this.sunMat.uniforms.uTime.value = a.time;
    this.sunMat.uniforms.uBass.value = a.bass;
    this.sun.scale.setScalar(1 + a.bass * 0.12 + a.beat * 0.04);
    this.starMat.uniforms.uTime.value = a.time;
    this.starMat.uniforms.uTreble.value = a.treble;
  }

  beforeRender(vpH) { this.starMat.uniforms.uViewportH.value = vpH; }

  dispose() { disposeTree(this.group); }
}
