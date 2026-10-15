// Kaleidoscope: a mandala of faceted glass shards in layers of depth. The small inner rings sit
// out in front of the glass and the wide outer rings recede behind it, so you look into a cone of
// mirrored colour. Every ring has the same n-fold mirror symmetry, the rings counter-rotate, the
// inner ones carry the bass and the outer ones the treble, and on each beat a symmetric burst of
// gems flies out toward you.
//
// Interaction: move the pointer around the centre and the kaleidoscope turns with it, like
// twisting the tube. Tap a gem to shatter it. Tap the centre jewel or empty space to change the
// symmetry (6, 8, 12, 5, then back).
//
// Variations:
//   Mandala  flat rings facing you
//   Bloom    the shards tip toward you like opening petals
//   Vortex   the rings twist into a spiral that winds back into the screen

import { COLOR_GLSL, NOISE_GLSL, QUAD_VERT, Palette, Blend, Flyers, resample, rand, disposeTree } from './common.js';

const LAYERS = 8;
const MAX_FOLD = 12;
const PER = MAX_FOLD * 2;           // mirrored pairs per layer
const FOLDS = [6, 8, 12, 5];

const LAYOUTS = [
  { spread: 1, tilt: 0, spiral: 0, depth: 1 },       // Mandala
  { spread: 0.92, tilt: 0.95, spiral: 0, depth: 0.75 }, // Bloom
  { spread: 1.08, tilt: 0.3, spiral: 1, depth: 1.35 },  // Vortex
];

export default class KaleidoscopeStyle {
  static meta = {
    id: 'kaleidoscope',
    name: 'Kaleidoscope',
    blurb: 'Layers of mirrored glass in depth. Turn it with the pointer, tap to change the symmetry.',
  };
  static bloom = { strength: 0.6, radius: 0.45, threshold: 0.6 };
  static palette = ['#ff3d7f', '#ffb000', '#2de2e6', '#7a5cff', '#9dff6b'];
  static variations = ['Mandala', 'Bloom', 'Vortex'];
  static drift = { yaw: 0.07, pitch: 0.05 };

  constructor(THREE) {
    this.T = THREE;
    this.group = new THREE.Group();
    this.pal = new Palette(THREE, KaleidoscopeStyle.palette);
    this.layout = new Blend(LAYOUTS[0]);
    this.bands = new Float32Array(LAYERS);
    this.foldIndex = 0;
    this.fold = FOLDS[0];
    this.foldMix = 1;           // 0 → 1 as a new symmetry grows in
    this.rot = new Float32Array(LAYERS);
    this.twist = 0; this.twistTarget = 0;
    this.hueShift = 0;
    this.flash = 0;
    this.t = 0;
    this.c = new THREE.Color();
    this.c2 = new THREE.Color();
    this.obj = new THREE.Object3D();
    this.obj.rotation.order = 'ZYX';

    // Shards: faceted glass, shaded by facet and rim so the symmetry reads in depth.
    const shardMat = new THREE.ShaderMaterial({
      uniforms: { uFlash: { value: 0 } },
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vV; varying vec3 vC;
        void main() {
          vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
          vV = normalize(cameraPosition - w.xyz);
          vC = instanceColor;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: COLOR_GLSL + /* glsl */`
        uniform float uFlash;
        varying vec3 vN; varying vec3 vV; varying vec3 vC;
        void main() {
          vec3 n = normalize(vN);
          float facet = 0.45 + 0.55 * abs(dot(n, normalize(vec3(-0.4, 0.7, 0.6))));
          float rim = pow(1.0 - abs(dot(n, normalize(vV))), 3.0);
          float spec = pow(max(0.0, dot(reflect(-normalize(vV), n), normalize(vec3(0.3, 0.6, 0.75)))), 30.0);
          vec3 c = vC * facet + vC * rim * 0.8 + vec3(spec) * 0.9 + vC * uFlash;
          gl_FragColor = vec4(toLinear(c), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.shardMat = shardMat;
    const shard = new THREE.OctahedronGeometry(1, 0);
    shard.scale(0.42, 1, 0.14);     // a long, faceted shard along y
    this.shards = new THREE.InstancedMesh(shard, shardMat, LAYERS * PER);
    this.shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shards.frustumCulled = false;
    for (let i = 0; i < LAYERS * PER; i++) this.shards.setColorAt(i, this.c.setRGB(0, 0, 0));
    this.group.add(this.shards);

    // The jewel at the centre, out in front of the glass.
    this.jewel = new THREE.Mesh(new THREE.IcosahedronGeometry(0.0065, 0), shardMat.clone());
    this.jewel.material.vertexShader = shardMat.vertexShader.replace('instanceMatrix * ', '').replace('mat3(instanceMatrix) * ', '').replace('vC = instanceColor;', 'vC = vec3(0.6, 0.8, 1.0);');
    this.jewel.position.z = 0.016;
    this.group.add(this.jewel);

    // Background: the same n-fold mirror applied to drifting noise, far behind the glass.
    this.backMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uFold: { value: this.fold }, uRot: { value: 0 }, uLevel: { value: 0 }, uPal: this.pal.uniform },
      depthWrite: false,
      vertexShader: QUAD_VERT,
      fragmentShader: NOISE_GLSL + COLOR_GLSL + /* glsl */`
        uniform float uTime, uFold, uRot, uLevel;
        varying vec2 vUv;
        void main() {
          vec2 p = (vUv - 0.5) * vec2(1.75, 1.0);
          float r = length(p), a = atan(p.y, p.x) + uRot;
          float seg = 6.2832 / uFold;
          a = abs(mod(a, seg) - seg * 0.5);                  // mirror within each segment
          vec2 q = vec2(cos(a), sin(a)) * r;
          float n = snoise(vec3(q * 5.0, uTime * 0.08)) * 0.5 + 0.5;
          vec3 c = palette(n * 0.8 + r * 0.6 + uTime * 0.02) * (0.12 + n * n * 0.45) * (1.0 + uLevel * 0.8);
          c *= smoothstep(0.75, 0.1, r);
          gl_FragColor = vec4(toLinear(c), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.24), this.backMat);
    back.position.z = -0.13;
    back.renderOrder = -2;
    this.group.add(back);

    // Gems thrown out on the beat, in a symmetric burst. Tappable.
    this.gems = new Flyers(THREE, new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial(), 96);
    this.gems.drag = 0.7;
    this.group.add(this.gems.mesh);
  }

  setPalette(rgbs) { this.pal.set(rgbs); }
  setVariation(i) { this.layout.to(LAYOUTS[i % LAYOUTS.length]); }

  update(a, dt) {
    this.pal.update(dt);
    const L = this.layout.update(dt, 0.8);
    this.t += dt;
    resample(a.bands, LAYERS, this.bands);
    this.foldMix = Math.min(1, this.foldMix + dt * 1.8);
    this.flash *= Math.exp(-dt * 3);
    this.hueShift += dt * (0.01 + a.level * 0.03);
    this.twist += (this.twistTarget - this.twist) * (1 - Math.exp(-dt * 3));
    this.shardMat.uniforms.uFlash.value = this.flash * 0.8 + a.beat * 0.15;

    const F = this.fold;
    let n = 0;
    for (let l = 0; l < LAYERS; l++) {
      const dir = l % 2 ? -1 : 1;
      this.rot[l] += dt * dir * (0.08 + a.level * 0.35 + l * 0.01);
      const band = this.bands[l];
      const r = (0.01 + l * 0.0078) * L.spread * (1 + a.bass * 0.06 * (1 - l / LAYERS));
      const z0 = 0.012 - l * 0.016 * L.depth;
      const len = (0.0075 + l * 0.0021) * (0.6 + band * 0.9) * Math.sqrt(this.foldMix);
      const spread = Math.PI / F * 0.42;    // half-angle between a mirrored pair
      this.pal.color(Math.floor((l / LAYERS * 5 + this.hueShift * 5) % 5), this.c)
        .lerp(this.pal.color(Math.floor((l / LAYERS * 5 + this.hueShift * 5 + 1) % 5), this.c2), (l / LAYERS * 5 + this.hueShift * 5) % 1);
      const bright = 0.35 + band * 1.1 + this.flash * 0.6;
      for (let f = 0; f < MAX_FOLD; f++) {
        for (let m = 0; m < 2; m++, n++) {
          if (f >= F) { this.obj.scale.setScalar(0); this.obj.updateMatrix(); this.shards.setMatrixAt(n, this.obj.matrix); continue; }
          const th = (f / F) * Math.PI * 2 + this.rot[l] + this.twist * (1 - l / LAYERS) + (m ? spread : -spread);
          const z = z0 + L.spiral * 0.012 * Math.sin(th * 2 + this.t * 0.6 + l);
          this.obj.position.set(Math.cos(th) * r, Math.sin(th) * r, z);
          // Point the shard outward; Bloom tips its outer end toward you.
          this.obj.rotation.set(0, 0, th - Math.PI / 2);
          this.obj.rotateX(-L.tilt * (0.4 + l / LAYERS * 0.6));
          this.obj.rotateY(m ? 0.35 : -0.35);
          this.obj.scale.set(len, len, len);
          this.obj.translateY(len * 0.5);
          this.obj.updateMatrix();
          this.shards.setMatrixAt(n, this.obj.matrix);
          this.shards.setColorAt(n, this.c2.copy(this.c).multiplyScalar(bright * (m ? 1 : 0.85)));
        }
      }
    }
    this.shards.instanceMatrix.needsUpdate = true;
    this.shards.instanceColor.needsUpdate = true;

    this.jewel.rotation.set(this.t * 0.5, this.t * 0.7, 0);
    this.jewel.scale.setScalar(1 + a.bass * 0.35 + a.beat * 0.2 + this.flash * 0.4);
    this.jewel.material.uniforms.uFlash.value = 0.05 + a.bass * 0.25 + this.flash * 0.5;

    this.backMat.uniforms.uTime.value = this.t;
    this.backMat.uniforms.uFold.value = F;
    this.backMat.uniforms.uRot.value = this.rot[LAYERS - 1] * 0.5 + this.twist;
    this.backMat.uniforms.uLevel.value = a.level;

    if (a.beat > 0.95) this.throwGems(0.8 + a.bass * 0.8);
    this.gems.update(dt, 1.5);
  }

  /** A symmetric burst of gems from the centre, out and toward you. */
  throwGems(k) {
    const F = this.fold, base = this.rot[0] + this.twist;
    const col = this.pal.color(Math.floor(rand(0, 5)), new this.T.Color()).multiplyScalar(1.6);
    for (let f = 0; f < F; f++) {
      const th = (f / F) * Math.PI * 2 + base;
      const sp = 0.05 * k;
      this.gems.spawn(Math.cos(th) * 0.006, Math.sin(th) * 0.006, 0.01, Math.cos(th) * sp, Math.sin(th) * sp * 0.75, 0.03 * k,
        { life: 2.2, size: 0.0026 + 0.001 * k, color: col, spin: 3 });
    }
  }

  nextFold() {
    this.foldIndex = (this.foldIndex + 1) % FOLDS.length;
    this.fold = FOLDS[this.foldIndex];
    this.foldMix = 0;
    this.flash = 1;
  }

  // ---- interaction ----

  get targets() { return [this.gems]; }
  get cursorTargets() { return [this.jewel]; }

  popped() { this.flash = Math.max(this.flash, 0.6); }

  tap(ray, fx) {
    this.nextFold();
    this.throwGems(1.4);
    const p = this.jewel.getWorldPosition(new this.T.Vector3());
    fx.ring(p, this.pal.color(0, new this.T.Color()), 0.06, false);
    return true;
  }

  // The pointer's angle around the centre turns the kaleidoscope, like twisting the tube.
  hover(ray) {
    const local = ray.clone().applyMatrix4(new this.T.Matrix4().copy(this.group.matrixWorld).invert());
    if (Math.abs(local.direction.z) < 1e-4) return;
    const t = -local.origin.z / local.direction.z;
    if (t <= 0) return;
    const p = local.at(t, new this.T.Vector3());
    if (Math.hypot(p.x, p.y) < 0.008) return;
    const ang = Math.atan2(p.y, p.x);
    // Unwrap so the twist follows the pointer continuously round and round.
    let d = ang - ((this.twistTarget % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.twistTarget += d * 0.5;
  }

  dispose() { disposeTree(this.group); }
}
