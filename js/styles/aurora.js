// Aurora: the northern lights over a frozen ridge. Curtains of light hang at different depths,
// folding and rippling with the mids, flaring with the bass, with rays running up them on the
// highs. Their lower edge burns green and they fade up through violet. Snow drifts down in front
// of the glass, and shooting stars streak out of the sky toward you.
//
// Interaction: the curtains reach toward your pointer and brighten where it is. Tap a shooting
// star to burst it. Tap the sky to set off a magnetic storm: a wave of light runs along every
// curtain and more stars fall.
//
// Variations:
//   Curtains  draped curtains, one behind another
//   Corona    looking straight up: rays converge on a point overhead
//   Ribbons   long bands stacked in depth above the ridge, stepping toward you

import { POINT_SIZE_GLSL, COLOR_GLSL, NOISE_GLSL, EDGE_FADE_GLSL, QUAD_VERT, Palette, Blend, Flyers, resample, rand, disposeTree } from './common.js';

const RIBBONS = 6;
const BANDS = 24;
const SNOW = 700;

// Per-ribbon pose for each layout: position, Euler (order ZXY), length and height.
function poses(layout) {
  const out = {};
  for (let i = 0; i < RIBBONS; i++) {
    let p;
    if (layout === 0) {        // Curtains
      p = { px: (i % 2 ? 0.02 : -0.02) + (i - 2.5) * 0.004, py: -0.028 + (i % 3) * 0.006, pz: -0.015 - i * 0.019,
        rx: 0, ry: (i % 2 ? 0.28 : -0.22), rz: 0, sx: 0.24 + i * 0.012, sy: 0.075 + i * 0.004 };
    } else if (layout === 1) { // Corona
      const ang = (i / RIBBONS) * Math.PI * 2;
      p = { px: Math.cos(ang) * 0.012, py: Math.sin(ang) * 0.012, pz: -0.07,
        rx: 0.62, ry: 0, rz: ang - Math.PI / 2, sx: 0.055, sy: 0.07 };
    } else {                   // Ribbons
      p = { px: 0, py: 0.004 + i * 0.006, pz: -0.11 + i * 0.019,
        rx: -1.05, ry: (i % 2 ? 0.08 : -0.08), rz: 0, sx: 0.28, sy: 0.045 };
    }
    for (const k in p) out[k + i] = p[k];
  }
  return out;
}
const LAYOUTS = [poses(0), poses(1), poses(2)];

export default class AuroraStyle {
  static meta = {
    id: 'aurora',
    name: 'Aurora',
    blurb: 'Curtains of northern lights that reach toward your pointer. Tap for a magnetic storm.',
  };
  static bloom = { strength: 0.45, radius: 0.5, threshold: 0.55 };
  // Aurora green, violet, magenta, ice blue, night.
  static palette = ['#3dff9a', '#8a5cff', '#ff4fd8', '#7fd8ff', '#0a1430'];
  static variations = ['Curtains', 'Corona', 'Ribbons'];
  static drift = { yaw: 0.07, pitch: 0.03 };

  constructor(THREE) {
    this.T = THREE;
    this.group = new THREE.Group();
    this.pal = new Palette(THREE, AuroraStyle.palette);
    this.layout = new Blend(LAYOUTS[0]);
    this.bands = new Float32Array(BANDS);
    this.t = 0;
    this.storm = 0;
    this.stormT = 10;
    this.pull = 0;
    this.pointerW = new THREE.Vector3();
    this.inv = new THREE.Matrix4();
    this.c = new THREE.Color();

    // The curtains. They share every uniform except their seed and the pointer, which each one
    // gets in its own local space.
    this.shared = {
      uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
      uStorm: { value: 0 }, uStormT: { value: 10 }, uPull: { value: 0 },
      uBands: { value: this.bands }, uPal: this.pal.uniform,
    };
    const geo = new THREE.PlaneGeometry(1, 1, 160, 24);
    geo.translate(0, 0.5, 0);   // y 0 at the lower edge, 1 at the top
    this.ribbons = [];
    for (let i = 0; i < RIBBONS; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...this.shared, uSeed: { value: i * 7.3 + 1.1 }, uPointer: { value: new THREE.Vector3(9, 9, 0) } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        vertexShader: NOISE_GLSL + /* glsl */`
          uniform float uTime, uMid, uSeed, uPull;
          uniform vec3 uPointer;
          varying vec2 vUv; varying float vNear;
          void main() {
            vec3 p = position;
            float u = p.x + 0.5;
            // Folds: the curtain snakes back and forth in depth, faster with the mids.
            float fold = snoise(vec3(u * 2.6 + uSeed, uTime * (0.12 + uMid * 0.35), uSeed)) * 0.09
                       + snoise(vec3(u * 7.0, uTime * 0.3, uSeed * 2.0)) * 0.02;
            p.z += fold * (0.6 + p.y * 0.5);
            p.x += snoise(vec3(u * 3.0, p.y * 2.0, uTime * 0.2 + uSeed)) * 0.015;
            // Reach toward the pointer (given in this ribbon's local space, in its own units).
            float d = length((p.xy - uPointer.xy) * vec2(1.0, 0.6));
            vNear = exp(-d * d / 0.012) * uPull;
            p.z += vNear * 0.12;   // local units: x0.24 or so, about 3 cm toward you
            vUv = vec2(u, position.y);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: NOISE_GLSL + COLOR_GLSL + /* glsl */`
          uniform float uTime, uBass, uTreble, uStorm, uStormT, uSeed;
          uniform float uBands[${BANDS}];
          varying vec2 vUv; varying float vNear;
          void main() {
            float u = vUv.x, y = vUv.y;
            float band = uBands[int(clamp(u * ${BANDS}.0, 0.0, ${BANDS - 1}.0))];
            // A sharp, bright lower edge that fades upward.
            float edge = smoothstep(0.0, 0.05, y) * exp(-y * 2.6);
            // Rays: fine vertical striations that shimmer and climb on the highs.
            float rays = 0.55 + 0.45 * snoise(vec3(u * 90.0 + uSeed, y * 1.5 - uTime * (0.4 + uTreble * 2.0), uTime * 0.2));
            rays = pow(max(rays, 0.0), 1.6);
            // Ends of the curtain fade out, so no hard edges.
            float ends = smoothstep(0.0, 0.12, u) * smoothstep(1.0, 0.88, u);
            // Storm: a wave of light running along the curtain.
            float wave = exp(-pow((u - uStormT * 0.8) * 7.0, 2.0)) * uStorm;
            vec3 low = uPal[0], mid = uPal[1], high = uPal[2];
            vec3 col = mix(low, mid, smoothstep(0.08, 0.45, y));
            col = mix(col, high, smoothstep(0.45, 0.95, y) * 0.8);
            float b = edge * rays * ends * (0.22 + band * 0.75 + uBass * 0.25 + wave * 1.8 + vNear * 1.1);
            gl_FragColor = vec4(toLinear(col) * b, 1.0);
            #include <colorspace_fragment>
          }`,
      });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.order = 'ZXY';
      m.frustumCulled = false;
      this.ribbons.push(m);
      this.group.add(m);
    }

    // Night sky with stars, and a snowy ridge lit by the aurora.
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uGlow: { value: 0 }, uPal: this.pal.uniform },
      depthWrite: false,
      vertexShader: QUAD_VERT,
      fragmentShader: NOISE_GLSL + COLOR_GLSL + /* glsl */`
        uniform float uTime, uGlow;
        varying vec2 vUv;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5); }
        void main() {
          vec3 c = mix(uPal[4] * 0.5, vec3(0.0), smoothstep(0.2, 1.0, vUv.y));
          vec2 g = floor(vUv * vec2(520.0, 300.0));
          float s = step(0.9965, hash(g)) * (0.5 + 0.5 * sin(uTime * 2.0 + hash(g + 1.0) * 40.0));
          c += vec3(s) * 0.8;
          // The ridge: layered mountains, snow lit by the aurora's green.
          float ridge = 0.18 + snoise(vec3(vUv.x * 3.0, 0.0, 1.0)) * 0.05 + snoise(vec3(vUv.x * 11.0, 0.0, 2.0)) * 0.015;
          float m = step(vUv.y, ridge);
          vec3 snow = mix(vec3(0.02, 0.03, 0.06), uPal[0] * 0.25 + uPal[3] * 0.1, smoothstep(ridge - 0.08, ridge, vUv.y)) * (0.6 + uGlow);
          c = mix(c, snow, m);
          gl_FragColor = vec4(toLinear(c), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.36), this.skyMat);
    sky.position.z = -0.15;
    sky.renderOrder = -2;
    this.group.add(sky);

    // Snow, through the whole scene and out in front of the glass.
    const sp = new Float32Array(SNOW * 3);
    this.snowV = new Float32Array(SNOW);
    for (let i = 0; i < SNOW; i++) {
      const z = rand(-0.12, 0.045);
      const k = z > 0.012 ? 0.75 : 1;
      sp.set([rand(-0.13, 0.13) * k, rand(-0.075, 0.075) * k, z], i * 3);
      this.snowV[i] = rand(0.004, 0.01);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.snowMat = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 1000 }, uGlow: { value: 0 }, uPal: this.pal.uniform },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: POINT_SIZE_GLSL + EDGE_FADE_GLSL + /* glsl */`
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          vA = edgeFade(position);
          gl_PointSize = max(1.0, pointPx(0.0009, mv));
        }`,
      fragmentShader: COLOR_GLSL + /* glsl */`
        uniform float uGlow;
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          vec3 c = mix(vec3(0.75, 0.85, 1.0), uPal[0], 0.25) * (0.3 + uGlow * 0.4);
          gl_FragColor = vec4(toLinear(c) * vA * smoothstep(0.5, 0.15, d), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.snow = new THREE.Points(sg, this.snowMat);
    this.snow.frustumCulled = false;
    this.group.add(this.snow);

    // Shooting stars. Tappable.
    const star = new THREE.SphereGeometry(1, 10, 8);
    star.scale(1, 1, 4.5);       // streaked along their flight; Flyers keeps rotation fixed (spin 0)
    this.stars = new Flyers(THREE, star, new THREE.MeshBasicMaterial(), 40);
    this.stars.drag = 0.05;
    this.group.add(this.stars.mesh);
    this.starClock = 0;
    this.obj = new THREE.Object3D();
    this.q = new THREE.Quaternion();
    this.zf = new THREE.Vector3(0, 0, 1);
    this.dv = new THREE.Vector3();
  }

  setPalette(rgbs) { this.pal.set(rgbs); }
  setVariation(i) { this.layout.to(LAYOUTS[i % LAYOUTS.length]); }

  shootingStar(big = 1) {
    // From high in the sky, angling down and toward you.
    const x0 = rand(-0.09, 0.09), y0 = rand(0.03, 0.06), z0 = rand(-0.12, -0.06);
    const v = this.dv.set(rand(-0.6, 0.6), rand(-0.45, -0.15), rand(0.6, 1)).normalize().multiplyScalar(rand(0.07, 0.11));
    this.q.setFromUnitVectors(this.zf, v.clone().normalize());
    const e = new this.T.Euler().setFromQuaternion(this.q);
    this.stars.spawn(x0, y0, z0, v.x, v.y, v.z, {
      life: 1.8, size: 0.0011 * big, spin: 0, rot: [e.x, e.y, e.z],
      color: this.pal.color(Math.random() < 0.5 ? 3 : 0, this.c).lerp(new this.T.Color(1, 1, 1), 0.5).multiplyScalar(2.2),
    });
  }

  update(a, dt) {
    this.pal.update(dt);
    const L = this.layout.update(dt, 0.7);
    this.t += dt;
    resample(a.bands, BANDS, this.bands);
    this.storm *= Math.exp(-dt * 0.9);
    this.stormT += dt * 0.9;
    this.pull *= Math.exp(-dt * 1.2);
    if (a.beat > 0.95 && a.bass > 0.4) { this.storm = Math.max(this.storm, 0.5); this.stormT = 0; }

    const s = this.shared;
    s.uTime.value = this.t;
    s.uBass.value = a.bass;
    s.uMid.value = a.mid;
    s.uTreble.value = a.treble;
    s.uStorm.value = this.storm;
    s.uStormT.value = this.stormT;
    s.uPull.value = this.pull;

    this.group.updateMatrixWorld();
    for (let i = 0; i < RIBBONS; i++) {
      const m = this.ribbons[i];
      m.position.set(L['px' + i], L['py' + i], L['pz' + i]);
      m.rotation.set(L['rx' + i], L['ry' + i], L['rz' + i]);
      m.scale.set(L['sx' + i], L['sy' + i], L['sx' + i]);
      m.updateMatrixWorld();
      // The pointer in this ribbon's own space, for the reach.
      m.material.uniforms.uPointer.value.copy(this.pointerW).applyMatrix4(this.inv.copy(m.matrixWorld).invert());
    }

    this.skyMat.uniforms.uTime.value = this.t;
    this.skyMat.uniforms.uGlow.value = a.bass * 0.6 + this.storm;
    this.snowMat.uniforms.uGlow.value = 0.6 + a.level + this.storm;

    const p = this.snow.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) - this.snowV[i] * dt;
      if (y < -0.075) y = 0.075;
      p.setY(i, y);
      p.setX(i, p.getX(i) + Math.sin(this.t * 0.6 + i) * 0.002 * dt);
    }
    p.needsUpdate = true;

    this.starClock += dt;
    if ((a.beat > 0.95 && Math.random() < 0.5) || this.starClock > 2.2) { this.shootingStar(); this.starClock = 0; }
    this.stars.update(dt, 1.3);
  }

  // ---- interaction ----

  get targets() { return [this.stars]; }

  popped() { this.storm = Math.max(this.storm, 0.35); this.stormT = 0; }

  tap(ray, fx) {
    this.storm = 1;
    this.stormT = 0;
    for (let k = 0; k < 3; k++) this.shootingStar(1.3);
    return false;   // the glass still ripples
  }

  hover(ray) {
    // Aim at the middle depth of the curtains; each ribbon converts this into its own space.
    const local = ray.clone().applyMatrix4(this.inv.copy(this.group.matrixWorld).invert());
    if (Math.abs(local.direction.z) < 1e-4) return;
    const t = (-0.05 - local.origin.z) / local.direction.z;
    if (t <= 0) return;
    local.at(t, this.pointerW).applyMatrix4(this.group.matrixWorld);
    this.pull = 1;
  }

  beforeRender(vpH) { this.snowMat.uniforms.uViewportH.value = vpH; }

  dispose() { disposeTree(this.group); }
}
