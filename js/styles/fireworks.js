// Fireworks: a fireworks show in depth. Rockets climb out of the dark on the beat, some far behind
// the glass and some close, and burst into shells of sparks. The bigger the bass, the bigger the
// shell, and the closest bursts open right in front of the glass. Ring shells face you, so they
// expand toward you, and the highs make the sparks crackle and twinkle.
//
// Interaction: tap a climbing rocket to detonate it early. Tap the sky and a shell bursts where
// you tapped. Move the pointer and a trail of glitter follows it.
//
// Variations:
//   Show     peonies, rings and chrysanthemums
//   Willow   slow gold willows whose trails droop and hang
//   Finale   rapid volleys of rockets and bigger shells

import { POINT_SIZE_GLSL, COLOR_GLSL, EDGE_FADE_GLSL, Palette, Blend, Flyers, rand, disposeTree } from './common.js';

const SPARKS = 9000;
const LAYOUTS = [
  { gravity: 0.016, drag: 1.6, life: 1.6, rate: 1, size: 1, willow: 0 },     // Show
  { gravity: 0.01, drag: 2.4, life: 3.0, rate: 0.7, size: 1.15, willow: 1 }, // Willow
  { gravity: 0.018, drag: 1.4, life: 1.4, rate: 2.2, size: 1.3, willow: 0 }, // Finale
];
const SHAPES = ['peony', 'ring', 'chrysanthemum', 'double'];

export default class FireworksStyle {
  static meta = {
    id: 'fireworks',
    name: 'Fireworks',
    blurb: 'Shells burst in 3D on the beat. Tap a rocket to detonate it, or tap the sky to fire one.',
  };
  static bloom = { strength: 0.9, radius: 0.5, threshold: 0.35 };
  static palette = ['#ff4d6d', '#ffd166', '#4dd2ff', '#b388ff', '#7cff8a'];
  static variations = ['Show', 'Willow', 'Finale'];
  static drift = { yaw: 0.06, pitch: 0.025 };

  constructor(THREE) {
    this.T = THREE;
    this.group = new THREE.Group();
    this.pal = new Palette(THREE, FireworksStyle.palette);
    this.layout = new Blend(LAYOUTS[0]);
    this.clock = 0;
    this.c = new THREE.Color();
    this.gold = new THREE.Color('#ffc46b');
    this.v = new THREE.Vector3();

    // One big pool of sparks: position, velocity, life, colour; drawn as glowing points.
    this.sp = new Float32Array(SPARKS * 3);
    this.sv = new Float32Array(SPARKS * 3);
    this.life = new Float32Array(SPARKS);
    this.maxLife = new Float32Array(SPARKS).fill(1);
    this.col = new Float32Array(SPARKS * 3);
    this.kind = new Float32Array(SPARKS);    // 0 shell spark, 1 willow, 2 glitter
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.sp, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('life', new THREE.BufferAttribute(this.life, 1));
    g.setAttribute('kind', new THREE.BufferAttribute(this.kind, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 1000 }, uTime: { value: 0 }, uCrackle: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: POINT_SIZE_GLSL + EDGE_FADE_GLSL + /* glsl */`
        uniform float uTime, uCrackle;
        attribute vec3 color;
        attribute float life;
        attribute float kind;
        varying vec3 vColor;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float alive = step(0.001, life);
          // Crackle: on the highs, sparks near the end of their life flicker.
          float flick = 1.0 + uCrackle * step(life, 0.45) * (sin(uTime * 60.0 + position.x * 900.0) * 0.9);
          float fade = clamp(life * 1.6, 0.0, 1.0) * edgeFade(position);
          vColor = color * fade * max(0.0, flick);
          float size = kind > 1.5 ? 0.0011 : (kind > 0.5 ? 0.0013 : 0.0016);
          gl_PointSize = alive * max(1.0, pointPx(size * (0.4 + 0.6 * clamp(life * 2.0, 0.0, 1.0)), mv));
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
    this.sparks = new THREE.Points(g, this.mat);
    this.sparks.frustumCulled = false;
    this.group.add(this.sparks);

    // Rockets: the climbing shells, tappable. Each carries a fuse; when it runs out, it bursts.
    this.rockets = new Flyers(THREE, new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial(), 32);
    this.rockets.drag = 0.1;
    this.rockets.gravity = 0.02;
    this.fuse = new Float32Array(32);
    this.shape = new Array(32).fill('peony');
    this.group.add(this.rockets.mesh);

    // A faint city skyline far behind, so the bursts have a horizon to hang over.
    const sky = new THREE.Mesh(
      new THREE.PlaneGeometry(0.7, 0.4),
      new THREE.ShaderMaterial({
        uniforms: { uFlash: { value: 0 } },
        depthWrite: false,
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: COLOR_GLSL + /* glsl */`
          uniform float uFlash;
          varying vec2 vUv;
          float hash(float n) { return fract(sin(n * 91.7) * 4375.85); }
          void main() {
            // Skyline: blocky buildings along the bottom with lit windows.
            float x = vUv.x * 70.0;
            float b = floor(x);
            float h = 0.12 + hash(b) * 0.14 + step(0.85, hash(b + 3.1)) * 0.1;
            float city = step(vUv.y, h);
            float win = step(0.6, hash(floor(vUv.x * 420.0) * 1.3 + floor(vUv.y * 160.0) * 7.7)) * step(0.4, fract(vUv.x * 420.0)) * step(0.35, fract(vUv.y * 160.0));
            vec3 skyC = mix(vec3(0.03, 0.02, 0.08), vec3(0.0), smoothstep(0.2, 0.9, vUv.y)) + vec3(0.06, 0.03, 0.08) * uFlash;
            vec3 c = mix(skyC, vec3(0.01) + vec3(0.9, 0.7, 0.4) * win * 0.35, city);
            gl_FragColor = vec4(toLinear(c), 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    );
    sky.position.set(0, 0.06, -0.16);
    sky.renderOrder = -2;
    this.skyMat = sky.material;
    this.group.add(sky);
  }

  setPalette(rgbs) { this.pal.set(rgbs); }
  setVariation(i) { this.layout.to(LAYOUTS[i % LAYOUTS.length]); }

  _spark(x, y, z, vx, vy, vz, life, color, kind = 0) {
    const i = this.next = (this.next + 1) % SPARKS;
    const o = i * 3;
    this.sp[o] = x; this.sp[o + 1] = y; this.sp[o + 2] = z;
    this.sv[o] = vx; this.sv[o + 1] = vy; this.sv[o + 2] = vz;
    this.col[o] = color.r; this.col[o + 1] = color.g; this.col[o + 2] = color.b;
    this.life[i] = this.maxLife[i] = life;
    this.kind[i] = kind;
  }

  /** Burst a shell at (x, y, z), size 0.5..1.6. */
  explode(x, y, z, shape, scale, colorA, colorB) {
    const L = this.layout.cur;
    const willow = L.willow > 0.5;
    const speed = 0.045 * scale * L.size;
    const life = L.life * (0.85 + scale * 0.25);
    const n = Math.round((willow ? 260 : 340) * scale);
    const c = this.c;
    for (let k = 0; k < n; k++) {
      let dx, dy, dz;
      if (shape === 'ring' || (shape === 'double' && k % 2)) {
        // A ring facing you: it opens in the screen plane and its front edge swings toward you.
        const th = (k / n) * Math.PI * 2 * (shape === 'double' ? 2 : 1);
        const r = shape === 'double' ? 0.6 : 1;
        dx = Math.cos(th) * r; dy = Math.sin(th) * r * 0.9; dz = Math.sin(th * 2) * 0.12 + 0.25;
      } else {
        // An even sphere (Fibonacci), so the shell has no seams.
        const t = (k + 0.5) / n, phi = Math.acos(1 - 2 * t), th = Math.PI * (1 + Math.sqrt(5)) * k;
        dx = Math.sin(phi) * Math.cos(th); dy = Math.sin(phi) * Math.sin(th); dz = Math.cos(phi);
      }
      const jitter = shape === 'chrysanthemum' ? rand(0.7, 1.05) : rand(0.93, 1.02);
      c.copy(willow ? this.gold : (k % 3 === 0 && colorB ? colorB : colorA));
      this._spark(x, y, z, dx * speed * jitter, dy * speed * jitter, dz * speed * jitter, life * rand(0.8, 1.1), c, willow ? 1 : 0);
    }
    // A bright flash at the heart of the burst.
    c.setRGB(1, 1, 1);
    for (let k = 0; k < 24; k++) this._spark(x, y, z, rand(-1, 1) * 0.01, rand(-1, 1) * 0.01, rand(-1, 1) * 0.01, 0.25, c, 0);
    this.flash = Math.max(this.flash || 0, 0.6 * scale);
  }

  launch(scale, target = null) {
    const r = this.rockets;
    // Where it bursts: anywhere across the sky and at any depth, a few close to the glass.
    const close = Math.random() < 0.3;
    const tx = target ? target.x : rand(-0.075, 0.075);
    const ty = target ? target.y : rand(0.0, 0.04);
    const tz = target ? target.z : (close ? rand(-0.02, 0.012) : rand(-0.12, -0.03));
    const x0 = tx + rand(-0.01, 0.01), y0 = -0.07, z0 = tz - 0.01;
    const flight = target ? 0.55 : rand(0.9, 1.3);
    const i = r.spawn(x0, y0, z0, (tx - x0) / flight, (ty - y0) / flight + 0.5 * r.gravity * flight, (tz - z0) / flight,
      { life: flight + 0.4, size: 0.0013, color: this.c.setRGB(1, 0.85, 0.6).multiplyScalar(1.1), spin: 0 });
    this.fuse[i] = flight;
    this.shape[i] = SHAPES[Math.floor(Math.random() * SHAPES.length)];
    r.userScale = r.userScale || new Float32Array(32);
    r.userScale[i] = scale;
  }

  update(a, dt) {
    this.pal.update(dt);
    const L = this.layout.update(dt, 0.8);
    this.clock += dt;
    this.mat.uniforms.uTime.value += dt;
    this.mat.uniforms.uCrackle.value = Math.min(1, a.treble * 2.5);

    // Launches: on the beat (more in the Finale), and now and then in quiet passages.
    if (a.beat > 0.95) {
      const n = L.rate > 1.5 ? 2 + Math.floor(a.bass * 3) : 1;
      for (let k = 0; k < n; k++) this.launch(0.7 + a.bass * 0.9);
      this.clock = 0;
    } else if (this.clock > 1.6 / L.rate) {
      this.launch(0.6 + a.level * 0.6);
      this.clock = 0;
    }

    // Rockets: a sparkling tail as they climb; when the fuse runs out, they burst.
    const r = this.rockets;
    for (let i = 0; i < r.n; i++) {
      if (r.life[i] <= 0) continue;
      const o = i * 3;
      this.fuse[i] -= dt;
      if (Math.random() < 0.6) {
        this._spark(r.p[o], r.p[o + 1], r.p[o + 2], rand(-0.003, 0.003), rand(-0.012, -0.004), rand(-0.003, 0.003), 0.45, this.gold, 2);
      }
      if (this.fuse[i] <= 0) {
        const info = r.pop(i);
        this._shell(info, (r.userScale && r.userScale[i]) || 1, this.shape[i]);
      }
    }
    r.update(dt, 1.4);

    // Sparks.
    const drag = Math.exp(-dt * L.drag);
    const g = L.gravity;
    for (let i = 0; i < SPARKS; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const o = i * 3;
      const kd = this.kind[i] === 1 ? Math.exp(-dt * (L.drag + 1.2)) : drag;
      this.sv[o] *= kd; this.sv[o + 1] = this.sv[o + 1] * kd - g * dt * (this.kind[i] === 1 ? 1.4 : 1); this.sv[o + 2] *= kd;
      this.sp[o] += this.sv[o] * dt; this.sp[o + 1] += this.sv[o + 1] * dt; this.sp[o + 2] += this.sv[o + 2] * dt;
      if (this.sp[o + 2] > 0.05) { this.sp[o + 2] = 0.05; this.sv[o + 2] = 0; }
      if (this.life[i] < 0) this.life[i] = 0;
    }
    const geo = this.sparks.geometry.attributes;
    geo.position.needsUpdate = true;
    geo.life.needsUpdate = true;
    geo.color.needsUpdate = true;
    geo.kind.needsUpdate = true;

    this.flash = (this.flash || 0) * Math.exp(-dt * 4);
    this.skyMat.uniforms.uFlash.value = this.flash;
  }

  _shell(info, scale, shape) {
    const a = this.pal.color(Math.floor(rand(0, 5)), new this.T.Color()).multiplyScalar(1.6);
    const b = this.pal.color(Math.floor(rand(0, 5)), new this.T.Color()).multiplyScalar(1.6);
    this.explode(info.x, info.y, info.z, shape, scale, a, b);
  }

  // ---- interaction ----

  get targets() { return [this.rockets]; }

  // A tapped rocket bursts at once, bigger than it would have.
  popped(pool, i, info) { this._shell(info, 1.3, 'peony'); }

  // A tap on the sky fires a shell that bursts where you tapped, a little behind the glass.
  tap(ray, fx) {
    const local = fx.toLocal(ray, this.group);
    const zT = -0.025;
    if (Math.abs(local.direction.z) < 1e-4) return false;
    const t = (zT - local.origin.z) / local.direction.z;
    if (t <= 0) return false;
    const p = local.at(t, new this.T.Vector3());
    p.x = Math.max(-0.09, Math.min(0.09, p.x));
    p.y = Math.max(-0.035, Math.min(0.05, p.y));
    this.launch(1.2, p);
    return true;
  }

  // Glitter follows the pointer across the glass.
  hover(ray, dt) {
    this.hoverAcc = (this.hoverAcc || 0) + dt * 40;
    if (this.hoverAcc < 1) return;
    this.hoverAcc = 0;
    const inv = new this.T.Matrix4().copy(this.group.matrixWorld).invert();
    const local = ray.clone().applyMatrix4(inv);
    if (Math.abs(local.direction.z) < 1e-4) return;
    const t = (0.004 - local.origin.z) / local.direction.z;
    if (t <= 0) return;
    const p = local.at(t, this.v);
    const c = this.pal.color(Math.floor(rand(0, 5)), this.c).lerp(this.gold, 0.5).multiplyScalar(1.3);
    for (let k = 0; k < 3; k++) this._spark(p.x, p.y, p.z, rand(-0.006, 0.006), rand(-0.01, 0.002), rand(-0.004, 0.006), rand(0.4, 0.8), c, 2);
  }

  beforeRender(vpH) { this.mat.uniforms.uViewportH.value = vpH; }

  dispose() { disposeTree(this.group); }
}
